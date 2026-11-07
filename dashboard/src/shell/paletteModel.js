/**
 * Command-palette model (UI_SPEC_v2 §2.4): builds the searchable item list from the bundle
 * and parses free-form queries. Pure - the CommandPalette component only renders it.
 *
 * Groups: Years (parses "2045 night ssp585"), Districts (fly-to), Cells ("#48211",
 * "cell 48211"), Layers, Views, Commands. Every item carries an `action` descriptor executed
 * by shell/actions.js `runAction`.
 */
import { MOTION_PREF_LABELS } from "../design/motion.js";
import { ROUTES } from "./routes.js";

export const GROUP_ORDER = Object.freeze(["Years", "Districts", "Cells", "Layers", "Views", "Commands"]);

/** Map layers (UI_SPEC §2.2 `l` values) with palette labels. */
export const LAYER_ITEMS = Object.freeze([
  { layer: "lst", label: "LST (observed / projected)" },
  { layer: "pred", label: "Predicted LST" },
  { layer: "resid", label: "Residual (OOF)" },
  { layer: "driver", label: "Dominant driver" },
  { layer: "zones", label: "Governance zones" },
  { layer: "whatif", label: "What-if Δ" },
  { layer: "unc", label: "Uncertainty (p5–p95 spread)" },
  { layer: "aoa", label: "Area of applicability" },
]);

const MODE_WORDS = Object.freeze({ day: "day", d: "day", night: "night", n: "night", dtr: "dtr", range: "dtr", diurnal: "dtr" });

/**
 * Parse a frame query: "2045 night ssp585", "1990", "2040 n 245", "night 2030 SSP2-4.5".
 * @returns {{year: number|null, mode: string|null, ssp: string|null}|null} null when the query
 *   contains no year, mode or SSP token.
 */
export function parseFrameQuery(query) {
  const tokens = String(query ?? "")
    .toLowerCase()
    .replace(/ssp\s*(\d)-(\d)\.(\d)/g, (_, a, b, c) => `ssp${a}${b}${c}`)
    .split(/[\s,]+/)
    .filter(Boolean);
  let year = null;
  let mode = null;
  let ssp = null;
  for (const tok of tokens) {
    if (/^(19|20)\d{2}$/.test(tok)) {
      const y = Number(tok);
      if (y >= 1990 && y <= 2050) year = y;
    } else if (MODE_WORDS[tok]) {
      mode = MODE_WORDS[tok];
    } else if (/^(ssp)?(126|245|370|585)$/.test(tok)) {
      ssp = `ssp${tok.replace(/^ssp/, "")}`;
    }
  }
  if (year === null && mode === null && ssp === null) return null;
  return { year, mode, ssp };
}

/** Parse a cell query ("#48211", "cell 48211", "c48211") -> index or null. */
export function parseCellQuery(query) {
  const m = /^\s*(?:#|cell\s*|c)(\d{1,7})\s*$/i.exec(String(query ?? ""));
  return m ? Number(m[1]) : null;
}

/** Normalised text for matching (lower case, diacritics stripped). */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Match score of `query` against `text` (higher = better, 0 = no match): exact > prefix >
 * word-prefix > substring > in-order subsequence.
 */
export function matchScore(query, text) {
  const q = normalizeText(query).trim();
  const t = normalizeText(text);
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[\s/·()-]+/).some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i += 1;
  return i === q.length ? 10 : 0;
}

/**
 * Static items for the palette from bundle metadata.
 * @param {{districts?: Array<{id, name, state?}>, features?: Array<{name, label?}>,
 *          groups?: Array<{id, label}>, scenarios?: Array<{id, label}>, years?: number[],
 *          motionPref?: string}} input
 */
