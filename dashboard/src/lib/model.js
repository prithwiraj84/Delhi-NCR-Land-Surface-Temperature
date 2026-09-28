/**
 * In-browser evaluator for the compact XGBoost surrogate (`model_web.json`, SPEC §4.3).
 *
 * Semantics (identical to XGBoost): at an internal node go left if x < t, right if x >= t,
 * and follow the default direction (`d == 1` -> left) when x is missing (null/undefined/NaN).
 * Prediction (target units) = base_score + Σ leaf values.
 *
 * Engineering
 * - Compilation re-lays every tree out breadth-first so the two children of a node are
 *   adjacent (right = left + 1). A step is then branch-free:
 *       node = child[node] + ((x >= thr[node]) | (isNaN(x) & missingRight[node]))
 * - Leaves become self-loops (child = self, thr = NaN, missingRight = 0): comparisons with a
 *   NaN threshold are always false, so a finished row simply stays on its leaf. That lets
 *   every tree run a FIXED number of steps (its depth) with no leaf test at all.
 * - Batches are evaluated tree-major with four rows interleaved, so four independent
 *   load->compare->load chains overlap in the CPU pipeline. Together this is ~4x faster
 *   than a naive recursive/branchy walk (55k rows x 400 depth-6 trees in a few hundred ms).
 * - Inputs are packed into a Float32Array: XGBoost casts features to float32 before
 *   comparing with float32 thresholds, so values within 1 ulp of a threshold route exactly
 *   as in Python.
 */

export const MODEL_FORMAT = "lst-xgb-compact-v1";

/** Rows evaluated together per tree (interleaving factor). */
const INTERLEAVE = 4;

function assertArray(tree, key, t) {
  const arr = tree?.[key];
  if (!Array.isArray(arr) && !ArrayBuffer.isView(arr)) {
    throw new Error(`model_web.json: tree ${t} is missing array "${key}"`);
  }
  return arr;
}

/** Validate one tree's arrays and return its node count. */
function validateTree(tree, t, nFeatures) {
  const f = assertArray(tree, "f", t);
  const l = assertArray(tree, "l", t);
  const r = assertArray(tree, "r", t);
  const len = f.length;
  for (const key of ["t", "l", "r", "d", "v"]) {
    if (assertArray(tree, key, t).length !== len) {
      throw new Error(`model_web.json: tree ${t} array "${key}" length differs from "f" (${len})`);
    }
  }
  if (len === 0) throw new Error(`model_web.json: tree ${t} has no nodes`);
  for (let i = 0; i < len; i += 1) {
    if (l[i] === -1) continue;
    // Children must point forward: guarantees a finite tree (no cycles) and valid indices.
    if (!(l[i] > i && l[i] < len && r[i] > i && r[i] < len && l[i] !== r[i])) {
      throw new Error(`model_web.json: tree ${t} node ${i} has invalid children (${l[i]}, ${r[i]})`);
    }
    if (!(f[i] >= 0 && f[i] < nFeatures)) {
      throw new Error(`model_web.json: tree ${t} node ${i} splits on unknown feature index ${f[i]}`);
    }
  }
  return len;
}

/**
 * Flatten all trees breadth-first into shared typed arrays (children adjacent, leaves
 * self-looping). Returns the arrays plus per-tree root offset, depth and feature set.
 */
