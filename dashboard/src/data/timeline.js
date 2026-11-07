/**
 * Timeline model (SPEC §5.3 `manifest.timeline`, UI_SPEC §3.3 / §7).
 *
 * `buildTimeline(manifest)` turns the v2 manifest's timeline block into a normalised, immutable
 * object that every hook, store and chart reads. Pure functions below answer the questions the
 * UI asks per frame: which frame brackets a fractional year, what evidence tier a year × mode
 * has, which cube series (observations or an SSP) holds a year, which years are tier boundaries.
 *
 * Integrity rules (UI_SPEC §1 principle 3/4):
 * - Tiers are ALWAYS read from `timeline.frames[].{day,night}.tier`; nothing here maps years to
 *   tiers. An unknown tier string is kept verbatim and reported by the validator.
 * - A fractional year is never a frame: `frameTierInfo` marks it `interpolated` and names the
 *   bracket; its tier is the weaker (less certain) of the two bracketing tiers.
 * - DTR (day − night) exists only for frames where both modes are available; its tier is the
 *   weaker of the two.
 */

/** Evidence-tier vocabulary (exact strings, SPEC §1.2), ordered from most to least certain. */
export const TIERS = Object.freeze(["observed", "observed-sparse", "reconstructed", "modelled", "projected"]);
const TIER_RANK = new Map(TIERS.map((t, i) => [t, i]));

export const MODES = Object.freeze(["day", "night"]);
/** Display modes accepted by the stores: the two physical modes plus the derived DTR. */
export const DISPLAY_MODES = Object.freeze(["day", "night", "dtr"]);

/** Default mode descriptors (used only when a manifest omits `modes`). */
const DEFAULT_MODES = Object.freeze({
  day: { id: "day", label: "Day · ~10:30 IST", target: "Landsat C2 L2 ST", ramp: "solar" },
  night: { id: "night", label: "Night · ~01:30 IST", target: "MODIS Aqua night (Aqua-equivalent)", ramp: "nocturne" },
});

/** Human labels of the CMIP6 scenarios (fallback when the manifest omits `label`). */
const SSP_LABELS = Object.freeze({ ssp126: "SSP1-2.6", ssp245: "SSP2-4.5", ssp370: "SSP3-7.0", ssp585: "SSP5-8.5" });

const toNum = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/** The weaker (less certain) of two tiers; unknown tiers rank as least certain. */
export function weakerTier(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const ra = TIER_RANK.has(a) ? TIER_RANK.get(a) : TIERS.length;
  const rb = TIER_RANK.has(b) ? TIER_RANK.get(b) : TIERS.length;
  return ra >= rb ? a : b;
}

export const isKnownTier = (tier) => TIER_RANK.has(tier);

/** "245" | "ssp245" | 245 -> "ssp245" (store / URL use the id; the URL the short form). */
export function normalizeSspId(ssp) {
  if (ssp === null || ssp === undefined || ssp === "") return null;
  const s = String(ssp).trim().toLowerCase();
  return s.startsWith("ssp") ? s : `ssp${s}`;
}

/** "ssp245" -> "245". */
export const sspShort = (id) => (id ? String(id).replace(/^ssp/i, "") : null);

