/**
 * The two-slot mix (UI_SPEC §6.2): ONE blend function, two implementations.
 *
 * This file is the CPU reference. `shaders/thermal.glsl.js` mirrors `mixWeight` and the
 * nodata rule line for line, and the tests in `mixFrame.test.js` pin the behaviour both must
 * share. Every map choreography is this one mechanism with a different weight field:
 *
 *   shape 0  fade    m = mix for every cell              (time tween, layer cross-fade)
 *   shape 1  sweep   front moves EAST → WEST in normalised longitude (Day ↔ Night terminator;
 *                    sunset and sunrise both reach the east of the NCR first, so the sweep
 *                    runs the same way in both directions, D10)
 *   shape 2  radial  front grows from a centre (what-if "ripple" from the region centroid)
 *   shape 3  split   screen-space x threshold (GPU only through ScreenSplitExtension; on the CPU
 *                    a split is two layer instances, so `mixFrame` treats it as a hard step)
 *
 * Weights are value-linear (UI_SPEC §5.1 law 1 "data never overshoots"): the feathered fronts are
 * clamped linear ramps, never smoothstep or springs, so an interpolated value always lies between
 * the two frame values.
 *
 * Nodata rule (shared with the GLSL): a cell is shown as slot A when m ≤ 0 and slot B when
 * m ≥ 1; strictly in between it needs BOTH values, otherwise it is nodata. An interpolated value
 * is never invented from one side only (UI_SPEC §1 principle 4).
 */

/** Shape codes (uniform `thermal.shape`). */
export const SHAPES = Object.freeze({ fade: 0, sweep: 1, radial: 2, split: 3 });
export const SHAPE_NAMES = Object.freeze(["fade", "sweep", "radial", "split"]);

/** Default feather of the sweep front in normalised longitude (UI_SPEC §5.2 D). */
export const SWEEP_FEATHER = 0.08;
/** Default feather of the radial ripple, as a fraction of the radius. */
export const RADIAL_FEATHER = 0.12;

/** Numeric shape code from a name or code (unknown → fade). */
export function shapeCode(shape) {
  if (typeof shape === "number") return shape >= 0 && shape <= 3 ? shape | 0 : SHAPES.fade;
  return SHAPES[shape] ?? SHAPES.fade;
}

const clamp01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** A per-cell field may be given as an array (indexed by i) or one number for every cell. */
const at = (field, i) => (field === null || field === undefined ? 0 : typeof field === "number" ? field : field[i]);

/**
 * Sweep weight of a cell at normalised longitude u (0 = west edge, 1 = east edge).
 * The front e travels from 1 + feather (all cells still A) to −feather (all cells B) as
 * sweepPos goes 0 → 1; inside the feather the weight is a linear ramp, east side first.
 */
export function sweepWeight(u, sweepPos, feather = SWEEP_FEATHER) {
  const f = Math.max(1e-6, feather);
  const edge = 1 + f - clamp01(sweepPos) * (1 + 2 * f);
  return clamp01((u - edge) / f + 1);
}

/**
 * Radial weight of a cell at distance d from the centre: the front radius grows from 0 to
 * radius·(1 + feather) as mix goes 0 → 1, so every cell inside `radius` has switched at mix = 1.
 */
export function radialWeight(d, mix, radius, feather = RADIAL_FEATHER) {
  const r = Math.max(1e-9, radius);
  const f = Math.max(1e-6, feather) * r;
  const front = clamp01(mix) * (r + f);
  return clamp01((front - d) / f);
}

/**
 * Mix weight m in [0, 1] of cell i.
 * @param {number} i cell index (used to read per-cell fields)
 * @param {object} p
 * @param {number|string} p.shape   0 fade | 1 sweep | 2 radial | 3 split
 * @param {number} [p.mix]          global mix (fade, radial progress)
 * @param {ArrayLike<number>|number} [p.lonNorm] normalised longitude per cell (sweep)
 * @param {number} [p.sweepPos]     sweep progress 0 → 1 (sweep), split position 0..1 (split)
 * @param {number} [p.feather]      front width (sweep: in lonNorm units; radial: fraction of radius)
 * @param {number} [p.cx] @param {number} [p.cy] centre of the radial front (same units as x/y)
 * @param {number} [p.radius]       radial extent (same units as x/y)
 * @param {ArrayLike<number>|number} [p.x] @param {ArrayLike<number>|number} [p.y]
 *   per-cell coordinates for the radial distance (normalised lon/lat with aspect correction) or,
 *   for `split`, the normalised screen x of the cell
 */
export function mixWeight(i, { shape = 0, mix = 0, lonNorm = 0, sweepPos = 0, feather, cx = 0, cy = 0, radius = 1, x = 0, y = 0 } = {}) {
  switch (shapeCode(shape)) {
    case SHAPES.sweep:
      return sweepWeight(at(lonNorm, i), sweepPos, feather ?? SWEEP_FEATHER);
    case SHAPES.radial: {
      const dx = at(x, i) - cx;
      const dy = at(y, i) - cy;
      return radialWeight(Math.sqrt(dx * dx + dy * dy), mix, radius, feather ?? RADIAL_FEATHER);
    }
    case SHAPES.split:
      return at(x, i) >= sweepPos ? 1 : 0;
    default:
      return clamp01(mix);
  }
}

