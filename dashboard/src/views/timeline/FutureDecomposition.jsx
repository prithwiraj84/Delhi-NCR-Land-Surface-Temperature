/**
 * FUTURE DECOMPOSITION (UI_SPEC §3.5; SPEC §4.10): what drives the projected change of the
 * scope mean at a frame, per SSP — climate (β̄ · mean CMIP6 ΔT) and land use (mean change
 * of the model anomaly from projected land cover), and their total (p50 − weather-normalised
 * baseline). Bars start at zero and are signed (land use can cool), so the two parts are
 * shown side by side with the total as a diamond — never stacked into a misleading sum.
 * The uncertainty budget of the same frame follows below.
 */
import { useMemo, useRef, useState } from "react";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { fmtSigned } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART, COMPONENT_COLORS, COMPONENT_LABELS, linearScale, linearTicks, niceDomain, sspStyle } from "../../viz/chartTheme.js";
import { useSize } from "../../viz/useSize.js";
import { UncertaintyBudget } from "../lab/UncertaintyBudget.jsx";

const PARTS = [
  { key: "climate", label: COMPONENT_LABELS.climate, color: COMPONENT_COLORS.climate },
  { key: "land", label: "Land use (projected land cover)", color: COMPONENT_COLORS.land },
];
const M = { top: 6, right: 12, bottom: 20, left: 72 };

/**
 * @param {{series: object|null, ssps: string[], projYears: number[], scopeLabel: string, mode: string, reason?: string|null}} props
 */
export function FutureDecomposition({ series, ssps, projYears, scopeLabel, mode, reason = null }) {
  const [year, setYear] = useState(projYears[projYears.length - 1] ?? 2050);
  const boxRef = useRef(null);
  const { width } = useSize(boxRef, { width: 360, height: 160 });
  const rows = useMemo(
    () =>
      ssps
        .map((id) => {
          const d = series?.decomposition?.[id]?.[String(year)];
          return d ? { id, ssp: sspStyle(id).label, climate: Number(d.climate), land: Number(d.land), total: Number(d.total) } : null;
        })
        .filter(Boolean),
    [series, ssps, year],
  );
  const domain = niceDomain(rows.flatMap((r) => [r.climate, r.land, r.total, 0]), { pad: 0.08, minSpan: 0.5, includeZero: true });
  const x = linearScale(domain, [M.left, Math.max(M.left + 80, width - M.right)]);
  const rowH = 30;
  const height = M.top + rows.length * rowH + M.bottom;
  const status = reason ? { status: "unavailable", reason } : !ssps.length ? { status: "unavailable", reason: "No projections in this bundle — rerun notebook v2." } : rows.length ? { status: "ready" } : { status: "unavailable", reason: "No decomposition exported for this scope and frame." };
  const yearOptions = projYears.map((y) => ({ value: String(y), label: String(y) }));

  return (
    <div className="space-y-3">
      <ChartTable
        title={`Future decomposition · ${mode} · ${scopeLabel}`}
        status={status}
        actions={yearOptions.length > 1 ? <Segmented ariaLabel="Decomposition frame" size="sm" value={String(year)} onChange={(v) => setYear(Number(v))} options={yearOptions} layoutId="decomp-year" /> : null}
        columns={[
          { key: "ssp", label: "Scenario" },
          { key: "climate", label: "Climate °C", align: "right", format: (v) => fmtSigned(v, 2) },
          { key: "land", label: "Land °C", align: "right", format: (v) => fmtSigned(v, 2) },
          { key: "total", label: "Total °C", align: "right", format: (v) => fmtSigned(v, 2) },
        ]}
        rows={rows}
        caption={`Change of the ${mode} scope mean in ${year} relative to the weather-normalised ${"baseline"}, split into the climate term (CMIP6 ΔT × β) and the land-use term. Model + CMIP6 scenario, not observations.`}
      >
        <div ref={boxRef}>
          <ul className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted">
            {PARTS.map((p) => (
              <li key={p.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: p.color }} />
                {p.label}
              </li>
            ))}
            <li className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden="true">
                <path d="M5,0L10,5L5,10L0,5Z" fill={CHART.ink} />
              </svg>
              Total (p50 − baseline)
            </li>
          </ul>
          <svg width={width} height={height} role="img" aria-label={`Climate and land-use parts of the projected change in ${year}. Use the table view for values.`}>
            {linearTicks(domain, 4).map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={M.top} y2={height - M.bottom} stroke={t === 0 ? CHART.axisLine : CHART.grid} />
                <text x={x(t)} y={height - 5} textAnchor="middle" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
                  {fmtSigned(t, Math.abs(t) < 1 && t !== 0 ? 1 : 0)}
                </text>
              </g>
            ))}
            {rows.map((r, k) => {
              const cy = M.top + k * rowH;
              return (
                <g key={r.id}>
                  <text x={M.left - 8} y={cy + rowH / 2} dy="0.32em" textAnchor="end" fill={CHART.inkMuted} fontSize={11}>
                    {r.ssp}
                  </text>
                  {PARTS.map((p, j) => {
                    const v = r[p.key];
                    if (!Number.isFinite(v)) return null;
                    const x0 = x(Math.min(0, v));
                    const w = Math.max(1, Math.abs(x(v) - x(0)));
                    return <rect key={p.key} x={x0} y={cy + 4 + j * 10} width={w} height={8} rx={2} fill={p.color} />;
                  })}
                  {Number.isFinite(r.total) && <path d={`M${x(r.total)},${cy + 6}l5,7l-5,7l-5,-7Z`} fill={CHART.ink} stroke={CHART.surface} strokeWidth={1} />}
                </g>
              );
            })}
          </svg>
        </div>
      </ChartTable>
      <UncertaintyBudget budget={series?.uncertaintyBudget ?? null} ssps={ssps} year={year} scopeLabel={scopeLabel} reason={reason ?? (!ssps.length ? "No projections in this bundle — rerun notebook v2." : null)} />
    </div>
  );
}

export default FutureDecomposition;