/** Per-SSP NCR quantiles of a projected frame ({ssp245: {p05, p25, p50, p75, p95}}), or null. */
function normalizeByScenario(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [id, q] of Object.entries(raw)) {
    if (!q || typeof q !== "object") continue;
    const row = Object.fromEntries(["p05", "p25", "p50", "p75", "p95"].map((k) => [k, toNum(q[k])]));
    if (Number.isFinite(row.p50)) out[normalizeSspId(id)] = row;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeModeEntry(raw, frameKind, mode) {
  const entry = raw && typeof raw === "object" ? raw : null;
  const tier = entry?.tier ?? null;
  const available = entry ? entry.available !== false && tier !== null : false;
  const level = toNum(entry?.level);
  const ci = Array.isArray(entry?.level_ci) && entry.level_ci.length === 2 ? entry.level_ci.map(toNum) : null;
  return {
    mode,
    tier,
    available,
    sensor: entry?.sensor ?? null,
    overpass_ist: entry?.overpass_ist ?? null,
    scenes: Number.isFinite(toNum(entry?.scenes)) ? toNum(entry.scenes) : null,
    coverage: Number.isFinite(toNum(entry?.coverage)) ? toNum(entry.coverage) : null,
    native_m: Number.isFinite(toNum(entry?.native_m)) ? toNum(entry.native_m) : null,
    level: Number.isFinite(level) ? level : null,
    level_ci: ci && ci.every(Number.isFinite) ? ci : null,
    /** Projected frames: NCR quantiles per SSP (SPEC §5.3 by_scenario); `level` is `levelScenario`. */
    byScenario: normalizeByScenario(entry?.by_scenario),
    levelScenario: entry?.level_scenario ? normalizeSspId(entry.level_scenario) : null,
    reason:
      entry?.reason ??
      (available ? null : frameKind === "projected" ? `no ${mode} projection in this bundle` : `no ${mode} data for this frame`),
  };
}

function normalizeFrame(raw, index) {
  const year = Number(raw?.year);
  if (!Number.isInteger(year)) throw new Error(`timeline.frames[${index}] has no integer year`);
  const kind = raw.kind === "projected" ? "projected" : "observed";
  const window = Array.isArray(raw.window) && raw.window.length === 2 ? raw.window.map(Number) : [year, year];
  const frame = { year, index, kind, window };
  for (const m of MODES) frame[m] = normalizeModeEntry(raw[m], kind, m);
  frame.xai = { day: Boolean(raw.xai?.day), night: Boolean(raw.xai?.night) };
  frame.raster = { day: Boolean(raw.raster?.day), night: Boolean(raw.raster?.night) };
  return frame;
}

function normalizeDomains(raw) {
  const out = {};
  const pair = (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : null);
  for (const key of ["day", "night", "dtr"]) {
    const d = raw?.[key];
    out[key] = { abs: pair(d?.abs), anom: pair(d?.anom), suhi: pair(d?.suhi), delta: pair(d?.delta) };
  }
  out.spread = pair(raw?.spread);
  return out;
}

/**
 * Normalise `manifest.timeline` (schema 2.x).
 * @returns {Timeline} plain object (frozen) — see the field list in the return statement.
 * @throws {Error} when the timeline has no frames or duplicate / unordered years
 */
export function buildTimeline(manifest, { schema = "v2" } = {}) {
  const t = manifest?.timeline;
  if (!t || !Array.isArray(t.frames) || !t.frames.length) throw new Error("manifest.timeline.frames is missing or empty");
  const frames = t.frames.map(normalizeFrame);
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].year <= frames[i - 1].year) {
      throw new Error(`timeline.frames must be strictly increasing by year (${frames[i - 1].year} then ${frames[i].year})`);
    }
  }
  const years = frames.map((f) => f.year);
  const obsYears = frames.filter((f) => f.kind === "observed").map((f) => f.year);
  const projYears = frames.filter((f) => f.kind === "projected").map((f) => f.year);
  const now = Number.isInteger(Number(t.now)) ? Number(t.now) : obsYears[obsYears.length - 1] ?? years[years.length - 1];

  const declaredModes = Array.isArray(manifest.modes) && manifest.modes.length ? manifest.modes : MODES.map((m) => DEFAULT_MODES[m]);
  const modes = declaredModes
    .filter((m) => MODES.includes(m?.id))
    .map((m) => ({ ...DEFAULT_MODES[m.id], ...m, available: frames.some((f) => f[m.id].available) }));
  const modeIds = modes.filter((m) => m.available).map((m) => m.id);

  const scenarios = (Array.isArray(t.scenarios) ? t.scenarios : [])
    .map((s) => (typeof s === "string" ? { id: s } : s))
    .filter((s) => s && s.id)
    .map((s) => {
      const id = normalizeSspId(s.id);
      return { ...s, id, short: sspShort(id), label: s.label ?? SSP_LABELS[id] ?? id.toUpperCase() };
    });

  const timeline = {
    schema,
    now,
    harmonised: t.harmonised === true,
    referencePeriod: Array.isArray(t.reference_period) ? t.reference_period.map(Number) : null,
    frames,
    years,
    obsYears,
    projYears,
    first: years[0],
    last: years[years.length - 1],
    modes,
    modeIds,
    dtrAvailable: frames.some((f) => f.day.available && f.night.available),
    scenarios,
    scenarioIds: scenarios.map((s) => s.id),
    domains: normalizeDomains(t.domains),
    annotations: Array.isArray(t.annotations) ? t.annotations.filter((a) => Number.isFinite(Number(a?.year))) : [],
    tiers: Array.isArray(t.tiers) && t.tiers.length ? t.tiers.slice() : TIERS.slice(),
    cubes: t.cubes && typeof t.cubes === "object" ? { ...t.cubes } : {},
    rasterIndexFile: typeof t.raster_index === "string" ? t.raster_index : null,
  };
  return Object.freeze(timeline);
}

// ---------------------------------------------------------------------------------------
// Frame lookup and brackets
// ---------------------------------------------------------------------------------------

/** Index of the frame with exactly this year, or -1. */
export function frameIndexOf(timeline, year) {
  const y = Number(year);
  return timeline?.years ? timeline.years.indexOf(y) : -1;
}