function flattenTrees(trees, nFeatures) {
  const sizes = trees.map((tree, t) => validateTree(tree, t, nFeatures));
  const total = sizes.reduce((a, b) => a + b, 0);
  const feat = new Int32Array(total);
  const thr = new Float32Array(total);
  const child = new Int32Array(total);
  const missingRight = new Int32Array(total);
  const value = new Float64Array(total);
  const roots = new Int32Array(trees.length);
  const depths = new Int32Array(trees.length);
  const featureSets = new Array(trees.length);

  let offset = 0;
  trees.forEach((tree, t) => {
    roots[t] = offset;
    const used = new Set();
    // BFS queue of [original node id, new absolute slot, depth].
    const queue = [[0, offset, 0]];
    let next = offset + 1;
    let maxDepth = 0;
    for (let q = 0; q < queue.length; q += 1) {
      const [i, k, depth] = queue[q];
      if (tree.l[i] === -1) {
        feat[k] = 0;
        thr[k] = NaN;
        child[k] = k;
        missingRight[k] = 0;
        value[k] = Number(tree.v[i]) || 0;
        maxDepth = Math.max(maxDepth, depth);
        continue;
      }
      feat[k] = tree.f[i];
      thr[k] = Number(tree.t[i]);
      child[k] = next;
      missingRight[k] = tree.d[i] === 1 || tree.d[i] === true ? 0 : 1;
      used.add(tree.f[i]);
      queue.push([tree.l[i], next, depth + 1], [tree.r[i], next + 1, depth + 1]);
      next += 2;
      if (next - offset > sizes[t]) throw new Error(`model_web.json: tree ${t} has nodes with several parents`);
    }
    if (next - offset !== sizes[t]) {
      throw new Error(`model_web.json: tree ${t} has unreachable or shared nodes`);
    }
    depths[t] = maxDepth;
    featureSets[t] = used;
    offset = next;
  });
  return { feat, thr, child, missingRight, value, roots, depths, featureSets };
}

/**
 * Compile `model_web.json` into a fast predictor.
 * @param {object} modelJson parsed model_web.json
 * @returns {{
 *   features: string[], baseScore: number, nTrees: number, targetMode: string,
 *   predictRow: (values: ArrayLike<number|null|undefined>) => number,
 *   predictMany: (getValue: (featureIdx: number, i: number) => number|null, indices: Int32Array|number[]) => Float64Array,
 *   predictTrees: (getValue: Function, indices: ArrayLike<number>, treeIds: ArrayLike<number>) => Float64Array,
 *   treesUsingFeatures: (featureIdxs: Iterable<number>) => Int32Array,
 *   fidelity: object|null,
 * }}
 */
