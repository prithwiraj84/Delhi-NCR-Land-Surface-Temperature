/**
 * Layer Dock and legend model for the Control view (UI_SPEC_v2 §3.2, §4.2, §6.1, §8).
 *
 * `layerAvailability` decides, per frame × mode, whether a map layer can be shown and why not
 * (reasons are user-facing copy: unavailable items stay visible with their reason).
 * `legendSpec` describes what ThermalLegend draws for the active layer — ramp, domain, unit,
 * semantics — and is exported so the map engine can colour with the SAME domain the legend
 * prints (UI_SPEC §4.2 D4: fixed domains across frames by default).
 *
 * Nothing here maps years to tiers: availability reads `timeline.frames[].{xai, raster, day,
 * night}` and tiers through data/timeline.js.
 */

import { domainFor, frameAt, frameModeAvailability, modeAvailable, modeUnavailableReason, tierOf, xaiYears } from "../../data/timeline.js";
import { rampFor } from "../../design/ramps.js";
import { zoneColors } from "../../design/tokens.js";
import { LEVELS_NOT_HARMONISED } from "../timeline/timelineModel.js";

/** Layer Dock entries in display order (UI_SPEC §3.2). */
export const LAYER_ITEMS = Object.freeze([
  Object.freeze({ id: "lst", label: "LST", hint: "Land surface temperature of the frame" }),
  Object.freeze({ id: "pred", label: "Predicted", hint: "Final model prediction (absolute °C)" }),
  Object.freeze({ id: "resid", label: "Residual (OOF)", hint: "Observed minus spatial-CV out-of-fold prediction" }),
  Object.freeze({ id: "shap", label: "SHAP", hint: "Grouped TreeSHAP contribution of one driver" }),
  Object.freeze({ id: "driver", label: "Dominant driver", hint: "Driver with the largest |SHAP| in each cell" }),
  Object.freeze({ id: "zones", label: "Zones", hint: "Governance zones (K-means on SHAP signatures)" }),
  Object.freeze({ id: "whatif", label: "What-if Δ", hint: "Simulated change from the what-if simulator" }),
  Object.freeze({ id: "unc", label: "Uncertainty", hint: "p95 − p05 spread of projected / modelled frames" }),
  Object.freeze({ id: "aoa", label: "AOA", hint: "Area of applicability of the model (Meyer & Pebesma 2021)" }),
]);

const XAI_LAYERS = new Set(["pred", "resid", "shap", "driver", "whatif"]);
const UNCERTAIN_TIERS = new Set(["modelled", "reconstructed", "projected"]);

const ok = { available: true, reason: null };
const no = (reason) => ({ available: false, reason });

function xaiSpan(timeline, mode) {
  const ys = xaiYears(timeline, mode);
  return ys.length ? `${ys[0]}–${ys[ys.length - 1]}` : null;
}

/**
 * Availability of one layer at the committed year.
 * @param {string} layer LAYER_ITEMS id
 * @param {{timeline: object|null, year: number|null, mode: string, scenarioReady?: boolean}} ctx
 * @returns {{available: boolean, reason: string|null}}
 */
export function layerAvailability(layer, { timeline, year, mode, scenarioReady = true }) {
  if (!timeline) return no("Bundle not loaded");
  if (!modeAvailable(timeline, mode)) return no(modeUnavailableReason(timeline, mode));
  const frame = Number.isFinite(year) ? frameAt(timeline, year) : null;
  const v1 = timeline.schema === "v1";

  if (layer === "lst") {
    if (!frame) return ok; // interpolated positions tween the LST layer
    const a = frameModeAvailability(frame, mode);
    return a.available ? ok : no(a.reason);
  }

  if (XAI_LAYERS.has(layer)) {
    if (mode === "dtr") return no("Drivers are explained per mode (Day or Night), not for DTR");
    if (!frame) return no("Driver layers need an exact frame — release the playhead on a frame");
    if (!frame.xai?.[mode]) {
      const span = xaiSpan(timeline, mode);
      return no(span ? `${frame.year}: drivers exist for frames with XAI (${span})` : `No ${mode} drivers in this bundle`);
    }
    if (layer === "whatif" && !scenarioReady) return no("The what-if engine is not ready for this frame");
    return ok;
  }

  if (layer === "zones") {
    if (mode === "dtr") return no("Zones are defined per mode (Day or Night)");
    if (!v1 && !timeline.cubes?.[`zones_${mode}`]) return no(`No ${mode} zones in this bundle`);
    if (v1 && frame && !frame.xai?.[mode]) return no(`${frame.year}: no zones for this epoch`);
    return ok;
  }

  if (layer === "unc") {
    if (v1) return no("Uncertainty is not in a v1 bundle — rerun notebook v2");
    if (!frame) return no("Uncertainty needs an exact frame");
    const tier = tierOf(timeline, frame.year, mode);
    return UNCERTAIN_TIERS.has(tier) ? ok : no(`${frame.year} is ${tier ?? "unavailable"}: uncertainty fans exist for projected and modelled frames`);
  }

  if (layer === "aoa") {
    if (v1) return no("AOA is not in a v1 bundle — rerun notebook v2");
    if (mode === "dtr") return no("AOA is computed per mode (Day or Night)");
    return ok;
  }

  return no(`Unknown layer "${layer}"`);
}