export const frameAt = (timeline, year) => {
  const i = frameIndexOf(timeline, year);
  return i >= 0 ? timeline.frames[i] : null;
};

/** Clamp a time to the timeline's span. */
export function clampYear(timeline, t) {
  if (!timeline?.years?.length || !Number.isFinite(Number(t))) return timeline?.now ?? null;
  return Math.min(timeline.last, Math.max(timeline.first, Number(t)));
}

/**
 * Bracket of a (fractional) time over a sorted list of frame years.
 * Exactly on a frame: iA === iB, mix 0. Between frames: mix = (t − yA)/(yB − yA) in (0, 1).
 * @returns {{iA:number, iB:number, mix:number, yA:number, yB:number}|null}
 */
export function bracketAt(years, t) {
  if (!Array.isArray(years) || !years.length) return null;
  const x = Number(t);
  if (!Number.isFinite(x) || x <= years[0]) return { iA: 0, iB: 0, mix: 0, yA: years[0], yB: years[0] };
  const last = years.length - 1;
  if (x >= years[last]) return { iA: last, iB: last, mix: 0, yA: years[last], yB: years[last] };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (years[mid] <= x) lo = mid;
    else hi = mid;
  }
  if (years[lo] === x) return { iA: lo, iB: lo, mix: 0, yA: x, yB: x };
  return { iA: lo, iB: hi, mix: (x - years[lo]) / (years[hi] - years[lo]), yA: years[lo], yB: years[hi] };
}

/** Index of the frame nearest to t (ties go to the earlier frame). */
export function nearestFrameIndex(years, t) {
  const b = bracketAt(years, t);
  if (!b) return -1;
  return b.mix > 0.5 ? b.iB : b.iA;
}

/** True when the bracket points exactly at one frame. */
export const isExactBracket = (b) => Boolean(b) && (b.iA === b.iB || b.mix === 0);

// ---------------------------------------------------------------------------------------
// Tiers and availability
// ---------------------------------------------------------------------------------------

/** Tier of an exact frame year for a display mode, or null when the frame/mode does not exist. */
export function tierOf(timeline, year, mode) {
  const frame = frameAt(timeline, year);
  if (!frame) return null;
  if (mode === "dtr") return frame.day.available && frame.night.available ? weakerTier(frame.day.tier, frame.night.tier) : null;
  const entry = frame[mode];
  return entry?.available ? entry.tier : null;
}

/** Whether a display mode has any data in this bundle. */
export function modeAvailable(timeline, mode) {
  if (!timeline) return false;
  if (mode === "dtr") return Boolean(timeline.dtrAvailable);
  return timeline.modeIds?.includes(mode) ?? false;
}

/** Why a display mode is unavailable (null when available). */
export function modeUnavailableReason(timeline, mode) {
  if (modeAvailable(timeline, mode)) return null;
  if (!timeline) return "bundle not loaded";
  if (timeline.schema === "v1") return `${mode === "dtr" ? "DTR" : mode} is unavailable in a v1 bundle — rerun notebook v2`;
  return mode === "dtr" ? "DTR needs both day and night frames" : `no ${mode} frames in this bundle`;
}

/** Availability of a display mode at one exact frame: {available, reason}. */
export function frameModeAvailability(frame, mode) {
  if (!frame) return { available: false, reason: "not a frame year" };
  if (mode === "dtr") {
    const ok = frame.day.available && frame.night.available;
    return { available: ok, reason: ok ? null : `${frame.year}: DTR needs both day and night` };
  }
  const entry = frame[mode];
  return { available: Boolean(entry?.available), reason: entry?.available ? null : entry?.reason ?? `${frame.year}: no ${mode} data` };
}

/**
 * Cube series that holds a year: "obs" for observed frames, else the (normalised) SSP id.
 * Returns null for a projected year when the bundle has no scenario.
 */
export function seriesForYear(timeline, year, ssp) {
  const frame = frameAt(timeline, year);
  const kind = frame ? frame.kind : Number(year) <= (timeline?.now ?? -Infinity) ? "observed" : "projected";
  if (kind === "observed") return "obs";
  const id = normalizeSspId(ssp) ?? timeline?.scenarioIds?.[0] ?? null;
  return id && timeline?.scenarioIds?.includes(id) ? id : null;
}

/** Years of one series in frame order (obs -> observed frames; ssp -> projected frames). */
export const seriesYears = (timeline, series) => (series === "obs" ? timeline?.obsYears ?? [] : timeline?.projYears ?? []);

/**
 * Everything a FrameCard / tier chip needs for a (possibly fractional) year.
 * Projected frames report the SELECTED SSP: level = by_scenario[ssp].p50 and level_ci = its
 * [p05, p95] (`ci_kind` "p5–p95"); a missing SSP gives null (never another scenario's values).
 * Observed frames report the exported level and its CI (`ci_kind` "level").
 * @returns {{year, exact, interpolated, bracket, frame, kind, tier, sensor, overpass, window,
 *            scenes, coverage, native_m, level, level_ci, ci_kind, available, reason, series, ssp}}
 */
