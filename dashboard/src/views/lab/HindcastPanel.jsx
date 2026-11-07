/**
 * HINDCAST & FIGURE OF MERIT (UI_SPEC §3.8; SPEC §4.7, §4.9, §4.5):
 *   - leave-one-epoch-out per held-out frame, raw vs recentred (recentring removes the frame's
 *     level so the score measures the spatial pattern; raw mixes in the level bias);
 *   - hindcast: night 2000 (train 2005–2025 → predict the Terra-reconstructed frame) vs
 *     persistence of 2005; day "train late, predict early";
 *   - persistent residual gain (λ-shrunk LOEO residual memory; never in spatial-CV numbers);
 *   - land-change model: the 2015 → 2025 hindcast vs the null model (proportional growth):
 *     figure of merit, quantity / allocation disagreement, RMSE and correlation of Δu side by
 *     side; when exported, the verdict ("beats_null" | "mixed" | "worse_than_null") with one line
 *     per check and the hindcast truth (the 2025 GHSL epoch is extrapolated, not an observation);
 *     older bundles fall back to the FoM comparison;
 *   - climate sensitivity β (dLST/dTair) with its bootstrap CI.
 */
import { fmt, fmtSigned } from "../../lib/format.js";
import { MicroLabel } from "../../components/ui/MicroLabel.jsx";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART } from "../../viz/chartTheme.js";
import { LAND_VERDICT_TEXT, landModelSummary, loeoRows, skillGain } from "./labModel.js";

const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);

function Stat({ label, children, note }) {
  return (
    <div className="space-y-0.5 rounded-md border border-hairline bg-surface-3/30 p-2.5">
      <MicroLabel>{label}</MicroLabel>
      <div className="text-xs text-ink">{children}</div>
      {note && <p className="text-[10.5px] leading-snug text-ink-faint">{note}</p>}
    </div>
  );
}

