/**
 * Shared helpers for the lib tests: fixture loading, a fetch stub backed by the file system,
 * and a deterministic random tree-ensemble generator for evaluator / performance tests.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(here, "fixtures");
/**
 * The real exported bundle, present only after running the notebook. Defaults to
 * dashboard/public/data; set LST_BUNDLE_DIR to check any other web bundle (e.g. a fresh
 * `outputs/web/` before copying it) without touching the served directory:
 *   LST_BUNDLE_DIR=../outputs/web npm test
 */
export const PUBLIC_DATA_DIR = process.env.LST_BUNDLE_DIR
  ? path.resolve(process.env.LST_BUNDLE_DIR)
  : path.resolve(here, "../../../public/data");

/** Parse JSON from raw file bytes, inflating gzip (magic bytes 0x1f 0x8b) like the dashboard loader. */
export function parseJsonBytes(buffer) {
  const gzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const bytes = gzip ? zlib.gunzipSync(buffer) : buffer;
  return JSON.parse(bytes.toString("utf8"));
}

/** Read a bundle JSON file; `.json.gz` (or any gzip-compressed file) is inflated with node zlib. */
export function readJson(dir, name) {
  return parseJsonBytes(fs.readFileSync(path.join(dir, name)));
}

export const fixture = (name) => readJson(FIXTURE_DIR, name);

/** Gzip-compressed bytes of a fixture file (level 9, like 05_export). */
export const gzippedFixture = (name) => zlib.gzipSync(fs.readFileSync(path.join(FIXTURE_DIR, name)), { level: 9 });

export function publicDataExists(name) {
  return fs.existsSync(path.join(PUBLIC_DATA_DIR, name));
}

/**
 * File name of a manifest-declared bundle file that exists on disk in `dir`, accepting both
 * the declared name and its plain/.gz sibling (so a test works before and after D3).
 */
export function existingBundleFile(dir, declared) {
  if (!declared) return null;
  const candidates = [declared, declared.endsWith(".gz") ? declared.slice(0, -3) : `${declared}.gz`];
  return candidates.find((name) => fs.existsSync(path.join(dir, name))) ?? null;
}

const toBytes = (body) =>
  typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(0);

/** Minimal Response-like object for the fetch stub (string or byte body). */
function response(status, body, contentType = "application/json") {
  const bytes = toBytes(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status === 200 ? "OK" : "Error",
    headers: { get: (key) => (key.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/**
 * fetch() stub serving files from `dir` for URLs under `/data/`.
 * `overrides` maps a file name to {status, body (string | Uint8Array), contentType} or to an
 * Error (network failure). Files are served as raw bytes (a `.gz` file arrives compressed).
 */
export function createFsFetch(dir, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const name = decodeURIComponent(String(url).replace(/^.*\/data\//, ""));
    const override = overrides[name];
    if (override instanceof Error) throw override;
    if (override) return response(override.status, override.body ?? "", override.contentType);
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return response(404, "Not Found", "text/plain");
    const type = name.endsWith(".gz") ? "application/gzip" : "application/json";
    return response(200, new Uint8Array(fs.readFileSync(file)), type);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One random tree in model_web.json layout. Nodes are numbered depth-first (children after
 * parents, right subtree after the whole left subtree - NOT adjacent, like XGBoost dumps),
 * and each internal node below the root becomes a leaf early with probability `leafProb`.
 */
function randomTree(rand, { depth, pool, leafProb }) {
  const tree = { f: [], t: [], l: [], r: [], d: [], v: [] };
  const grow = (level) => {
    const id = tree.f.length;
    const isLeaf = level === depth || (level > 0 && rand() < leafProb);
    tree.f.push(isLeaf ? -1 : pool[Math.floor(rand() * pool.length)]);
    tree.t.push(isLeaf ? 0 : Math.fround(rand()));
    tree.l.push(-1);
    tree.r.push(-1);
    tree.d.push(isLeaf ? 0 : rand() < 0.5 ? 1 : 0);
    tree.v.push(isLeaf ? Math.round((rand() - 0.5) * 2000) / 10000 : 0);
    if (!isLeaf) {
      tree.l[id] = grow(level + 1);
      tree.r[id] = grow(level + 1);
    }
    return id;
  };
  grow(0);
  return tree;
}

/**
 * Random tree ensemble in model_web.json layout.
 * `featurePool` restricts which feature indices trees may split on; `leafProb` > 0 makes
 * irregular (unbalanced) trees.
 */
export function randomModel({ nTrees, depth, features, seed = 7, featurePool = null, leafProb = 0 }) {
  const rand = prng(seed);
  const pool = featurePool ?? features.map((_, i) => i);
  const trees = Array.from({ length: nTrees }, () => randomTree(rand, { depth, pool, leafProb }));
  return {
    format: "lst-xgb-compact-v1",
    objective: "reg:squarederror",
    target_mode: "anomaly",
    features,
    base_score: 0.05,
    n_trees: nTrees,
    trees,
    fidelity: null,
    check: { rows: [], expected: [] },
  };
}

/** Straightforward recursive reference evaluator (independent of model.js internals). */
export function referencePredict(modelJson, row) {
  let sum = Number(modelJson.base_score) || 0;
  for (const tree of modelJson.trees) {
    let node = 0;
    while (tree.l[node] !== -1) {
      const raw = row[tree.f[node]];
      const missing = raw === null || raw === undefined || Number.isNaN(raw);
      if (missing) node = tree.d[node] === 1 ? tree.l[node] : tree.r[node];
      else node = Math.fround(raw) < tree.t[node] ? tree.l[node] : tree.r[node];
    }
    sum += tree.v[node];
  }
  return sum;
}