export function frameTierInfo(timeline, year, mode, ssp = null) {
  if (!timeline) return null;
  const t = clampYear(timeline, year);
  const bracket = bracketAt(timeline.years, t);
  const exact = isExactBracket(bracket);
  const frameA = timeline.frames[bracket.iA];
  const frameB = timeline.frames[bracket.iB];
  const pick = exact ? frameA : bracket.mix > 0.5 ? frameB : frameA;
  const entryOf = (frame) => (mode === "dtr" ? null : frame[mode]);
  const tierA = tierOf(timeline, frameA.year, mode);
  const tierB = tierOf(timeline, frameB.year, mode);
  const tier = exact ? tierA : weakerTier(tierA, tierB);
  const avail = frameModeAvailability(pick, mode);
  const entry = entryOf(pick);
  const series = seriesForYear(timeline, pick.year, ssp);
  let level = entry?.level ?? null;
  let levelCi = entry?.level_ci ?? null;
  let ciKind = levelCi ? "level" : null;
  if (pick.kind === "projected" && mode !== "dtr") {
    const q = series ? entry?.byScenario?.[series] ?? null : null;
    if (q) {
      level = q.p50;
      levelCi = Number.isFinite(q.p05) && Number.isFinite(q.p95) ? [q.p05, q.p95] : null;
      ciKind = levelCi ? "p5–p95" : null;
    } else {
      // No quantiles for the selected SSP: never show another scenario's level.
      level = null;
      levelCi = null;
      ciKind = null;
    }
  }
  return {
    year: t,
    exact,
    interpolated: !exact,
    bracket,
    frame: pick,
    kind: pick.kind,
    tier,
    sensor: mode === "dtr" ? [pick.day.sensor, pick.night.sensor].filter(Boolean).join(" − ") || null : entry?.sensor ?? null,
    overpass: mode === "dtr" ? [pick.day.overpass_ist, pick.night.overpass_ist].filter(Boolean).join("/") || null : entry?.overpass_ist ?? null,
    window: pick.window,
    scenes: entry?.scenes ?? null,
    coverage: entry?.coverage ?? null,
    native_m: entry?.native_m ?? null,
    level,
    level_ci: levelCi,
    ci_kind: ciKind,
    available: avail.available && (pick.kind === "observed" || series !== null),
    reason: avail.reason ?? (pick.kind === "projected" && series === null ? "no scenario projections in this bundle" : null),
    series,
    ssp: pick.kind === "projected" ? series : null,
  };
}

/**
 * Tier-boundary years for `Shift+← →` (UI_SPEC §2.3): the first frame, every frame whose tier
 * differs from the previous frame's tier for this mode (e.g. first observed, first projected),
 * NOW, and the last frame. Sorted, unique.
 */
export function tierBoundaries(timeline, mode) {
  if (!timeline?.years?.length) return [];
  const out = new Set([timeline.first, timeline.last]);
  if (Number.isFinite(timeline.now)) out.add(clampYear(timeline, timeline.now));
  let prev;
  timeline.frames.forEach((frame, i) => {
    const tier = tierOf(timeline, frame.year, mode) ?? `none:${frame.kind}`;
    if (i > 0 && tier !== prev) out.add(frame.year);
    prev = tier;
  });
  return [...out].sort((a, b) => a - b);
}

/** Manifest file name of a cube: `obs_<mode>`, `<ssp>_<mode>` or `zones_<mode>` (SPEC §5.3). */
export function cubeFileFor(timeline, mode, series) {
  const key = series === "zones" ? `zones_${mode}` : series === "obs" ? `obs_${mode}` : `${normalizeSspId(series)}_${mode}`;
  const declared = timeline?.cubes?.[key];
  if (typeof declared === "string" && declared) return declared;
  return null;
}

/** Frames for which XAI files exist in a mode (ascending). */
export const xaiYears = (timeline, mode) => (timeline?.frames ?? []).filter((f) => f.xai?.[mode]).map((f) => f.year);

/** Fixed colour domain for mode × variable from the manifest (null when not exported). */
export function domainFor(timeline, mode, variable = "abs") {
  const d = timeline?.domains?.[mode];
  if (!d) return null;
  if (variable === "spread" || variable === "unc") return timeline.domains.spread;
  return d[variable] ?? null;
}

/** Bracket label for interpolated readouts ("2035 ↔ 2040"). */
export const bracketLabel = (b) => (b && !isExactBracket(b) ? `${b.yA} ↔ ${b.yB}` : null);

