/**
 * Geometry and pure decisions of the time ribbon (UI_SPEC_v2 §3.3, §5.2 A/B, §12).
 *
 * Everything the ribbon draws or decides is computed here from the normalised timeline
 * (data/timeline.js `buildTimeline`) so it can be unit-tested without a DOM:
 *   - the linear year <-> pixel scale (with gutters so the end glyphs are never clipped),
 *   - frame ticks with their manifest tier, window bracket and availability,
 *   - contiguous tier segments for the patterned track (split half-way between frames),
 *   - magnetic snapping on release (nearest frame within 2.5 years; Shift disables it),
 *   - the compare bracket created by a Shift-drag (snapped to frames, A < B),
 *   - warming-stripe cells (frame mean − reference-period mean; projected = selected SSP),
 *   - the slider's aria-valuetext ("2040, projected under SSP2-4.5, night, NCR mean …"),
 *   - the mobile tape layout (fixed centre playhead, axis scrolls) and its momentum target.
 *
 * Integrity rule (UI_SPEC §1.3): no tier is ever derived from a year here. Tiers come from
 * `tierOf(timeline, year, mode)`, which reads `timeline.frames[].{day,night}.tier`.
 */

import { bracketAt, isExactBracket, nearestFrameIndex, tierOf, weakerTier } from "../data/timeline.js";

/** Default horizontal gutters (px) inside the ribbon SVG so end ticks/labels fit. */
export const RIBBON_GUTTER = Object.freeze({ left: 18, right: 26 });

/** Snap radius (years) for the magnetic release (UI_SPEC §3.3). */
export const SNAP_RADIUS = 2.5;

/** Playhead hit area (px), UI_SPEC §12: "the playhead hit area is 32 px". */
export const PLAYHEAD_HIT_PX = 32;

/** Minimum horizontal distance (px) between two tick year labels before labels are thinned. */
export const MIN_LABEL_PX = 40;

const EPS = 1e-6;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------------------

/**
 * Linear year scale over [first, last] mapped to [left, width − right].
 * @param {{first: number, last: number, width: number, left?: number, right?: number}} opts
 * @returns {{x: (t:number)=>number, invert: (px:number)=>number, clampT: (t:number)=>number,
 *            first:number, last:number, width:number, x0:number, x1:number, pxPerYear:number}}
 */
export function createRibbonScale({ first, last, width, left = RIBBON_GUTTER.left, right = RIBBON_GUTTER.right }) {
  const f = finite(first) ? first : 1990;
  const l = finite(last) && last > f ? last : f + 1;
  const w = finite(width) && width > 0 ? width : 1;
  const x0 = Math.min(left, w / 2);
  const x1 = Math.max(x0 + 1, w - right);
  const pxPerYear = (x1 - x0) / (l - f);
  const clampT = (t) => (finite(t) ? Math.min(l, Math.max(f, t)) : f);
  return {
    first: f,
    last: l,
    width: w,
    x0,
    x1,
    pxPerYear,
    clampT,
    x: (t) => x0 + (clampT(t) - f) * pxPerYear,
    invert: (px) => clampT(f + ((finite(px) ? px : x0) - x0) / pxPerYear),
  };
}

// ---------------------------------------------------------------------------------------
// Frames, ticks and tier segments
// ---------------------------------------------------------------------------------------

/** Effective physical mode for tiers of a display mode (DTR uses the weaker of day/night). */
const modeKey = (mode) => (mode === "dtr" ? "dtr" : mode === "night" ? "night" : "day");

/**
 * Frame ticks for a display mode.
 * @returns {Array<{year, index, x, kind, tier, available, window:[number,number], wx0, wx1,
 *                  scenes, coverage, sensor, overpass, reason, xai, raster}>}
 */
