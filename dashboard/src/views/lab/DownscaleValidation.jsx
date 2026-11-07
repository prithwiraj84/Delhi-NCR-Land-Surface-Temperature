/**
 * DOWNSCALING VALIDATION (UI_SPEC §3.8; SPEC §4.8): how good is the 250 m layer?
 *   night  scale-invariance test: aggregate 1 km night anomalies to 4 km, downscale 4 km → 1 km
 *          with the same DMS model, score held-out block20 folds against the true 1 km field,
 *          versus plain bilinear interpolation (the baseline any downscaling must beat);
 *   day    demonstration: MODIS Terra 1 km → fine with the same algorithm vs Landsat fine
 *          anomalies (Landsat is observed at 30 m, so the day 250 m layer itself is observed);
 *   by LC  the night score by dominant land-cover class.
 */
import { fmt, fmtPct } from "../../lib/format.js";
import { MicroLabel } from "../../components/ui/MicroLabel.jsx";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART } from "../../viz/chartTheme.js";
import { downscalingSummary, skillGain } from "./labModel.js";

function Compare({ label, rmse, baseline, r2, note }) {
  const gain = skillGain(rmse, baseline);
  const max = Math.max(rmse ?? 0, baseline ?? 0, 1e-6);
  return (
    <div className="space-y-1.5 rounded-md border border-hairline bg-surface-3/30 p-2.5">
      <MicroLabel>{label}</MicroLabel>
      <p className="text-xs text-ink">
        R² <span className="tnum font-mono">{fmt(r2, 2)}</span> · RMSE <span className="tnum font-mono">{fmt(rmse, 2)} °C</span>
        {/* Honest wording both ways: a downscaler that loses to bilinear says so (warn tone). */}
        {gain !== null && gain >= 0 && <span className="text-ink-muted"> · {fmtPct(gain, 0)} lower error than bilinear</span>}
        {gain !== null && gain < 0 && <span className="text-warn"> · {fmtPct(-gain, 0)} higher error than bilinear</span>}
      </p>
      {[
        ["Downscaled", rmse, CHART.ink],
        ["Bilinear baseline", baseline, CHART.inkFaint],
      ].map(([name, v, color]) => (
        <div key={name} className="grid grid-cols-[7.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-[11px] text-ink-muted">
          <span>{name}</span>
          <span className="h-2 rounded-[3px] bg-surface-3">
            <span className="block h-2 rounded-[3px]" style={{ width: `${((v ?? 0) / max) * 100}%`, backgroundColor: color }} />
          </span>
          <span className="tnum text-right font-mono text-ink">{fmt(v, 2)}</span>
        </div>
      ))}
      {note && <p className="text-[10.5px] text-ink-faint">{note}</p>}
    </div>
  );
}

/** "4 km" / "500 m" from metres (labels follow the bundle's grid, e.g. the 2 km smoke grid). */
const resLabel = (m) => (m === null || m === undefined ? null : m >= 1000 ? `${fmt(m / 1000, m % 1000 ? 1 : 0)} km` : `${fmt(m, 0)} m`);

export function DownscaleValidation({ metrics }) {
  const d = downscalingSummary(metrics);
  const nightScale = d?.night?.coarseM && d?.night?.fineM ? `${resLabel(d.night.coarseM)} → ${resLabel(d.night.fineM)}` : "4 km → 1 km";
  const fineLabel = resLabel(d?.fineResM) ?? "250 m";
  const status = d ? { status: "ready" } : { status: "unavailable", reason: "No 250 m downscaling in this bundle (v1 bundles have none) — rerun notebook v2." };
  return (
    <ChartTable
      title={`Downscaling · ${fineLabel}`}
      status={status}
      columns={[
        { key: "cls", label: "Land-cover class" },
        { key: "r2", label: "R²", align: "right", format: (v) => fmt(v, 2) },
        { key: "rmse", label: "RMSE °C", align: "right", format: (v) => fmt(v, 2) },
      ]}
      rows={d?.byLc ?? []}
      caption="Night downscaling score by dominant land-cover class (scale-invariance test, held-out folds)."
    >
      {d && (
        <div className="grid gap-2.5 md:grid-cols-2">
          {d.night ? <Compare label={`Night · ${nightScale} (scale invariance)`} r2={d.night.r2} rmse={d.night.rmse} baseline={d.night.bilinear} note={`bias ${fmt(d.night.bias, 2)} °C · held-out block20 folds`} /> : <p className="text-xs text-ink-muted">No night scale-invariance test exported.</p>}
          {d.day ? <Compare label="Day · MODIS 1 km → fine vs Landsat" r2={d.day.r2} rmse={d.day.rmse} baseline={d.day.bilinear} note={`demonstration frames ${d.day.years.join(", ")} · the day ${fineLabel} layer itself is observed Landsat`} /> : <p className="text-xs text-ink-muted">No day demonstration exported.</p>}
        </div>
      )}
    </ChartTable>
  );
}

export default DownscaleValidation;