/** Robust symmetric bound: p98 of |x| (≥ floor) over a typed array; NaN-safe. */
export function robustAbsBound(values, floor = 0.05) {
  if (!values?.length) return floor;
  const abs = [];
  const step = Math.max(1, Math.floor(values.length / 20000)); // sample large columns
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) abs.push(Math.abs(values[i]));
  if (!abs.length) return floor;
  abs.sort((a, b) => a - b);
  return Math.max(floor, abs[Math.min(abs.length - 1, Math.round(0.98 * (abs.length - 1)))]);
}

/**
 * Zone legend entries for a mode from the manifest (v2 per-mode lists or v1 array). `label` is the
 * data-driven display name (D11: display_name ?? name); `name` stays canonical and `caveat` is the
 * zone's label_caveat (null when the label needs none).
 */
export function zoneEntries(manifest, mode) {
  const z = manifest?.zones;
  const list = Array.isArray(z) ? z : Array.isArray(z?.[mode]) ? z[mode] : Array.isArray(z?.zones?.[mode]) ? z.zones[mode] : Array.isArray(z?.day) ? z.day : [];
  return list.map((e, i) => {
    const name = e.name ?? e.label ?? `Zone ${i}`;
    const display = typeof e.display_name === "string" && e.display_name ? e.display_name : name;
    return { id: e.id ?? i, label: display, name, color: e.color ?? zoneColors[i % zoneColors.length], caveat: typeof e.label_caveat === "string" && e.label_caveat ? e.label_caveat : null };
  });
}

const VARIABLE_TITLES = Object.freeze({
  abs: "LST",
  anom: "Anomaly vs frame mean",
  suhi: "Surface UHI vs rural reference",
  delta: "Difference B − A",
});

/**
 * Legend description for the active layer.
 * @param {{layer: string, variable: string, mode: string, domainMode?: string, domain?: object|null,
 *          timeline?: object|null, xai?: object|null, shapFeature?: string|null, featureLabel?: string|null,
 *          scenarioResult?: object|null, manifest?: object|null, groups?: Array<{id,label}>}} input
 *   `domain` = useDomain() data ({domain, fixed, stretched, domainMode}).
 * @returns {{kind: "continuous"|"categorical"|"aoa", ramp?: string, domain?: [number, number], unit: string,
 *            title: string, signed: boolean, fixed: boolean, stretched: boolean, shared: boolean,
 *            entries?: Array<{id, label, color}>, note?: string|null}}
 */
export function legendSpec({ layer, variable, mode, domainMode = "fixed", domain = null, timeline = null, xai = null, shapFeature = null, featureLabel = null, scenarioResult = null, manifest = null, groups = [] }) {
  const base = { unit: "°C", fixed: false, stretched: false, shared: false, note: null };
  if (layer === "zones") {
    return { ...base, kind: "categorical", title: "Governance zones", signed: false, unit: "", entries: zoneEntries(manifest, mode === "dtr" ? "day" : mode), note: "Zone number and name carry identity, not colour alone" };
  }
  if (layer === "driver") {
    return { ...base, kind: "categorical", title: "Dominant driver (largest |SHAP|)", signed: false, unit: "", entries: groups, note: "Hover a cell for its driver" };
  }
  if (layer === "aoa") {
    return { ...base, kind: "aoa", title: "Area of applicability", signed: false, unit: "", note: "Hatched cells lie outside the model's area of applicability" };
  }
  if (layer === "unc") {
    const d = domainFor(timeline, mode, "spread") ?? [0, 4];
    return { ...base, kind: "continuous", ramp: "mist", domain: d, title: "Spread p95 − p05", signed: false, fixed: true };
  }
  if (layer === "resid") {
    const b = robustAbsBound(xai?.resid, 0.5);
    return { ...base, kind: "continuous", ramp: "polar", domain: [-b, b], title: "Residual: observed − OOF prediction", signed: true, note: "Symmetric about 0 (p98 of |residual|)" };
  }
  if (layer === "shap") {
    const col = shapFeature ? xai?.shap?.[shapFeature] : null;
    const b = robustAbsBound(col, 0.05);
    return { ...base, kind: "continuous", ramp: "polar", domain: [-b, b], title: `SHAP · ${featureLabel ?? shapFeature ?? "driver"}`, signed: true, note: col ? "Contribution to LST, symmetric about 0" : "Choose a driver" };
  }
  if (layer === "whatif") {
    const st = scenarioResult?.stats;
    const b = Math.max(0.05, Math.abs(st?.min ?? 0), Math.abs(st?.max ?? 0));
    return { ...base, kind: "continuous", ramp: "polar", domain: [-b, b], title: "What-if ΔLST", signed: true, note: scenarioResult ? null : "No what-if has been run yet" };
  }
  // lst / pred: the fixed cross-time domain of mode × variable from the manifest. The pred layer
  // ALWAYS shows absolute predicted LST, whatever the variable selector says (D22 b).
  const v = layer === "pred" ? "abs" : variable;
  const ramp = rampFor({ mode, variable: v, layer, domainMode });
  const d = layer === "pred" ? domainFor(timeline, mode, "abs") : domain?.domain ?? domainFor(timeline, mode, v);
  const signed = v !== "abs";
  const title = layer === "pred" ? "Predicted LST (absolute)" : `${VARIABLE_TITLES[v] ?? "LST"}${mode === "dtr" && v === "abs" ? " · diurnal range" : ""}`;
  return {
    ...base,
    kind: "continuous",
    ramp,
    domain: Array.isArray(d) ? d : null,
    title,
    signed,
    fixed: Array.isArray(d) && !(layer !== "pred" && domain?.stretched),
    stretched: layer !== "pred" && Boolean(domain?.stretched),
    shared: domainMode === "shared" && v === "abs",
    // Δ on a bundle whose levels are not harmonised is never drawn (T-F4-08): say why.
    note: v === "delta" && timeline && timeline.harmonised !== true ? LEVELS_NOT_HARMONISED : Array.isArray(d) ? null : `No fixed ${v} domain for ${mode} in this bundle`,
  };
}

