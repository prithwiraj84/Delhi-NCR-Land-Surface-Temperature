/**
 * v2 bundle contract validation (SPEC §5, UI_SPEC §10): run on whatever parts of a bundle are
 * loaded (manifest + timeline always; cells, cubes, zones, XAI frames, series, raster index and
 * small assets when present). Errors mean a SPEC invariant is broken (numbers on screen could be
 * wrong); warnings flag soft anomalies or optional parts that are missing.
 *
 * Invariants checked (non-exhaustive):
 * - manifest: schema 2.x, data/target mode, 18 groups whose members exist in the 47 features,
 *   4 zones per mode, 25 districts, required files declared;
 * - timeline: strictly increasing years, observed ≤ now < projected, tier vocabulary, projected
 *   frames tiered "projected", fixed domains present with lo < hi, cubes declared per mode/SSP;
 * - cells: canonical order (strictly increasing cell_id), row/col ↔ cell_id, coordinates in the
 *   bbox, district ids 0..24 (−1 allowed);
 * - cubes: sizes = frames × n, frame lists = manifest, tiers = manifest, values inside the fixed
 *   domain (domain coverage), observed frames carry no uncertainty offsets;
 * - zones: ids in {0..3, 255}, frame lists = manifest;
 * - XAI: n, groups = manifest order, additivity |pred − (base + Σ group SHAP)| ≤ 0.05 °C on a sample,
 *   resid ≈ obs − oof, feature columns = the base features;
 * - series: NCR scope present, years ⊂ frames, tiers in vocabulary, fans ordered p05 ≤ … ≤ p95;
 * - raster index: EPSG:4326, frames = manifest raster flags, lo/hi = the mode's fixed domain;
 * - optional v2 keys (accepted when absent, type-checked when present): zone display_name
 *   (non-empty string) and label_caveat (string or null) in manifest.zones and zones.json (D11);
 *   series frame coverage in [0, 1] (D16); decomposition baseline_c finite (D14); metrics
 *   land_model verdict / checks / hindcast_truth (D18); modes[m].aoa resid_rho_block20 in
 *   [0, 0.95] and proj_resid_q90 (10 finite values) (D13).
 */

import { cubeQuantiles, ZONE_NODATA } from "./cubes.js";
import { isKnownTier, TIERS } from "./timeline.js";
import { sampleRows, waterfallCheck, WATERFALL_SAMPLE, WATERFALL_TOLERANCE_C } from "./xai.js";

const LIMIT = 200;
const N_GROUPS = 18;
const N_FEATURES = 47;
const N_DISTRICTS = 25;
const DOMAIN_OUTSIDE_WARN = 0.02;
const DOMAIN_OUTSIDE_ERROR = 0.1;