export function frameTicks(timeline, mode, scale) {
  if (!timeline?.frames?.length || !scale) return [];
  const m = modeKey(mode);
  return timeline.frames.map((frame) => {
    const tier = tierOf(timeline, frame.year, m);
    const entry = m === "dtr" ? null : frame[m];
    const available = m === "dtr" ? Boolean(frame.day?.available && frame.night?.available) : Boolean(entry?.available);
    const window = Array.isArray(frame.window) ? frame.window : [frame.year, frame.year];
    return {
      year: frame.year,
      index: frame.index,
      x: scale.x(frame.year),
      kind: frame.kind,
      tier,
      available,
      window,
      // The window bracket is drawn in the ribbon's own coordinates, clamped to its span.
      wx0: scale.x(Math.max(scale.first, window[0])),
      wx1: scale.x(Math.min(scale.last, window[1])),
      scenes: entry?.scenes ?? null,
      coverage: m === "dtr" ? minFinite(frame.day?.coverage, frame.night?.coverage) : entry?.coverage ?? null,
      sensor: m === "dtr" ? [frame.day?.sensor, frame.night?.sensor].filter(Boolean).join(" − ") || null : entry?.sensor ?? null,
      overpass: m === "dtr" ? [frame.day?.overpass_ist, frame.night?.overpass_ist].filter(Boolean).join("/") || null : entry?.overpass_ist ?? null,
      reason: available ? null : entry?.reason ?? (m === "dtr" ? `${frame.year}: DTR needs both day and night` : `${frame.year}: no ${m} data`),
      xai: m === "dtr" ? false : Boolean(frame.xai?.[m]),
      raster: m === "dtr" ? false : Boolean(frame.raster?.[m]),
    };
  });
}

function minFinite(a, b) {
  const xs = [a, b].filter(finite);
  return xs.length ? Math.min(...xs) : null;
}

/**
 * Contiguous runs of one tier for the patterned track. Each frame owns the span between the
 * midpoints to its neighbours (the first and last frames extend to the track ends); adjacent
 * frames with the same tier and availability merge into one segment.
 * @returns {Array<{x0:number, x1:number, tier:string|null, available:boolean, years:number[]}>}
 */
export function tierSegments(ticks, scale) {
  if (!ticks?.length || !scale) return [];
  const out = [];
  ticks.forEach((t, i) => {
    const left = i === 0 ? scale.x0 : (ticks[i - 1].x + t.x) / 2;
    const right = i === ticks.length - 1 ? scale.x1 : (t.x + ticks[i + 1].x) / 2;
    const last = out[out.length - 1];
    if (last && last.tier === t.tier && last.available === t.available) {
      last.x1 = right;
      last.years.push(t.year);
    } else {
      out.push({ x0: left, x1: right, tier: t.tier, available: t.available, years: [t.year] });
    }
  });
  return out;
}

/**
 * Keep every k-th tick label so labels never overlap (the first, NOW and last stay labelled).
 * @returns {number} stride k ≥ 1
 */
export function tickLabelStride(scale, count, minPx = MIN_LABEL_PX) {
  if (!scale || count < 2) return 1;
  const spacing = (scale.x1 - scale.x0) / (count - 1);
  return Math.max(1, Math.ceil(minPx / Math.max(1, spacing)));
}

/** Whether tick `i` of `ticks` gets a visible year label for a given stride. */
export function tickLabelled(ticks, i, stride, now) {
  if (stride <= 1) return true;
  if (i === 0 || i === ticks.length - 1) return true;
  if (ticks[i].year === now) return true;
  // Do not label a tick whose neighbour is a forced label (would collide).
  const forced = (j) => j === 0 || j === ticks.length - 1 || ticks[j]?.year === now;
  if (forced(i - 1) || forced(i + 1)) return false;
  return i % stride === 0;
}

// ---------------------------------------------------------------------------------------
// Snapping, brackets, hover
// ---------------------------------------------------------------------------------------

/**
 * Where a released playhead settles: the nearest frame within `radius` years when snapping,
 * else the nearest whole year (UI_SPEC §3.3; Shift disables the snap).
 */
export function snapTarget(t, years, { snap = true, radius = SNAP_RADIUS } = {}) {
  if (!finite(t)) return null;
  if (snap && years?.length) {
    const i = nearestFrameIndex(years, t);
    if (i >= 0 && Math.abs(years[i] - t) <= radius + EPS) return years[i];
  }
  return Math.round(t);
}

/**
 * Snap easing for chrome motion of the playhead (critically damped: approaches the target
 * monotonically and never overshoots — law 1 "data never overshoots" also holds because the
 * map follows the playhead). p in [0, 1] -> eased [0, 1].
 */
export function snapEase(p) {
  const x = Math.min(1, Math.max(0, p));
  const k = 7;
  const v = 1 - (1 + k * x) * Math.exp(-k * x);
  const end = 1 - (1 + k) * Math.exp(-k);
  return v / end;
}

/** Snap duration (ms) per motion level: ~250 ms spring in Full, a jump otherwise. */
export function snapDurationMs(level) {
  return level === "full" ? 250 : 0;
}