/**
 * Merge the channel the engine actually DREW (engineStore.legend, D22 a) into a legendSpec: ramp,
 * lo/hi, kind, stretched, note and held come from the engine; the spec keeps the title, the
 * categorical / zone / driver entries and the AOA item. "Fixed across frames" is claimed only when
 * the engine reports a cross-frame domain. Returns `spec` unchanged while the engine has no legend
 * for this layer and mode (first paint, other content still loading).
 * @param {ReturnType<typeof legendSpec>} spec
 * @param {object|null} engine engineStore.legend
 * @param {{layer: string, mode: string, variable?: string}} ctx `variable` must match for the LST layer
 */
export function legendFromEngine(spec, engine, { layer, mode, variable = null }) {
  if (!spec || !engine || engine.layer !== layer || engine.mode !== mode) return spec;
  if (layer === "lst" && variable && engine.variable !== variable) return spec;
  // The engine draws nothing for this content: no scale (and no "fixed all frames" claim), only
  // the reason (D22 a; e.g. surface UHI at a projected year).
  if (engine.kind === "unavailable") {
    return { ...spec, kind: "unavailable", ramp: null, domain: null, signed: false, stretched: false, fixed: false, shared: false, entries: null, note: engine.note ?? "not available for this frame", engine: true };
  }
  if (spec.kind !== "continuous" || engine.kind === "categorical") return spec;
  const domain = Number.isFinite(engine.lo) && Number.isFinite(engine.hi) ? [engine.lo, engine.hi] : spec.domain;
  const stretched = Boolean(engine.stretched);
  const fixed = Boolean(engine.crossFrame) && !stretched;
  const notes = [];
  if (spec.note && !(layer === "lst" || layer === "pred")) notes.push(spec.note);
  if (engine.note) notes.push(engine.note);
  if (!fixed && !stretched && Number.isFinite(engine.domainYear)) notes.push(`scale from the ${engine.domainYear} frame, not fixed across frames`);
  if (engine.held) notes.push("nearest frame held (this layer is not interpolated between frames)");
  return {
    ...spec,
    ramp: engine.ramp ?? spec.ramp,
    domain,
    unit: engine.unit ?? spec.unit,
    signed: engine.kind === "diverging",
    stretched,
    fixed,
    shared: fixed && spec.shared,
    note: notes.length ? notes.join(" · ") : null,
    engine: true,
  };
}

/** Availability of the 250 m raster at a year × mode. */
export function rasterAvailability(timeline, year, mode) {
  if (!timeline) return { available: false, reason: "Bundle not loaded" };
  if (timeline.schema === "v1") return { available: false, reason: "250 m rasters are not in a v1 bundle — rerun notebook v2" };
  if (mode === "dtr") return { available: false, reason: "Rasters exist per mode (Day or Night), not for DTR" };
  const frame = Number.isFinite(year) ? frameAt(timeline, year) : null;
  if (!frame) return { available: false, reason: "Rasters exist for exact frames only" };
  return frame.raster?.[mode] ? { available: true, reason: null } : { available: false, reason: `${frame.year}: not downscaled to 250 m` };
}