/** Mix two physical values under the shared nodata rule (NaN = nodata). */
export function mixValue(va, vb, m) {
  if (m <= 0) return va;
  if (m >= 1) return vb;
  if (Number.isNaN(va) || Number.isNaN(vb)) return NaN;
  return va + (vb - va) * m;
}

/**
 * Decode raw slot values and blend them into `out` (Float32Array, NaN = nodata).
 *
 * @param {object} args
 * @param {ArrayLike<number>} args.a  slot A raw values (Int16 cube frame, or Float32 °C)
 * @param {ArrayLike<number>} args.b  slot B raw values (same length as a)
 * @param {number} [args.scaleA=1] @param {number} [args.scaleB=1]  raw → physical scale
 * @param {number} [args.offsetA=0] @param {number} [args.offsetB=0] added after scaling (e.g.
 *   −frame level for the anomaly variable)
 * @param {number|null} [args.nodata] raw nodata sentinel shared by both slots (NaN is always nodata);
 *   `nodataA` / `nodataB` override it per slot
 * @param {number|string} [args.shape] see SHAPES
 * @param {object} [args.params] the `mixWeight` parameters except `shape`
 * @param {Float32Array} [args.out] output buffer (allocated when absent)
 * @returns {Float32Array} out
 */
export function mixFrame({ a, b, scaleA = 1, scaleB = 1, offsetA = 0, offsetB = 0, nodata = null, nodataA, nodataB, shape = 0, params = {}, out = null }) {
  if (!a || !b) throw new TypeError("mixFrame: both slots (a, b) are required");
  if (a.length !== b.length) throw new RangeError(`mixFrame: slot lengths differ (${a.length} vs ${b.length})`);
  const n = a.length;
  const result = out && out.length === n ? out : new Float32Array(n);
  const ndA = nodataA === undefined ? nodata : nodataA;
  const ndB = nodataB === undefined ? nodata : nodataB;
  const hasNdA = ndA !== null && ndA !== undefined && !Number.isNaN(ndA);
  const hasNdB = ndB !== null && ndB !== undefined && !Number.isNaN(ndB);
  const code = shapeCode(shape);
  const p = { ...params, shape: code };
  // Fast path: a uniform fade weight is the same for every cell (the scrub hot path).
  const uniform = code === SHAPES.fade;
  const mUniform = uniform ? clamp01(p.mix ?? 0) : 0;
  for (let i = 0; i < n; i += 1) {
    const ra = a[i];
    const rb = b[i];
    const va = hasNdA && ra === ndA ? NaN : ra * scaleA + offsetA;
    const vb = hasNdB && rb === ndB ? NaN : rb * scaleB + offsetB;
    const m = uniform ? mUniform : mixWeight(i, p);
    result[i] = mixValue(va, vb, m);
  }
  return result;
}

/**
 * Per-cell weights of a shape (Float32Array). Used by the CPU colour path when two slots are
 * mixed in COLOUR (different ramps, e.g. the Day ↔ Night sweep) rather than in value.
 */
export function mixWeights(n, shape, params = {}, out = null) {
  const result = out && out.length === n ? out : new Float32Array(n);
  const code = shapeCode(shape);
  if (code === SHAPES.fade) {
    result.fill(clamp01(params.mix ?? 0));
    return result;
  }
  const p = { ...params, shape: code };
  for (let i = 0; i < n; i += 1) result[i] = mixWeight(i, p);
  return result;
}

/**
 * Normalised longitude per cell over [west, east] (the sweep coordinate). Shared by the column
 * attributes and the raster shader so the terminator front lines up across resolutions.
 */
export function lonNormOf(lon, [west, east]) {
  const span = east - west || 1;
  const out = new Float32Array(lon.length);
  for (let i = 0; i < lon.length; i += 1) out[i] = (lon[i] - west) / span;
  return out;
}

/**
 * Planar coordinates for the radial ripple: longitude scaled by cos(lat0) so the front is a
 * circle on the ground, both axes normalised by the latitude span.
 * @returns {{x: Float32Array, y: Float32Array, toXY: (lon:number, lat:number) => [number, number]}}
 */
export function planarCoords(lon, lat, [west, south, , north]) {
  const lat0 = ((south + north) / 2) * (Math.PI / 180);
  const k = Math.cos(lat0);
  const span = north - south || 1;
  const toXY = (lo, la) => [((lo - west) * k) / span, (la - south) / span];
  const x = new Float32Array(lon.length);
  const y = new Float32Array(lon.length);
  for (let i = 0; i < lon.length; i += 1) {
    const [px, py] = toXY(lon[i], lat[i]);
    x[i] = px;
    y[i] = py;
  }
  return { x, y, toXY };
}

/** Largest distance from (cx, cy) to any cell: the radius that lets a ripple reach every cell. */
export function maxDistance(x, y, cx, cy) {
  let best = 0;
  for (let i = 0; i < x.length; i += 1) {
    const d = (x[i] - cx) ** 2 + (y[i] - cy) ** 2;
    if (d > best) best = d;
  }
  return Math.sqrt(best);
}

/** Mean of the finite values (NaN when none). */
export function finiteMean(values) {
  let s = 0;
  let k = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isNaN(v) && Number.isFinite(v)) {
      s += v;
      k += 1;
    }
  }
  return k ? s / k : NaN;
}