/**
 * Compare bracket from a Shift-drag between times t0 and t1: both ends snap to the nearest
 * frame; null when they collapse onto the same frame.
 * @returns {{a:number, b:number}|null}
 */
export function compareFromDrag(t0, t1, years) {
  if (!years?.length || !finite(t0) || !finite(t1)) return null;
  const a = years[nearestFrameIndex(years, Math.min(t0, t1))];
  const b = years[nearestFrameIndex(years, Math.max(t0, t1))];
  if (a === undefined || b === undefined || a === b) return null;
  return { a, b };
}

/**
 * What the pointer hovers: the frame it is near (within half a frame gap, at most `radius`
 * years) or an interpolated year with its bracket.
 * @returns {{t:number, year:number, frame:object|null, interpolated:boolean, bracket:object}}
 */
export function hoverInfo(t, timeline, { radius = SNAP_RADIUS } = {}) {
  if (!timeline?.years?.length || !finite(t)) return null;
  const years = timeline.years;
  const i = nearestFrameIndex(years, t);
  const near = i >= 0 && Math.abs(years[i] - t) <= Math.min(radius, 1.25) ? timeline.frames[i] : null;
  const year = near ? near.year : Math.round(t);
  const bracket = bracketAt(years, near ? near.year : t);
  return { t, year, frame: near, interpolated: !near && !isExactBracket(bracket), bracket };
}

// ---------------------------------------------------------------------------------------
// Warming stripes
// ---------------------------------------------------------------------------------------

/**
 * Mean of the observed frame means inside the reference period (inclusive), else of all
 * observed frames. Returns {mean, label, frames}.
 */
export function referenceMean(seriesFrames, referencePeriod) {
  const frames = (seriesFrames ?? []).filter((f) => finite(f?.mean));
  if (!frames.length) return { mean: NaN, label: null, frames: [] };
  const inRef = Array.isArray(referencePeriod) && referencePeriod.length === 2 ? frames.filter((f) => f.year >= referencePeriod[0] && f.year <= referencePeriod[1]) : [];
  const use = inRef.length ? inRef : frames;
  const mean = use.reduce((s, f) => s + f.mean, 0) / use.length;
  const label = inRef.length ? `${referencePeriod[0]}–${referencePeriod[1]}` : `mean of ${use.length} frames`;
  return { mean, label, frames: use.map((f) => f.year) };
}

/**
 * Warming-stripe cells: one stripe per frame span (frames are multi-year windows; years in
 * between have no data of their own and are not invented). Observed frames use the NCR frame
 * mean; projected frames use the selected SSP's p50 and are flagged `projected` (drawn at
 * 60 % alpha). Values are anomalies vs the reference mean.
 * @param {object} timeline normalised timeline
 * @param {object|null} ncr scope series of the display mode (data/series.js `scopeSeries`)
 * @param {string|null} ssp selected scenario id
 * @param {object} scale ribbon scale
 * @returns {{cells: Array<{year,x0,x1,value,projected,tier}>, reference: object, maxAbs:number}}
 */
export function stripeCells(timeline, ncr, ssp, scale) {
  const empty = { cells: [], reference: { mean: NaN, label: null, frames: [] }, maxAbs: 0 };
  if (!timeline?.frames?.length || !ncr || !scale) return empty;
  const reference = referenceMean(ncr.frames, timeline.referencePeriod);
  if (!finite(reference.mean)) return { ...empty, reference };
  const obs = new Map(ncr.frames.map((f) => [f.year, f]));
  const fan = new Map((ssp && ncr.ssp?.[ssp] ? ncr.ssp[ssp] : []).map((r) => [r.year, r]));
  const years = timeline.years;
  const cells = [];
  years.forEach((year, i) => {
    const x0 = i === 0 ? scale.x0 : (scale.x(years[i - 1]) + scale.x(year)) / 2;
    const x1 = i === years.length - 1 ? scale.x1 : (scale.x(year) + scale.x(years[i + 1])) / 2;
    const o = obs.get(year);
    const p = fan.get(year);
    const value = o && finite(o.mean) ? o.mean - reference.mean : p && finite(p.p50) ? p.p50 - reference.mean : NaN;
    cells.push({ year, x0, x1, value, projected: !o && Boolean(p), tier: o?.tier ?? (p ? "projected" : null) });
  });
  const maxAbs = Math.max(0.5, ...cells.map((c) => (finite(c.value) ? Math.abs(c.value) : 0)));
  return { cells, reference, maxAbs };
}