export function HindcastPanel({ slice, metrics, mode }) {
  const loeo = loeoRows(slice);
  const hc = slice?.hindcast ?? null;
  const pr = slice?.persistent_residual ?? null;
  const land = landModelSummary(metrics);
  const beta = metrics?.climate_sensitivity?.[mode] ?? null;
  const any = loeo.length || hc || pr || land || beta;
  const status = any ? { status: "ready" } : { status: "unavailable", reason: "Hindcasts, LOEO and the land-model figure of merit are v2 exports — rerun notebook v2." };
  const persistGain = hc ? skillGain(num(hc.rmse), num(hc.persistence_rmse)) : null;
  const max = Math.max(1e-6, ...loeo.map((r) => Math.max(r.r2 ?? 0, r.r2Raw ?? 0)));

  return (
    <ChartTable
      title={`Hindcast · LOEO · figure of merit · ${mode}`}
      status={status}
      columns={[
        { key: "year", label: "Held-out frame" },
        { key: "r2", label: "R² recentred", align: "right", format: (v) => fmt(v, 3) },
        { key: "r2Raw", label: "R² raw", align: "right", format: (v) => fmt(v, 3) },
        { key: "rmse", label: "RMSE °C", align: "right", format: (v) => fmt(v, 2) },
        { key: "biasRaw", label: "Level bias °C", align: "right", format: (v) => fmtSigned(v, 2) },
      ]}
      rows={loeo}
      caption="Leave-one-epoch-out scores: each training frame held out in turn; recentred removes the held-out frame's level."
    >
      <div className="grid gap-2.5 lg:grid-cols-2">
        {loeo.length > 0 && (
          <div className="space-y-1 lg:col-span-2">
            <MicroLabel>Leave-one-epoch-out (R², recentred solid · raw hollow)</MicroLabel>
            <ul className="space-y-0.5">
              {loeo.map((r) => (
                <li key={r.id} className="grid grid-cols-[3rem_minmax(0,1fr)_7rem] items-center gap-2 text-[11px] text-ink-muted">
                  <span className="font-mono">{r.year}</span>
                  <span className="relative h-2.5 rounded-[3px] bg-surface-3">
                    <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${(Math.max(0, r.r2 ?? 0) / max) * 100}%`, backgroundColor: CHART.inkMuted }} />
                    {Number.isFinite(r.r2Raw) && <span className="absolute top-0 size-2.5 -translate-x-1/2 rounded-full border border-ink bg-surface-2" style={{ left: `${(Math.max(0, r.r2Raw) / max) * 100}%` }} />}
                  </span>
                  <span className="tnum text-right font-mono text-ink">
                    {fmt(r.r2, 2)} <span className="text-ink-faint">raw {fmt(r.r2Raw, 2)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hc && (
          <Stat label={`Hindcast${hc.frame ? ` · ${hc.frame}` : hc.frames ? ` · ${hc.frames.join(", ")}` : ""}`} note={mode === "night" ? "Night: trained 2005–2025, predicting the Terra-reconstructed 2000 frame (recentred)." : "Day: trained on later frames, predicting the early Landsat frames (recentred)."}>
            R² <span className="tnum font-mono">{fmt(num(hc.r2), 2)}</span> · RMSE <span className="tnum font-mono">{fmt(num(hc.rmse), 2)} °C</span>
            {num(hc.persistence_rmse) !== null && (
              <span className="text-ink-muted">
                {" "}
                vs persistence {fmt(num(hc.persistence_rmse), 2)} °C{persistGain !== null ? ` (${fmtSigned(persistGain * 100, 0)} % skill)` : ""}
              </span>
            )}
          </Stat>
        )}
        {pr && (
          <Stat label="Persistent residual (time transfer only)" note="Shrunk memory of each cell's LOEO residual; it improves temporal transfer and is never used in spatial-CV scores.">
            λ = <span className="font-mono">{fmt(num(pr.lambda), 1)}</span> · LOEO RMSE {fmt(num(pr.loeo_rmse_without), 2)} → <span className="font-mono text-ink">{fmt(num(pr.loeo_rmse_with), 2)} °C</span>
          </Stat>
        )}
        {land && (
          <Stat
            label={`Land-change model · ${land.period ? `${land.period[0]} → ${land.period[1]}` : "2015 → 2025"} hindcast`}
            note={`Pontius figure of merit on cells whose built-up fraction grew by > 0.05; the null model grows built-up in proportion to its 2015 value.${land.truth ? ` Truth: ${land.truth}.` : ""}`}
          >
            <span data-testid="land-model">
              FoM <span className="tnum font-mono">{fmt(land.fom, 2)}</span> vs null <span className="tnum font-mono">{fmt(land.fomNull, 2)}</span>
              {land.verdict ? (
                <span className={land.verdict === "beats_null" ? "text-ok" : "text-warn"} data-testid="land-verdict">
                  {" "}
                  · {LAND_VERDICT_TEXT[land.verdict]}
                </span>
              ) : (
                land.fomBeats !== null && <span className={land.fomBeats ? "text-ok" : "text-warn"}> {land.fomBeats ? "· FoM beats the null" : "· FoM does not beat the null"}</span>
              )}
            </span>
            <span className="block text-ink-muted">
              quantity {fmt(land.quantity, 3)}
              {land.quantityNull !== null ? ` vs ${fmt(land.quantityNull, 3)}` : ""} · allocation {fmt(land.allocation, 3)}
              {land.allocationNull !== null ? ` vs ${fmt(land.allocationNull, 3)}` : ""} · RMSE(Δu) {fmt(land.rmseDu, 3)} vs {fmt(land.rmseDuNull, 3)}
              {land.corrDu !== null ? ` · corr(Δu) ${fmt(land.corrDu, 2)}${land.corrDuNull !== null ? ` vs ${fmt(land.corrDuNull, 2)}` : ""}` : ""}
            </span>
            {land.checks.length > 0 && (
              <ul className="mt-1 space-y-0.5" aria-label="Checks against the null model">
                {land.checks.map((c) => (
                  <li key={c.id} className="flex items-baseline gap-1.5 font-mono text-[11px]">
                    <span aria-hidden="true" className={c.ok ? "text-ok" : "text-warn"}>
                      {c.ok ? "✓" : "✗"}
                    </span>
                    <span className="text-ink">{c.check}</span>
                    <span className="text-ink-muted">
                      {fmt(c.value, 3)} vs {fmt(c.null, 3)}
                    </span>
                    <span className="sr-only">{c.ok ? "passed" : "failed"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Stat>
        )}
        {beta && (
          <Stat label={`Climate sensitivity β · ${mode}`} note="OLS slope of annual satellite LST on ERA5-Land air temperature (soil-moisture co-regressor), moving-block bootstrap CI; Theil–Sen alongside.">
            β = <span className="tnum font-mono">{fmt(num(beta.beta), 2)}</span> °C/°C [{fmt(num(beta.ci?.[0]), 2)}–{fmt(num(beta.ci?.[1]), 2)}] · R² {fmt(num(beta.r2), 2)} · n = {beta.n_years ?? "—"} years · Theil–Sen {fmt(num(beta.theil_sen), 2)}
          </Stat>
        )}
      </div>
    </ChartTable>
  );
}

export default HindcastPanel;
