/**
 * MODEL CARD (UI_SPEC §3.8; Mitchell et al. 2019 "Model Cards for Model Reporting"): what the
 * model is, what it was trained on, how it was validated, where it should not be trusted, and
 * the in-browser surrogate's fidelity. Every field is read from the bundle (manifest, model_web,
 * metrics); missing fields say so instead of being filled in.
 */
import { MicroLabel } from "../../components/ui/MicroLabel.jsx";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { fmt, fmtInt } from "../../lib/format.js";

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 border-b border-hairline/60 py-1.5 last:border-0">
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className="text-xs text-ink">{children}</dd>
    </div>
  );
}

/**
 * @param {{manifest: object|null, schema: string|null, modelRaw: object|null, mode: string, skill: object|null, timeline: object|null}} props
 */
export function ModelCard({ manifest, schema, modelRaw, mode, skill, timeline }) {
  const features = manifest?.features ?? [];
  const base = features.filter((f) => f.base !== false && !/_m\d+$/.test(f.name));
  const focal = features.filter((f) => /_m\d+$/.test(f.name));
  const groups = manifest?.groups ?? [];
  const fid = modelRaw?.fidelity ?? null;
  const target = (manifest?.modes ?? []).find((m) => m.id === mode)?.target ?? (schema === "v1" ? "MODIS Terra LST_Day_1km (v1)" : null);
  const frames = timeline ? timeline.frames.filter((f) => f.kind === "observed" && f[mode]?.available).map((f) => f.year) : [];
  return (
    <HudFrame solid title={`Model card · ${mode}`} className="min-w-0">
      <dl>
        <Row label="Task">Per-cell LST anomaly regression (frame mean removed), one pooled model per mode, no year feature; absolute °C = anomaly + frame level.</Row>
        <Row label="Target">{target ?? "—"}</Row>
        <Row label="Model">{schema === "v1" ? "XGBoost (v1 configuration), surrogate in the browser" : "XGBoost (depth 6, min_child_weight 20, η 0.03, monotone constraints: day cooling for vegetation/water, night warming for built-up), early-stopped on inner 10 km blocks"}</Row>
        <Row label="Features">
          {features.length ? `${features.length} (${base.length} base${focal.length ? ` + ${focal.length} focal 3/15-cell means` : ""})` : "—"}
          {groups.length ? ` · explained as ${groups.length} SHAP groups` : ""}. No coordinates in the model (they contaminate SHAP and extrapolation).
        </Row>
        <Row label="Training frames">{frames.length ? frames.join(", ") : "—"}</Row>
        <Row label="Validation">{skill?.spatial ? `${skill.v1 ? "Mean of per-fold" : "Pooled"} R² ${fmt(skill.spatial.r2, 2)} (${skill.spatial.label})${skill.temporal ? `; ${skill.temporal.label} ${fmt(skill.temporal.r2, 2)}` : ""}.` : "Not exported."}</Row>
        <Row label="Do not trust">Cells outside the area of applicability (hatched on the map), the cool north-east fold, single-year weather, and projections as forecasts. SHAP describes the model, not causation.</Row>
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
