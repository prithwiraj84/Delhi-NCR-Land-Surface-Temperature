/**
 * MODEL CARD (UI_SPEC §3.8; Mitchell et al. 2019 "Model Cards for Model Reporting"): what the
 * model is, what it was trained on, how it was validated, where it should not be trusted, and
 * the in-browser surrogate's fidelity. Every field is read from the bundle (manifest, model_web,
 * metrics); missing fields say so instead of being filled in.
 */
import { MicroLabel } from "../../components/ui/MicroLabel.jsx";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { fmt, fmtInt } from "../../lib/format.js";
import { foldMap, metricsSlice } from "./labModel.js";

/** The notebook's v2 XGBoost settings, quoted only as labelled defaults when the bundle exports none. */
const V2_DEFAULTS = "depth 6, min_child_weight 20, η 0.03, early stopping on inner 10 km blocks";

/** "max_depth 6, min_child_weight 20, eta 0.03" from an exported parameter object (or null). */
function paramsText(params) {
  if (!params || typeof params !== "object") return null;
  const keys = ["max_depth", "min_child_weight", "eta", "learning_rate", "subsample", "colsample_bytree", "reg_lambda"];
  const parts = keys.filter((k) => params[k] !== undefined && params[k] !== null).map((k) => `${k} ${params[k]}`);
  return parts.length ? parts.join(", ") : null;
}

/** "cooling: NDVI, MNDWI · warming: built-up fraction" from {feature: ±1}; focal means are folded into their base. */
function monotoneText(monotone, labelOf) {
  if (!monotone || typeof monotone !== "object") return null;
  const by = { "-1": [], 1: [] };
  for (const [name, sign] of Object.entries(monotone)) {
    if (/_m\d+$/.test(name) || !(Number(sign) === 1 || Number(sign) === -1)) continue;
    by[String(Number(sign))].push(labelOf(name));
  }
  const parts = [by["-1"].length ? `cooling: ${by["-1"].join(", ")}` : null, by[1].length ? `warming: ${by[1].join(", ")}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 border-b border-hairline/60 py-1.5 last:border-0">
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className="text-xs text-ink">{children}</dd>
    </div>
  );
}

/**
 * @param {{manifest: object|null, schema: string|null, modelRaw: object|null, mode: string, skill: object|null, timeline: object|null,
 *          metrics?: object|null}} props
 */
export function ModelCard({ manifest, schema, modelRaw, mode, skill, timeline, metrics = null }) {
  const features = manifest?.features ?? [];
  const base = features.filter((f) => f.base !== false && !/_m\d+$/.test(f.name));
  const focal = features.filter((f) => /_m\d+$/.test(f.name));
  const groups = manifest?.groups ?? [];
  const fid = modelRaw?.fidelity ?? null;
  const target = (manifest?.modes ?? []).find((m) => m.id === mode)?.target ?? (schema === "v1" ? "MODIS Terra LST_Day_1km (v1)" : null);
  const slice = metricsSlice(metrics, mode);
  // The frames the model was actually trained on (metrics.json), e.g. night 2005–2025: modelled and
  // reconstructed frames are available in the timeline but are not training targets.
  const trained = Array.isArray(slice?.frames) ? slice.frames.map(Number).filter(Number.isInteger) : [];
  const frames = trained.length ? trained : timeline ? timeline.frames.filter((f) => f.kind === "observed" && f[mode]?.available).map((f) => f.year) : [];
  const labelOf = (name) => features.find((f) => f.name === name)?.label ?? name;
  const params = paramsText(slice?.params ?? slice?.xgb_params ?? metrics?.xgb_params?.[mode] ?? null);
  const mono = monotoneText(slice?.monotone ?? fid?.monotone ?? null, labelOf);
  const rounds = Number.isFinite(Number(slice?.final_rounds)) && slice?.final_rounds !== null ? Number(slice.final_rounds) : null;
  const worst = foldMap(slice, "block20")?.worst ?? null;
  const modelText =
    schema === "v1"
      ? "XGBoost (v1 configuration), surrogate in the browser"
      : [
          `XGBoost (${params ?? `notebook defaults, not exported in this bundle: ${V2_DEFAULTS}`})`,
          rounds !== null ? `final model ${fmtInt(rounds)} rounds` : null,
          mono ? `monotone constraints (${mono})` : null,
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <HudFrame solid title={`Model card · ${mode}`} className="min-w-0">
      <dl>
        <Row label="Task">Per-cell LST anomaly regression (frame mean removed), one pooled model per mode, no year feature; absolute °C = anomaly + frame level.</Row>
        <Row label="Target">{target ?? "—"}</Row>
        <Row label="Model">{modelText}</Row>
        <Row label="Features">
          {features.length ? `${features.length} (${base.length} base${focal.length ? ` + ${focal.length} focal 3/15-cell means` : ""})` : "—"}
          {groups.length ? ` · explained as ${groups.length} SHAP groups` : ""}. No coordinates in the model (they contaminate SHAP and extrapolation).
        </Row>
        <Row label="Training frames">
          <span data-testid="training-frames">{frames.length ? frames.join(", ") : "—"}</span>
        </Row>
        <Row label="Validation">{skill?.spatial ? `${skill.v1 ? "Mean of per-fold" : "Pooled"} R² ${fmt(skill.spatial.r2, 2)} (${skill.spatial.label})${skill.temporal ? `; ${skill.temporal.label} ${fmt(skill.temporal.r2, 2)}` : ""}.` : "Not exported."}</Row>
        <Row label="Do not trust">
          Cells outside the area of applicability (hatched on the map),{worst && Number.isFinite(worst.rmse) ? ` the worst spatial-CV block (RMSE ${fmt(worst.rmse, 2)} °C, outlined on the fold map),` : ""} single-year weather, and projections as forecasts. SHAP describes the model, not causation.
        </Row>
        <Row label="Browser surrogate">
          {fid ? (
            <>
              depth ≤ {fid.max_depth ?? "?"}, {fmtInt(fid.rounds ?? modelRaw?.n_trees)} trees
              {Number.isFinite(fid.r2_vs_final) ? ` · R² vs final ${fmt(fid.r2_vs_final, 3)}` : ""}
              {Number.isFinite(fid.rmse_vs_final) ? ` · RMSE ${fmt(fid.rmse_vs_final, 2)} °C` : ""}
              {fid.note ? ` · ${fid.note}` : ""}
            </>
          ) : modelRaw ? (
            `${fmtInt(modelRaw.n_trees ?? modelRaw.trees?.length)} trees (no fidelity report)`
          ) : (
            "not loaded"
          )}
        </Row>
        <Row label="Data mode">
          <MicroLabel className={manifest?.data_mode === "synthetic" ? "text-warn" : undefined}>{manifest?.data_mode ?? "—"}</MicroLabel>
          {manifest?.generated_at ? ` · generated ${String(manifest.generated_at).slice(0, 10)}` : ""}
        </Row>
      </dl>
    </HudFrame>
  );
}

export default ModelCard;
