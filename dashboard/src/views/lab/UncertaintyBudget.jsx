/**
 * UNCERTAINTY BUDGET (UI_SPEC §3.5 / §3.8; SPEC §4.10): share of the projection variance of
 * the scope mean explained by each Monte-Carlo factor — GCM choice, climate sensitivity β,
 * land-use realisation, model error (main effects, normalised to sum 1). One 100 % bar per
 * SSP at the chosen frame, components in a fixed validated colour order with a 2 px surface
 * gap, labelled in the legend and inside segments wide enough to hold the text.
 */
import { useMemo } from "react";
import { fmtPct } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { COMPONENT_COLORS, COMPONENT_LABELS, sspStyle } from "../../viz/chartTheme.js";
import { BUDGET_KEYS as KEYS, budgetShares } from "./labModel.js";

/**
 * @param {{budget: Record<string, Record<string, object>>|null, ssps: string[], year: number,
 *          scopeLabel?: string, reason?: string|null, title?: string, rho?: number|null, mode?: string|null}} props
 *   `rho` = metrics.modes[mode].aoa.resid_rho_block20 (block-20 correlation of the model error, D13)
 */
export function UncertaintyBudget({ budget, ssps, year, scopeLabel = "", reason = null, title, rho = null, mode = null }) {
  const rows = useMemo(
    () =>
      ssps
        .map((id) => ({ id, shares: budgetShares(budget?.[id]?.[String(year)]) }))
        .filter((r) => r.shares),
    [budget, ssps, year],
  );
  const years = useMemo(() => {
    const ys = new Set();
    for (const id of ssps) for (const y of Object.keys(budget?.[id] ?? {})) ys.add(Number(y));
    return [...ys].filter(Number.isFinite).sort((a, b) => a - b);
  }, [budget, ssps]);
  const tableRows = ssps.flatMap((id) =>
    years
      .map((y) => ({ y, shares: budgetShares(budget?.[id]?.[String(y)]) }))
      .filter((r) => r.shares)
      .map((r) => ({ id: `${id}-${r.y}`, ssp: sspStyle(id).label, year: r.y, ...Object.fromEntries(KEYS.map((k, i) => [k, r.shares[i]])) })),
  );
  const status = reason ? { status: "unavailable", reason } : rows.length ? { status: "ready" } : { status: "unavailable", reason: "No uncertainty budget exported for this scope and frame (rerun notebook v2 section 11)." };

  return (
    <ChartTable
      title={title ?? `Uncertainty budget · ${year}${scopeLabel ? ` · ${scopeLabel}` : ""}`}
      status={status}
      columns={[{ key: "ssp", label: "Scenario" }, { key: "year", label: "Frame", align: "right" }, ...KEYS.map((k) => ({ key: k, label: COMPONENT_LABELS[k], align: "right", format: (v) => fmtPct(v, 0) }))]}
      rows={tableRows}
      caption="Share of the Monte-Carlo variance of the scope-mean projection explained by each factor (main effects, normalised to 100 %)."
    >
      <p className="mb-1.5 text-[11px] leading-snug text-ink-faint" data-testid="budget-model-note">
        Model share includes spatially correlated model error (20 km blocks){Number.isFinite(Number(rho)) && rho !== null ? ` (block correlation ρ = ${Number(rho).toFixed(2)}${mode ? `, ${mode}` : ""})` : ""}; structural uncertainty of the land response is not included.
      </p>
      <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted" aria-label="Uncertainty components">
        {KEYS.map((k) => (
          <li key={k} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ backgroundColor: COMPONENT_COLORS[k] }} />
            {COMPONENT_LABELS[k]}
          </li>
        ))}
      </ul>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="space-y-0.5">
            <span className="text-[11px] text-ink-muted">{sspStyle(r.id).label}</span>
            <div className="flex h-5 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={`${sspStyle(r.id).label}: ${KEYS.map((k, i) => `${COMPONENT_LABELS[k]} ${fmtPct(r.shares[i], 0)}`).join(", ")}`}>
              {KEYS.map((k, i) =>
                r.shares[i] > 0 ? (
                  <div key={k} className="flex h-full items-center justify-center overflow-hidden" style={{ width: `${r.shares[i] * 100}%`, backgroundColor: COMPONENT_COLORS[k] }} title={`${COMPONENT_LABELS[k]}: ${fmtPct(r.shares[i], 0)}`}>
                    {r.shares[i] >= 0.12 && <span className="font-mono text-[10.5px] font-medium text-void">{fmtPct(r.shares[i], 0)}</span>}
                  </div>
                ) : null,
              )}
            </div>
          </li>
        ))}
      </ul>
    </ChartTable>
  );
}

export default UncertaintyBudget;