export function buildPaletteItems({ districts = [], features = [], groups = [], scenarios = [], years = [], motionPref = "system" } = {}) {
  const items = [];
  for (const route of ROUTES) {
    items.push({
      id: `view:${route.id}`,
      group: "Views",
      label: route.label,
      hint: `${route.description} · key ${route.key}`,
      keywords: `${route.id} view ${route.short}`,
      action: { type: "route", route: route.id, index: ROUTES.indexOf(route) },
    });
  }
  for (const d of districts) {
    if (d?.id === undefined || !d?.name) continue;
    items.push({
      id: `district:${d.id}`,
      group: "Districts",
      label: d.name,
      hint: d.state ? `${d.state} · fly to district` : "Fly to district",
      keywords: `district ${d.state ?? ""}`,
      action: { type: "selectDistrict", districtId: d.id },
    });
  }
  for (const l of LAYER_ITEMS) {
    items.push({ id: `layer:${l.layer}`, group: "Layers", label: l.label, hint: "Map layer", keywords: `layer ${l.layer}`, action: { type: "setLayer", layer: l.layer } });
  }
  // SHAP layers: v2 groups (manifest.groups) take precedence over v1 per-feature SHAP.
  const shapSources = groups.length ? groups.map((g) => ({ name: g.id, label: g.label })) : features.map((f) => ({ name: f.name, label: f.label ?? f.name }));
  for (const f of shapSources) {
    if (!f?.name) continue;
    items.push({
      id: `layer:shap:${f.name}`,
      group: "Layers",
      label: `SHAP · ${f.label}`,
      hint: "Attribution layer (°C contribution)",
      keywords: `shap driver attribution ${f.name}`,
      action: { type: "setLayer", layer: "shap", shapFeature: f.name },
    });
  }
  const first = years.length ? Math.min(...years) : 1990;
  const last = years.length ? Math.max(...years) : 2050;
  const commands = [
    { id: "cmd:compare-years", label: `Compare ${first} vs ${last}`, hint: "Split map, same camera", action: { type: "compareYears", a: first, b: last } },
    { id: "cmd:compare-modes", label: "Day | Night split", hint: "Same year, both modes", action: { type: "compareModes" } },
    { id: "cmd:briefing", label: "Start briefing", hint: "Guided, data-guarded tour · B", action: { type: "toggleBriefing" } },
    { id: "cmd:export", label: "Export view PNG", hint: "Current map view", action: { type: "exportPng" } },
    { id: "cmd:caveats", label: "Show caveats", hint: "Sources → caveats", action: { type: "route", route: "sources", index: 5, anchor: "caveats" } },
    { id: "cmd:hottest", label: "Probe the hottest cell", hint: "H", action: { type: "probeHottest" } },
    {
      id: "cmd:motion-reduced",
      label: motionPref === "reduced" ? "Motion: back to system setting" : "Reduced motion",
      hint: `Motion now: ${MOTION_PREF_LABELS[motionPref] ?? motionPref} · M cycles`,
      action: { type: "setMotion", value: motionPref === "reduced" ? "system" : "reduced" },
    },
    { id: "cmd:perf", label: "Performance mode", hint: "2-D, CPU path, no blur (tier 3)", action: { type: "setPerfTier", value: 3 } },
    { id: "cmd:shortcuts", label: "Keyboard shortcuts", hint: "?", action: { type: "openShortcuts" } },
  ];
  for (const c of commands) items.push({ ...c, group: "Commands", keywords: c.label });
  for (const s of scenarios) {
    if (!s?.id) continue;
    items.push({
      id: `cmd:ssp:${s.id}`,
      group: "Commands",
      label: `Scenario ${s.label ?? s.id}`,
      hint: "Applies to projected years",
      keywords: `${s.id} ssp scenario`,
      action: { type: "goToFrame", ssp: s.id },
    });
  }
  return items;
}

/**
 * Search: dynamic items (parsed frame / cell) first, then static items ranked by score and
 * grouped in GROUP_ORDER. Empty query -> Views + Commands only (a short, useful default).
 * @returns {Array<object>} items (each with `group`) in display order
 */
export function searchPalette(items, query, { limitPerGroup = 6, years = [] } = {}) {
  const q = String(query ?? "").trim();
  const out = [];
  const frame = parseFrameQuery(q);
  if (frame && (frame.year !== null || frame.ssp !== null || frame.mode !== null)) {
    const parts = [frame.year ?? "current year", frame.mode ?? null, frame.ssp ? frame.ssp.replace(/^ssp(\d)(\d)(\d)$/, "SSP$1-$2.$3") : null].filter(Boolean);
    const isFrame = frame.year === null || !years.length || years.includes(frame.year);
    out.push({
      id: `year:${frame.year ?? "_"}:${frame.mode ?? "_"}:${frame.ssp ?? "_"}`,
      group: "Years",
      label: `Go to ${parts.join(" · ")}`,
      hint: isFrame ? "Frame" : "Between frames: shown interpolated (≈)",
      action: { type: "goToFrame", year: frame.year, mode: frame.mode, ssp: frame.ssp },
    });
  }
  const cell = parseCellQuery(q);
  if (cell !== null) {
    out.push({ id: `cell:${cell}`, group: "Cells", label: `Cell #${cell}`, hint: "Pin and fly to cell", action: { type: "selectCell", cellIndex: cell } });
  }
  const pool = q ? items : items.filter((i) => i.group === "Views" || i.group === "Commands");
  const scored = pool
    .map((item) => ({ item, score: Math.max(matchScore(q, item.label), matchScore(q, item.keywords ?? "") * 0.6) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
  const perGroup = new Map();
  for (const { item } of scored) {
    const n = perGroup.get(item.group) ?? 0;
    if (n >= limitPerGroup) continue;
    perGroup.set(item.group, n + 1);
    out.push(item);
  }
  return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}
