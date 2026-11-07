/**
 * ERROR vs DISTANCE TO TRAINING (UI_SPEC §3.8; SPEC §4.2 `error_vs_distance`): RMSE of the
 * block20 XGBoost out-of-fold predictions binned by the distance from each test cell to the
 * nearest training cell of the same frame. A rising curve means skill decays away from the
 * training data — the reason the AOA mask exists. Bars from zero, one series, n per bin in the
 * tooltip/table. A second panel shows the block-size curve (pooled R² vs block size).
 */
import { useRef } from "react";
import { fmt, fmtInt } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART, linearScale, linearTicks, niceDomain } from "../../viz/chartTheme.js";
import { useSize } from "../../viz/useSize.js";
import { blockSizeRows, errorDistanceRows } from "./labModel.js";

const M = { top: 10, right: 8, bottom: 30, left: 38 };

export function ErrorDistance({ slice, mode }) {
  const boxRef = useRef(null);
  const { width } = useSize(boxRef, { width: 360, height: 180 });
  const rows = errorDistanceRows(slice);
  const curve = blockSizeRows(slice);
  const height = 170;
  const y = linearScale(niceDomain(rows.map((r) => r.rmse), { includeZero: true, minSpan: 0.5 }), [height - M.bottom, M.top]);
  const bw = rows.length ? (width - M.left - M.right) / rows.length : 0;
  const status = rows.length ? { status: "ready" } : { status: "unavailable", reason: "Error-vs-distance bins are a v2 export (metrics.json error_vs_distance) — rerun notebook v2." };
  return (
    <ChartTable
      title={`Error vs distance to training · ${mode}`}
      status={status}
      columns={[
        { key: "label", label: "Distance" },
        { key: "rmse", label: "RMSE °C", align: "right", format: (v) => fmt(v, 2) },
        { key: "n", label: "Cells", align: "right", format: (v) => fmtInt(v) },
      ]}
      rows={rows}
      caption="RMSE of block-20 out-of-fold predictions by distance from the test cell to the nearest training cell of the same frame."
    >
      <div ref={boxRef}>
        <svg width={width} height={height} role="img" aria-label={`RMSE rises from ${fmt(rows[0]?.rmse, 2)} to ${fmt(rows[rows.length - 1]?.rmse, 2)} °C with distance to training. Use the table view for values.`}>
          {linearTicks(y.domain, 4).map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={CHART.grid} />
              <text x={M.left - 5} y={y(t)} dy="0.32em" textAnchor="end" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
                {fmt(t, 1)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => (
            <g key={r.id}>
              <rect x={M.left + i * bw + 2} y={y(r.rmse)} width={Math.max(2, bw - 4)} height={Math.max(0, y(0) - y(r.rmse))} rx={3} fill={CHART.inkMuted}>
                <title>{`${r.label}: RMSE ${fmt(r.rmse, 2)} °C, ${fmtInt(r.n)} cells`}</title>
              </rect>
              <text x={M.left + i * bw + bw / 2} y={height - 16} textAnchor="middle" fill={CHART.axis} fontSize={10} fontFamily={CHART.font}>
                {r.label}
              </text>
            </g>
          ))}
          <text x={M.left} y={height - 2} fill={CHART.inkFaint} fontSize={10} fontFamily={CHART.font}>
            km to the nearest training cell · RMSE °C
          </text>
        </svg>
        {curve.length > 0 && (
          <p className="mt-1 text-[11px] text-ink-muted">
            Block-size curve (pooled R²):{" "}
            {curve.map((c, i) => (
              <span key={c.id} className={c.block === "random" ? "text-ink-faint" : undefined} data-testid={c.block === "random" ? "block-random" : undefined}>
                {i > 0 ? " · " : ""}
                {c.block === "random" ? "random (optimistic upper bound)" : c.block === null ? "unlabelled" : `${c.block} km`} {fmt(c.r2, 2)}
              </span>
            ))}{" "}
            — larger blocks test further from the training data.
          </p>
        )}
      </div>
    </ChartTable>
  );
}

export default ErrorDistance;
