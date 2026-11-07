/**
 * DAY vs NIGHT dumbbell (UI_SPEC §3.5): for each district at one exact observed frame, the
 * day mean (solar dot, filled) and night mean (lunar dot, hollow) joined by the diurnal
 * range, sorted by DTR. Shape + label distinguish the modes, not hue alone. Hover highlights
 * the district everywhere; the table view lists the numbers.
 */
import { useMemo, useRef, useState } from "react";
import { fmt } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { ChartTip } from "../../viz/ChartTip.jsx";
import { CHART, MODE_STYLE, linearScale, linearTicks, niceDomain } from "../../viz/chartTheme.js";
import { useLinkStore } from "../../viz/linking.js";
import { useSize } from "../../viz/useSize.js";
import { dumbbellRows } from "./timelineModel.js";

const ROW = 15;
const M = { top: 16, right: 12, bottom: 20, left: 116 };

export function DayNightDumbbell({ series, year, nightReason, onSelect }) {
  const boxRef = useRef(null);
  const { width } = useSize(boxRef, { width: 360, height: 300 });
  const rows = useMemo(() => (series && year !== null ? dumbbellRows(series, year) : []), [series, year]);
  const hoverScope = useLinkStore((s) => s.hoverScope);
  const setHoverScope = useLinkStore((s) => s.setHoverScope);
  const [tip, setTip] = useState(null);
  const height = M.top + rows.length * ROW + M.bottom;
  const domain = niceDomain(rows.flatMap((r) => [r.day, r.night]), { pad: 0.04, minSpan: 2 });
  const x = linearScale(domain, [M.left, Math.max(M.left + 60, width - M.right)]);
  const status = nightReason ? { status: "unavailable", reason: nightReason } : series ? { status: "ready" } : { status: "loading" };

  return (
    <ChartTable
      title={`Day vs night · ${year ?? "—"}`}
      status={status}
      columns={[
        { key: "label", label: "District" },
        { key: "day", label: "Day °C", align: "right", format: (v) => fmt(v, 1) },
        { key: "night", label: "Night °C", align: "right", format: (v) => fmt(v, 1) },
        { key: "dtr", label: "DTR °C", align: "right", format: (v) => fmt(v, 1) },
      ]}
      rows={rows}
      caption={`District mean LST by day and at night in the ${year} frame, sorted by the diurnal range (day − night).`}
    >
      <div ref={boxRef} className="relative">
        <svg width={width} height={height} role="img" aria-label={`Day and night district means in ${year}, sorted by diurnal range. Use the table view for values.`}>
          {linearTicks(domain, 4).map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={M.top - 4} y2={height - M.bottom} stroke={CHART.grid} />
              <text x={x(t)} y={height - 6} textAnchor="middle" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
                {t}
              </text>
            </g>
          ))}
          <text x={M.left} y={10} fill={CHART.inkMuted} fontSize={10.5} fontFamily={CHART.font}>
            ● day · ○ night (°C)
          </text>
          {rows.map((r, k) => {
            const cy = M.top + k * ROW + ROW / 2;
            const hot = r.id === hoverScope;
            return (
              <g
                key={r.id}
                onPointerEnter={(e) => {
                  setHoverScope(r.id);
                  const rect = boxRef.current.getBoundingClientRect();
                  setTip({ r, x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onPointerLeave={() => {
                  setHoverScope(null);
                  setTip(null);
                }}
                onClick={() => onSelect?.(r.id)}
                className="cursor-pointer"
              >
                <rect x={0} y={cy - ROW / 2} width={width} height={ROW} fill={hot ? "rgba(160,185,225,0.06)" : "transparent"} />
                <text x={M.left - 8} y={cy} dy="0.32em" textAnchor="end" fill={hot ? CHART.ink : CHART.inkMuted} fontSize={11}>
                  {r.label}
                </text>
                {Number.isFinite(r.dtr) && <line x1={x(r.night)} x2={x(r.day)} y1={cy} y2={cy} stroke={CHART.axisLine} strokeWidth={2} />}
                {Number.isFinite(r.night) && <circle cx={x(r.night)} cy={cy} r={4} fill={CHART.surface} stroke={MODE_STYLE.night.accent} strokeWidth={1.75} />}
                {Number.isFinite(r.day) && <circle cx={x(r.day)} cy={cy} r={4} fill={MODE_STYLE.day.accent} stroke={CHART.surface} strokeWidth={1.5} />}
              </g>
            );
          })}
        </svg>
        {tip && (
          <ChartTip x={tip.x} y={tip.y} width={width}>
            <p className="text-ink-strong">{tip.r.label}</p>
            <p className="tnum font-mono">
              day {fmt(tip.r.day, 1)} · night {fmt(tip.r.night, 1)} · DTR {fmt(tip.r.dtr, 1)} °C
            </p>
          </ChartTip>
        )}
      </div>
    </ChartTable>
  );
}

export default DayNightDumbbell;