function createReport() {
  const errors = [];
  const warnings = [];
  const checked = [];
  return {
    errors,
    warnings,
    checked,
    error: (m) => errors.length < LIMIT && errors.push(m),
    warn: (m) => warnings.length < LIMIT && warnings.push(m),
    done: (what) => checked.push(what),
  };
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const LAND_VERDICTS = new Set(["beats_null", "mixed", "worse_than_null"]);

/** D11 optional zone label keys on one zone entry. */
function checkZoneLabel(z, label, r) {
  if (!z || typeof z !== "object") return;
  if ("display_name" in z && !(typeof z.display_name === "string" && z.display_name.trim())) r.error(`${label}: display_name must be a non-empty string (got ${JSON.stringify(z.display_name)})`);
  if ("label_caveat" in z && !(z.label_caveat === null || typeof z.label_caveat === "string")) r.error(`${label}: label_caveat must be a string or null`);
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
const isPair = (d) => Array.isArray(d) && d.length === 2 && d.every(Number.isFinite) && d[0] < d[1];

function checkManifest(manifest, timeline, r, { adapted }) {
  if (!manifest || typeof manifest !== "object") {
    r.error("manifest: missing or not an object");
    return;
  }
  if (!adapted && !String(manifest.schema_version ?? "").startsWith("2")) r.error(`manifest: schema_version must be 2.x (got ${JSON.stringify(manifest.schema_version)})`);
  if (!["gee", "synthetic"].includes(manifest.data_mode)) r.error(`manifest: data_mode must be "gee" or "synthetic" (got ${JSON.stringify(manifest.data_mode)})`);
  if (manifest.target_mode !== undefined && manifest.target_mode !== "anomaly") r.warn(`manifest: target_mode is ${JSON.stringify(manifest.target_mode)} (v2 models anomalies)`);
  const features = Array.isArray(manifest.features) ? manifest.features : [];
  const names = features.map((f) => f?.name);
  if (new Set(names).size !== names.length) r.error("manifest: duplicate feature names");
  if (!adapted && features.length !== N_FEATURES) r.warn(`manifest: expected ${N_FEATURES} features (33 base + 14 focal), got ${features.length}`);
  const groups = Array.isArray(manifest.groups) ? manifest.groups : [];
  if (!adapted && groups.length !== N_GROUPS) r.error(`manifest: expected ${N_GROUPS} SHAP groups, got ${groups.length}`);
  const known = new Set(names);
  for (const g of groups) {
    if (!g?.id) {
      r.error("manifest: a group has no id");
      continue;
    }
    const members = Array.isArray(g.members) ? g.members : [];
    const unknown = members.filter((m) => !known.has(m));
    if (unknown.length) r.error(`manifest: group "${g.id}" lists unknown feature(s) ${unknown.join(", ")}`);
    if (g.primary && !members.includes(g.primary)) r.error(`manifest: group "${g.id}" primary "${g.primary}" is not one of its members`);
  }
  const zones = manifest.zones;
  for (const mode of timeline?.modeIds ?? []) {
    const list = Array.isArray(zones) ? zones : zones?.[mode];
    if (!Array.isArray(list) || list.length !== 4 || !list.every((z, i) => z?.id === i)) r.error(`manifest: zones.${mode} must list the 4 zones with ids 0..3`);
    else list.forEach((z) => checkZoneLabel(z, `manifest: zones.${mode}[${z.id}]`, r));
  }
  const districts = manifest.districts;
  if (!Array.isArray(districts) || !districts.length) r.error("manifest: districts list is empty");
  else if (districts.length !== N_DISTRICTS) r.warn(`manifest: expected ${N_DISTRICTS} districts, got ${districts.length}`);
  if (!adapted) {
    for (const key of ["cells", "series"]) if (!manifest.files?.[key]) r.error(`manifest: files.${key} not declared`);
    for (const key of ["shap_global", "dependence", "zones", "metrics", "districts", "provenance"]) if (!manifest.files?.[key]) r.warn(`manifest: files.${key} not declared`);
  }
  if (manifest.data_mode === "synthetic" && !manifest.synthetic_truth) r.warn("manifest: synthetic bundle without synthetic_truth");
  if (timeline?.projYears?.length && !(manifest.notes ?? []).some((n) => /scenario projection, not a forecast/i.test(String(n)))) {
    r.warn('manifest: notes should state "scenario projection, not a forecast" (SPEC §4.10)');
  }
  r.done("manifest");
}

function checkTimeline(manifest, timeline, r, { adapted }) {
  if (!timeline) {
    r.error("timeline: missing (manifest.timeline could not be normalised)");
    return;
  }
  for (const frame of timeline.frames) {
    const y = frame.year;
    if (frame.kind === "observed" && y > timeline.now) r.error(`timeline: observed frame ${y} lies after now=${timeline.now}`);
    if (frame.kind === "projected" && y <= timeline.now) r.error(`timeline: projected frame ${y} is not after now=${timeline.now}`);
    if (!(frame.window[0] <= y && y <= frame.window[1])) r.warn(`timeline: frame ${y} window ${frame.window.join("–")} does not contain the year`);
    for (const mode of ["day", "night"]) {
      const e = frame[mode];
      if (!e.available) continue;
      if (!isKnownTier(e.tier)) r.error(`timeline: ${mode} ${y} has unknown tier ${JSON.stringify(e.tier)} (vocabulary: ${TIERS.join(", ")})`);
      if (frame.kind === "projected" && e.tier !== "projected") r.error(`timeline: projected frame ${y} (${mode}) must have tier "projected", got "${e.tier}"`);
      if (frame.kind === "observed" && e.tier === "projected") r.error(`timeline: observed frame ${y} (${mode}) is tiered "projected"`);
      if (e.level !== null && e.level_ci && !(e.level_ci[0] <= e.level && e.level <= e.level_ci[1])) r.warn(`timeline: ${mode} ${y} level ${e.level} lies outside its CI`);
    }
  }
  for (const mode of timeline.modeIds) {
    const d = timeline.domains?.[mode];
    if (!isPair(d?.abs)) r.error(`timeline: domains.${mode}.abs missing or not [lo < hi]`);
    if (!adapted && !isPair(d?.anom)) r.warn(`timeline: domains.${mode}.anom missing`);
    if (d?.anom && isPair(d.anom) && Math.abs(d.anom[0] + d.anom[1]) > 1e-6) r.warn(`timeline: domains.${mode}.anom should be symmetric`);
    if (!adapted && !timeline.cubes[`obs_${mode}`]) r.error(`timeline: cubes.obs_${mode} not declared`);
    if (!adapted && timeline.projYears.length) {
      for (const s of timeline.scenarioIds) if (!timeline.cubes[`${s}_${mode}`]) r.error(`timeline: cubes.${s}_${mode} not declared`);
    }
  }
  if (timeline.projYears.length && !timeline.scenarios.length) r.error("timeline: projected frames exist but no scenarios are declared");
  if (new Set(timeline.scenarioIds).size !== timeline.scenarioIds.length) r.error("timeline: duplicate scenario ids");
  if (!adapted) {
    for (const frame of timeline.frames) {
      for (const mode of ["day", "night"]) {
        if (frame.xai[mode] && !manifest?.files?.xai?.[mode]?.[String(frame.year)]?.shap) r.error(`timeline: ${mode} ${frame.year} has xai=true but files.xai.${mode}.${frame.year} is missing`);
      }
    }
  }
  r.done("timeline");
}

function checkCells(cells, manifest, r) {
  if (!cells) return;
  const n = cells.n;
  if (!(n > 0)) {
    r.error("cells: n must be positive");
    return;
  }
  const broken = ["cell_id", "lon", "lat", "district"].filter((key) => !cells[key] || cells[key].length !== n);
  for (const key of broken) r.error(`cells: column ${key} missing or length != n (${n})`);
  if (broken.length) return;
  let unsorted = 0;
  for (let i = 1; i < n; i += 1) if (cells.cell_id[i] <= cells.cell_id[i - 1]) unsorted += 1;
  if (unsorted) r.error(`cells: cell_id not strictly increasing at ${unsorted} position(s) (canonical order)`);
  const W = cells.grid?.width;
  if (W && cells.row && cells.col) {
    let bad = 0;
    for (let i = 0; i < n; i += 1) if (cells.row[i] * W + cells.col[i] !== cells.cell_id[i]) bad += 1;
    if (bad) r.error(`cells: ${bad} cells violate cell_id = row·W + col (W=${W})`);
  }
  const bbox = manifest?.study_area?.bbox;
  let outside = 0;
  let badDistrict = 0;
  for (let i = 0; i < n; i += 1) {
    const lon = cells.lon[i];
    const lat = cells.lat[i];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) outside += 1;
    else if (Array.isArray(bbox) && !(lon >= bbox[0] - 0.05 && lon <= bbox[2] + 0.05 && lat >= bbox[1] - 0.05 && lat <= bbox[3] + 0.05)) outside += 1;
    const d = cells.district[i];
    if (!(d >= -1 && d < N_DISTRICTS)) badDistrict += 1;
  }
  if (outside) r.warn(`cells: ${outside} cells have missing coordinates or fall outside study_area.bbox`);
  if (badDistrict) r.error(`cells: ${badDistrict} cells have a district outside -1..${N_DISTRICTS - 1}`);
  r.done("cells");
}

function checkCube(key, cube, timeline, cells, r) {
  const label = `cube ${key}`;
  if (cells && cube.n !== cells.n) r.error(`${label}: n=${cube.n} differs from cells n=${cells.n}`);
  if (cube.values.length !== cube.F * cube.n) r.error(`${label}: ${cube.values.length} values != frames × n (${cube.F} × ${cube.n})`);
  const expected = cube.series === "obs" ? timeline.obsYears : timeline.projYears;
  if (cube.mode !== "dtr" && !sameList(cube.years, expected)) r.error(`${label}: frames ${cube.years.join(",")} != manifest ${expected.join(",")}`);
  cube.years.forEach((y, f) => {
    if (cube.mode === "dtr") return;
    const tier = timeline.frames.find((fr) => fr.year === y)?.[cube.mode]?.tier ?? null;
    if (cube.tiers[f] && tier && cube.tiers[f] !== tier) r.error(`${label}: frame ${y} tier "${cube.tiers[f]}" != manifest "${tier}"`);
  });
  const domain = timeline.domains?.[cube.mode]?.abs;
  if (isPair(domain)) {
    const main = cube.columns[cube.valueColumn];
    let valid = 0;
    let outside = 0;
    for (let i = 0; i < main.raw.length; i += 1) {
      const raw = main.raw[i];
      if (main.nodata !== null && raw === main.nodata) continue;
      const v = raw * main.scale + main.offset;
      valid += 1;
      if (v < domain[0] - 1e-6 || v > domain[1] + 1e-6) outside += 1;
    }
    const frac = valid ? outside / valid : 0;
    const [q05, q995] = cubeQuantiles(cube);
    const msg = `${label}: ${(100 * frac).toFixed(1)} % of values outside the fixed domain [${domain[0]}, ${domain[1]}] (data p0.5–p99.5 ${q05.toFixed(1)}–${q995.toFixed(1)})`;
    if (frac > DOMAIN_OUTSIDE_ERROR) r.error(msg);
    else if (frac > DOMAIN_OUTSIDE_WARN) r.warn(msg);
    if (!valid) r.warn(`${label}: no valid values`);
  }
  if (cube.series === "obs") {
    for (const q of ["p05_off", "p95_off"]) {
      const col = cube.columns[q];
      if (!col) continue;
      cube.years.forEach((y, f) => {
        const tier = cube.tiers[f] ?? timeline.frames.find((fr) => fr.year === y)?.[cube.mode]?.tier;
        if (tier !== "observed") return;
        const raw = col.raw.subarray(f * cube.n, (f + 1) * cube.n);
        if (raw.some((v) => v !== 0)) r.warn(`${label}: observed frame ${y} carries non-zero ${q} (SPEC: 0 for observed frames)`);
      });
    }
  }
  r.done(label);
}

function checkZones(mode, zones, timeline, cells, r) {
  const label = `zones ${mode}`;
  for (const [series, s] of Object.entries(zones.series ?? {})) {
    if (cells && s.n !== cells.n) r.error(`${label}.${series}: n=${s.n} differs from cells n=${cells.n}`);
    const expected = series === "obs" ? timeline.obsYears : timeline.projYears;
    if (!sameList(s.years, expected)) r.error(`${label}.${series}: frames ${s.years.join(",")} != manifest ${expected.join(",")}`);
    let bad = 0;
    for (let i = 0; i < s.values.length; i += 1) {
      const v = s.values[i];
      if (v > 3 && v !== ZONE_NODATA) bad += 1;
    }
    if (bad) r.error(`${label}.${series}: ${bad} values outside {0,1,2,3,255}`);
    if (series !== "obs" && !timeline.scenarioIds.includes(series)) r.warn(`${label}: series "${series}" is not a manifest scenario`);
  }
  r.done(label);
}

function checkXai(key, xai, manifest, timeline, cells, r, sample) {
  const label = `xai ${key}`;
  if (cells && xai.n !== cells.n) r.error(`${label}: n=${xai.n} differs from cells n=${cells.n}`);
  const groupIds = (manifest?.groups ?? []).map((g) => g.id);
  if (xai.source === "v2" && groupIds.length && !sameList(xai.groups, groupIds)) r.error(`${label}: SHAP groups do not match the manifest group order`);
  const wf = waterfallCheck(xai, { sample, tol: WATERFALL_TOLERANCE_C });
  if (!wf.checked) r.warn(`${label}: no complete rows to check SHAP additivity`);
  else if (wf.violations) {
    const msg = `${label}: pred ≠ base_value_c + Σ group SHAP on ${wf.violations}/${wf.checked} sampled rows (worst ${wf.worst.toFixed(3)} °C)`;
    if (wf.fraction > 0.01) r.error(msg);
    else r.warn(msg);
  }
  let residBad = 0;
  for (const i of sampleRows(xai.n, sample)) {
    const o = xai.obs[i];
    const p = xai.oof[i];
    const res = xai.resid[i];
    if (Number.isFinite(o) && Number.isFinite(p) && Number.isFinite(res) && Math.abs(o - p - res) > 0.02 + 1e-9) residBad += 1;
  }
  if (residBad) r.warn(`${label}: resid ≠ obs − oof on ${residBad} sampled rows`);
  const tier = timeline?.frames.find((f) => f.year === xai.year)?.[xai.mode]?.tier ?? null;
  if (xai.tier && tier && xai.tier !== tier) r.warn(`${label}: meta tier "${xai.tier}" != manifest "${tier}"`);
  if (xai.source === "v2" && xai.featureNames.length) {
    const base = (manifest?.features ?? []).filter((f) => f.base !== false && !/_m(3|15)$/.test(f.name)).map((f) => f.name);
    if (base.length && !sameList(xai.featureNames, base)) r.warn(`${label}: feature columns differ from the manifest base features`);
  }
  r.done(label);
}

function checkSeries(series, timeline, r) {
  if (!series) return;
  const ncr = series.raw?.ncr;
  if (!ncr) {
    r.error('series: scope "ncr" missing');
    return;
  }
  const frameYears = new Set(timeline.years);
  for (const mode of timeline.modeIds) if (!ncr[mode]) r.error(`series: ncr.${mode} missing`);
  for (const [scope, byMode] of Object.entries(series.raw)) {
    for (const [mode, entry] of Object.entries(byMode ?? {})) {
      const label = `series ${scope}.${mode}`;
      for (const f of entry?.frames ?? []) {
        if (!frameYears.has(Number(f.year))) r.error(`${label}: frame year ${f.year} is not a manifest frame`);
        if (f.tier && !isKnownTier(f.tier)) r.error(`${label}: unknown tier ${JSON.stringify(f.tier)}`);
        if (f.coverage !== undefined && f.coverage !== null && !(isNum(f.coverage) && f.coverage >= 0 && f.coverage <= 1)) r.error(`${label} ${f.year}: coverage must lie in [0, 1] (got ${JSON.stringify(f.coverage)})`);
      }
      for (const [ssp, rows] of Object.entries(entry?.decomposition ?? {})) {
        for (const [year, row] of Object.entries(rows ?? {})) {
          if (row && "baseline_c" in row && !isNum(row.baseline_c)) r.error(`${label}.decomposition.${ssp}.${year}: baseline_c must be a finite number`);
        }
      }
      for (const [ssp, fan] of Object.entries(entry?.ssp ?? {})) {
        if (!timeline.scenarioIds.includes(ssp)) r.warn(`${label}: ssp "${ssp}" is not a manifest scenario`);
        for (const row of fan ?? []) {
          const qs = [row.p05, row.p25, row.p50, row.p75, row.p95].map((v) => (v === null || v === undefined ? NaN : Number(v)));
          const finite = qs.filter(Number.isFinite);
          if (finite.some((v, i) => i > 0 && v < finite[i - 1] - 1e-9)) {
            r.error(`${label}.${ssp} ${row.year}: quantiles not ordered p05 ≤ p25 ≤ p50 ≤ p75 ≤ p95`);
            break;
          }
        }
      }
    }
  }
  r.done("series");
}

function checkRasterIndex(index, timeline, r) {
  if (!index) return;
  const expected = new Set();
  for (const f of timeline.frames) for (const mode of ["day", "night"]) if (f.raster[mode]) expected.add(`${mode}_${f.year}`);
  const present = new Set(Object.keys(index.frames));
  for (const k of expected) if (!present.has(k)) r.error(`raster_index: manifest says raster ${k} exists but it is not indexed`);
  for (const k of present) if (!expected.has(k)) r.warn(`raster_index: ${k} is indexed but the manifest raster flag is false`);
  for (const [k, f] of Object.entries(index.frames)) {
    const mode = k.split("_")[0];
    const d = timeline.domains?.[mode]?.abs;
    if (!(f.hi > f.lo)) r.error(`raster_index: ${k} has lo >= hi`);
    if (isPair(d) && (Math.abs(f.lo - d[0]) > 1e-6 || Math.abs(f.hi - d[1]) > 1e-6)) r.warn(`raster_index: ${k} lo/hi [${f.lo}, ${f.hi}] differ from the fixed ${mode} domain [${d[0]}, ${d[1]}]`);
  }
  r.done("raster_index");
}

function checkAssets(assets, timeline, r) {
  for (const [name, asset] of Object.entries(assets ?? {})) {
    if (!asset || typeof asset !== "object" || name === "districts" || name === "coupling" || name === "provenance" || name === "models") continue;
    if (!asset.modes) {
      r.warn(`${name}: not in the v2 per-mode shape ({modes: {day, night}})`);
      continue;
    }
    for (const mode of timeline.modeIds) if (!asset.modes[mode]) r.warn(`${name}: modes.${mode} missing`);
  }
  // zones.json (D11 optional label keys).
  for (const [mode, entry] of Object.entries(assets?.zones?.modes ?? {})) {
    for (const z of Array.isArray(entry?.zones) ? entry.zones : []) checkZoneLabel(z, `zones.json: modes.${mode}.zones[${z?.id}]`, r);
  }
  // metrics.json optional keys (D13, D18).
  const metrics = assets?.metrics;
  if (metrics && typeof metrics === "object" && metrics.modes) {
    for (const [mode, m] of Object.entries(metrics.modes)) {
      const aoa = m?.aoa;
      if (aoa && "resid_rho_block20" in aoa && !(isNum(aoa.resid_rho_block20) && aoa.resid_rho_block20 >= 0 && aoa.resid_rho_block20 <= 0.95 + 1e-9)) r.error(`metrics: modes.${mode}.aoa.resid_rho_block20 must lie in [0, 0.95]`);
      if (aoa && "proj_resid_q90" in aoa && !(Array.isArray(aoa.proj_resid_q90) && aoa.proj_resid_q90.length === 10 && aoa.proj_resid_q90.every(isNum))) r.error(`metrics: modes.${mode}.aoa.proj_resid_q90 must be 10 finite numbers`);
    }
    const lm = metrics.land_model;
    if (lm && typeof lm === "object") {
      if ("verdict" in lm && !LAND_VERDICTS.has(lm.verdict)) r.error(`metrics: land_model.verdict must be one of ${[...LAND_VERDICTS].join(", ")} (got ${JSON.stringify(lm.verdict)})`);
      if ("checks" in lm && !(Array.isArray(lm.checks) && lm.checks.every((c) => c && typeof c.check === "string" && typeof c.ok === "boolean"))) r.error("metrics: land_model.checks must be a list of {check, value, null, ok}");
      if ("hindcast_truth" in lm && !(typeof lm.hindcast_truth === "string" && lm.hindcast_truth)) r.error("metrics: land_model.hindcast_truth must be a non-empty string");
    }
  }
}

/**
 * Validate the loaded parts of a v2 (or adapted v1) bundle.
 * @param {{manifest, timeline, cells?, cubes?: Object<string, Cube>, zones?: Object<string, object>,
 *          xai?: Object<string, Xai>, series?, rasterIndex?, assets?: object, adapted?: boolean,
 *          sample?: number}} bundle
 * @returns {{ok:boolean, errors:string[], warnings:string[], checked:string[], waterfallSample:number}}
 */
export function validateV2(bundle = {}) {
  const r = createReport();
  const { manifest, timeline, cells = null, cubes = {}, zones = {}, xai = {}, series = null, rasterIndex = null, assets = {}, adapted = false, sample = WATERFALL_SAMPLE } = bundle;
  const opts = { adapted };
  try {
    checkManifest(manifest, timeline, r, opts);
    checkTimeline(manifest, timeline, r, opts);
    if (timeline) {
      checkCells(cells, manifest, r);
      for (const [key, cube] of Object.entries(cubes)) if (cube) checkCube(key, cube, timeline, cells, r);
      for (const [mode, z] of Object.entries(zones)) if (z) checkZones(mode, z, timeline, cells, r);
      for (const [key, x] of Object.entries(xai)) if (x) checkXai(key, x, manifest, timeline, cells, r, sample);
      checkSeries(series, timeline, r);
      checkRasterIndex(rasterIndex, timeline, r);
      checkAssets(assets, timeline, r);
    }
  } catch (error) {
    r.error(`validation crashed: ${error?.message ?? error}`);
  }
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, checked: r.checked, waterfallSample: sample };
}
