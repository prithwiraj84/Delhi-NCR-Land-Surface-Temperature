/**
 * Pure derivations for the Sources route (UI_SPEC §3.9): provenance swimlanes, the frame
 * provenance table and the downloadable file list. Everything is read from the bundle:
 * `provenance.json` (v2, SPEC §5.7), `manifest.timeline.frames` (normalised timeline) and
 * `manifest.data_sources` / `manifest.files` (both generations).
 */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Role → lane group (display order). */
const ROLE_ORDER = ["day", "night", "landcover", "drivers", "climate", "projections", "other"];

function laneGroup(source) {
  const s = `${source.role ?? ""} ${(source.used_for ?? []).join(" ")} ${source.label ?? ""}`.toLowerCase();
  if (/project|cmip|ssp|future/.test(s)) return "projections";
  if (/night/.test(s)) return "night";
  if (/day|landsat/.test(s)) return "day";
  if (/land.?cover|glc|worldcover|dynamic/.test(s)) return "landcover";
  if (/era5|chirps|climate|weather/.test(s)) return "climate";
  if (/ghs|pop|built|ntl|light|srtm|terrain|water/.test(s)) return "drivers";
  return "other";
}

/**
 * Swimlane rows from provenance.json, or — for bundles without it (v1) — one lane per
 * `manifest.data_sources` variable with a bar per documented year.
 * @returns {Array<{id, label, group, start, end, bars: {start, end}[], asset, resolution_m, role, used_for, notes, derived: boolean}>}
 */
export function swimlanes(provenance, manifest) {
  const sources = Array.isArray(provenance?.sources) ? provenance.sources : [];
  if (sources.length) {
    return sources
      .map((s) => {
        const start = Number(s.start);
        const end = Number(s.end);
        return { id: String(s.id ?? s.label), label: s.label ?? s.id, group: laneGroup(s), start, end, bars: isNum(start) && isNum(end) ? [{ start, end }] : [], asset: s.asset ?? null, resolution_m: s.resolution_m ?? null, role: s.role ?? null, used_for: s.used_for ?? [], notes: s.notes ?? null, derived: false };
      })
      .sort((a, b) => ROLE_ORDER.indexOf(a.group) - ROLE_ORDER.indexOf(b.group) || (a.start || 0) - (b.start || 0));
  }
  const ds = manifest?.data_sources ?? {};
  return Object.entries(ds)
    .map(([variable, entries]) => {
      const years = Object.keys(entries ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
      const sample = years.length ? entries[String(years[0])] : null;
      return {
        id: variable,
        label: variable,
        group: laneGroup({ role: variable, label: String(sample ?? "") }),
        start: years[0] ?? NaN,
        end: years[years.length - 1] ?? NaN,
        bars: years.map((y) => ({ start: y - 0.4, end: y + 0.4 })),
        asset: typeof sample === "string" ? sample.split(" ")[0] : null,
        resolution_m: null,
        role: variable,
        used_for: [],
        notes: years.map((y) => `${y}: ${entries[String(y)]}`).join("\n"),
        derived: true,
      };
    })
    .filter((l) => l.bars.length)
    .sort((a, b) => ROLE_ORDER.indexOf(a.group) - ROLE_ORDER.indexOf(b.group) || a.label.localeCompare(b.label));
}

/**
 * Frame provenance rows: every frame × mode with tier, sensor, overpass, window, scenes,
 * coverage and native resolution (from the timeline; provenance.json frames fill gaps).
 */
export function frameRows(timeline, provenance = null) {
  const extra = new Map((provenance?.frames ?? []).map((f) => [`${f.year}|${f.mode}`, f]));
  const rows = [];
  for (const f of timeline?.frames ?? []) {
    for (const mode of ["day", "night"]) {
      const e = f[mode];
      const p = extra.get(`${f.year}|${mode}`) ?? {};
      rows.push({
        id: `${f.year}-${mode}`,
        year: f.year,
        mode,
        kind: f.kind,
        available: Boolean(e?.available),
        tier: e?.available ? e.tier : null,
        sensor: e?.sensor ?? p.sensor ?? null,
        overpass: e?.overpass_ist ?? p.overpass_ist ?? null,
        window: Array.isArray(f.window) ? `${f.window[0]}–${f.window[1]}` : null,
        scenes: e?.scenes ?? p.scenes ?? null,
        coverage: e?.coverage ?? p.coverage ?? null,
        native: e?.native_m ?? null,
        reason: e?.available ? null : e?.reason ?? "not available",
        xai: Boolean(f.xai?.[mode]),
        raster: Boolean(f.raster?.[mode]),
      });
    }
  }
  return rows;
}

/** Flatten manifest.files (nested objects) into [{key, file}] (deduplicated). */
export function bundleFiles(manifest) {
  const out = [];
  const seen = new Set();
  const walk = (prefix, v) => {
    if (typeof v === "string") {
      if (!seen.has(v)) {
        seen.add(v);
        out.push({ key: prefix, file: v });
      }
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x);
  };
  walk("", { manifest: "manifest.json", ...(manifest?.files ?? {}) });
  for (const [k, v] of Object.entries(manifest?.timeline?.cubes ?? {})) walk(`cube.${k}`, v);
  if (typeof manifest?.timeline?.raster_index === "string") walk("raster_index", manifest.timeline.raster_index);
  return out;
}

/** Citation text for the bundle (dataset + method + generation date). */
export function citationText(manifest) {
  const date = manifest?.generated_at ? String(manifest.generated_at).slice(0, 10) : "n.d.";
  const area = manifest?.study_area?.name ?? "Delhi NCR";
  const synthetic = manifest?.data_mode === "synthetic" ? " [SYNTHETIC demonstration bundle — not observations]" : "";
  return `${area} land surface temperature 1990–2050 (day and night) with explainable-AI drivers, web bundle schema ${manifest?.schema_version ?? "?"}, generated ${date}${synthetic}. Delhi NCR LST × Explainable AI pipeline (Landsat C2 L2 ST, MODIS/VIIRS, GHSL, GLC_FCS30D, ERA5-Land, NEX-GDDP-CMIP6). https://github.com/prithwiraj84/Delhi-NCR-Land-Surface-Temperature`;
}