// ---------------------------------------------------------------------------------------
// Accessibility text
// ---------------------------------------------------------------------------------------

const TIER_WORDS = Object.freeze({
  observed: "observed",
  "observed-sparse": "observed (sparse scenes)",
  reconstructed: "reconstructed",
  modelled: "modelled",
  projected: "projected",
});

const MODE_WORDS = Object.freeze({ day: "day", night: "night", dtr: "diurnal range" });

/** Spoken °C value with a real "minus" word (screen readers skip U+2212 inconsistently). */
export function spokenC(v, dp = 1) {
  if (!finite(v)) return null;
  const s = Math.abs(v).toFixed(dp);
  return `${v < 0 && Number(s) !== 0 ? "minus " : ""}${s} °C`;
}

/**
 * aria-valuetext of the ribbon slider (UI_SPEC §12):
 *   "2040, projected under SSP2-4.5, night, NCR mean 31.2 °C (30.4 to 32.1)"
 *   "2032, interpolated between 2030 and 2035, day, NCR mean about 39.0 °C"
 * @param {{t:number, bracket:object, tier:string|null, mode:string, sspLabel?:string|null,
 *          kind?:string|null, stats?:{mean?:number, ci?:number[]|null, p05?:number, p95?:number}|null}} input
 */
export function ribbonValueText({ t, bracket, tier, mode, sspLabel = null, kind = null, stats = null }) {
  if (!finite(t)) return "Timeline not loaded";
  const exact = isExactBracket(bracket);
  const year = exact && bracket ? bracket.yA : Math.round(t * 10) / 10;
  const parts = [String(exact ? year : Math.round(t))];
  if (!exact && bracket) parts.push(`interpolated between ${bracket.yA} and ${bracket.yB}`);
  else if (tier) parts.push(tier === "projected" && sspLabel ? `projected under ${sspLabel}` : TIER_WORDS[tier] ?? String(tier));
  else if (kind === "projected" && sspLabel) parts.push(`projected under ${sspLabel}`);
  parts.push(MODE_WORDS[mode] ?? String(mode ?? ""));
  const mean = stats ? spokenC(stats.mean) : null;
  if (mean) {
    const lo = stats.ci?.[0] ?? stats.p05;
    const hi = stats.ci?.[1] ?? stats.p95;
    const range = finite(lo) && finite(hi) ? ` (${lo.toFixed(1)} to ${hi.toFixed(1)})` : "";
    parts.push(`${mode === "dtr" ? "NCR mean range" : "NCR mean"} ${exact ? "" : "about "}${mean}${exact ? range : ""}`);
  }
  return parts.filter(Boolean).join(", ");
}

/** Tier between two bracket frames for interpolated readouts (the weaker of the two). */
export function bracketTier(timeline, bracket, mode) {
  if (!timeline || !bracket) return null;
  const m = modeKey(mode);
  const a = tierOf(timeline, bracket.yA, m);
  return isExactBracket(bracket) ? a : weakerTier(a, tierOf(timeline, bracket.yB, m));
}

// ---------------------------------------------------------------------------------------
// Mobile tape (UI_SPEC §3.3 "tape measure")
// ---------------------------------------------------------------------------------------

/**
 * Tape geometry: the playhead is fixed at the centre and the axis translates under it.
 * @returns {{offset:number, x:(year:number)=>number}} offset = translateX of the axis group
 */
export function tapeLayout({ t, pxPerYear, width }) {
  const ppy = finite(pxPerYear) && pxPerYear > 0 ? pxPerYear : 8;
  const centre = (finite(width) ? width : 320) / 2;
  const base = finite(t) ? t : 0;
  return { offset: centre - base * ppy, x: (year) => year * ppy };
}

/**
 * Where a flicked tape settles: project the release velocity with exponential friction
 * (distance = v · τ), then snap to the nearest frame. `velocity` in years per ms.
 */
export function momentumTarget(t, velocity, years, { tauMs = 325, first = null, last = null } = {}) {
  if (!finite(t)) return null;
  const v = finite(velocity) ? velocity : 0;
  let projected = t + v * tauMs;
  const lo = finite(first) ? first : years?.[0];
  const hi = finite(last) ? last : years?.[years.length - 1];
  if (finite(lo)) projected = Math.max(lo, projected);
  if (finite(hi)) projected = Math.min(hi, projected);
  return snapTarget(projected, years, { snap: true, radius: Infinity });
}