export function compileModel(modelJson) {
  if (!modelJson || typeof modelJson !== "object") throw new Error("compileModel: model JSON is missing");
  if (modelJson.format && modelJson.format !== MODEL_FORMAT) {
    throw new Error(`compileModel: unsupported format "${modelJson.format}" (expected "${MODEL_FORMAT}")`);
  }
  const features = Array.isArray(modelJson.features) ? modelJson.features.slice() : null;
  if (!features?.length) throw new Error("compileModel: model has no feature list");
  if (!Array.isArray(modelJson.trees)) throw new Error("compileModel: model has no trees array");

  const K = features.length;
  const baseScore = Number(modelJson.base_score) || 0;
  const { feat, thr, child, missingRight, value, roots, depths, featureSets } = flattenTrees(modelJson.trees, K);
  const nTrees = roots.length;
  const allTrees = Int32Array.from({ length: nTrees }, (_, t) => t);

  /** Pack rows (row-major, float32, missing -> NaN) from a getter over `indices`. */
  function packRows(getValue, indices) {
    const m = indices.length;
    const packed = new Float32Array(m * K);
    for (let j = 0; j < m; j += 1) {
      const i = indices[j];
      const base = j * K;
      for (let f = 0; f < K; f += 1) {
        const v = getValue(f, i);
        packed[base + f] = v === null || v === undefined ? NaN : v;
      }
    }
    return packed;
  }

  /** Σ leaf values of `treeIds` for each of the `m` packed rows (tree-major, 4-way interleaved). */
  function evaluatePacked(packed, m, treeIds) {
    const out = new Float64Array(m);
    const tail = m - (m % INTERLEAVE);
    for (let q = 0; q < treeIds.length; q += 1) {
      const t = treeIds[q];
      const root = roots[t];
      const depth = depths[t];
      let j = 0;
      for (; j < tail; j += INTERLEAVE) {
        const b0 = j * K;
        const b1 = b0 + K;
        const b2 = b1 + K;
        const b3 = b2 + K;
        let n0 = root;
        let n1 = root;
        let n2 = root;
        let n3 = root;
        for (let d = 0; d < depth; d += 1) {
          const x0 = packed[b0 + feat[n0]];
          const x1 = packed[b1 + feat[n1]];
          const x2 = packed[b2 + feat[n2]];
          const x3 = packed[b3 + feat[n3]];
          n0 = child[n0] + ((x0 >= thr[n0]) | ((x0 !== x0) & missingRight[n0]));
          n1 = child[n1] + ((x1 >= thr[n1]) | ((x1 !== x1) & missingRight[n1]));
          n2 = child[n2] + ((x2 >= thr[n2]) | ((x2 !== x2) & missingRight[n2]));
          n3 = child[n3] + ((x3 >= thr[n3]) | ((x3 !== x3) & missingRight[n3]));
        }
        out[j] += value[n0];
        out[j + 1] += value[n1];
        out[j + 2] += value[n2];
        out[j + 3] += value[n3];
      }
      for (; j < m; j += 1) {
        const b = j * K;
        let node = root;
        for (let d = 0; d < depth; d += 1) {
          const x = packed[b + feat[node]];
          node = child[node] + ((x >= thr[node]) | ((x !== x) & missingRight[node]));
        }
        out[j] += value[node];
      }
    }
    return out;
  }

  function predictRow(values) {
    if (!values || typeof values.length !== "number") throw new TypeError("predictRow: expected an array-like row");
    const packed = packRows((f) => (f < values.length ? values[f] : null), [0]);
    return baseScore + evaluatePacked(packed, 1, allTrees)[0];
  }

  function predictTrees(getValue, indices, treeIds) {
    if (typeof getValue !== "function") throw new TypeError("predictTrees: getValue must be a function");
    const packed = packRows(getValue, indices);
    return evaluatePacked(packed, indices.length, treeIds);
  }

  function predictMany(getValue, indices) {
    const out = predictTrees(getValue, indices, allTrees);
    for (let j = 0; j < out.length; j += 1) out[j] += baseScore;
    return out;
  }

  /** Ids of trees that split on at least one of `featureIdxs` (all other trees ignore them). */
  function treesUsingFeatures(featureIdxs) {
    const wanted = [...featureIdxs];
    const ids = [];
    for (let t = 0; t < nTrees; t += 1) {
      if (wanted.some((f) => featureSets[t].has(f))) ids.push(t);
    }
    return Int32Array.from(ids);
  }

  return {
    features,
    baseScore,
    nTrees,
    nNodes: feat.length,
    maxDepth: depths.reduce((a, b) => Math.max(a, b), 0),
    targetMode: modelJson.target_mode ?? "anomaly",
    objective: modelJson.objective ?? "reg:squarederror",
    fidelity: modelJson.fidelity ?? null,
    predictRow,
    predictMany,
    predictTrees,
    treesUsingFeatures,
  };
}

/**
 * Convert a model prediction (target units) to °C.
 * Anomaly mode adds the epoch's spatial mean; absolute mode is already in °C.
 */
export function predictionToCelsius(prediction, targetMode, epochMean) {
  if (targetMode === "absolute") return prediction;
  return prediction + (Number.isFinite(epochMean) ? epochMean : 0);
}

/**
 * Compare the compiled evaluator against the Python-embedded check rows.
 * @returns {{n: number, maxAbsDiff: number, failures: number}}
 */
export function checkModelAgainstPython(compiled, modelJson, tolerance = 1e-4) {
  const rows = modelJson?.check?.rows ?? [];
  const expected = modelJson?.check?.expected ?? [];
  let maxAbsDiff = 0;
  let failures = 0;
  const n = Math.min(rows.length, expected.length);
  for (let i = 0; i < n; i += 1) {
    const diff = Math.abs(compiled.predictRow(rows[i]) - Number(expected[i]));
    if (!(diff < tolerance)) failures += 1;
    maxAbsDiff = Number.isNaN(diff) ? Infinity : Math.max(maxAbsDiff, diff);
  }
  return { n, maxAbsDiff, failures };
}
