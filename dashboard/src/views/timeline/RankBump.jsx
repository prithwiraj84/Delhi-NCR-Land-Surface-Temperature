/**
 * RANK BUMP (UI_SPEC §3.5): district rank (1 = hottest) of the chosen metric at every frame —
 * observed frames, then the selected SSP's p50 (projected ranks exist for the mean only).
 * All 25 lines are drawn as faint context; the five hottest at the last frame, the hovered
 * and the selected district are emphasised and end-labelled (selective direct labels).
 */
import { useMemo, useRef, useState } from "react";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { ChartTip } from "../../viz/ChartTip.jsx";
import { CHART, linearScale, yearTicks } from "../../viz/chartTheme.js";
import { useLinkStore } from "../../viz/linking.js";
import { useSize } from "../../viz/useSize.js";
import { fmt } from "../../lib/format.js";
import { rankBump } from "./timelineModel.js";

const M = { top: 10, right: 104, bottom: 20, left: 26 };

export function RankBump({ series, mode, years, metric, ssp, now, selectedScope, onSelect }) {
  const boxRef = useRef(null);
  const { width } = useSize(boxRef, { width: 420, height: 300 });
  const hoverScope = useLinkStore((s) => s.hoverScope);
  const setHoverScope = useLinkStore((s) => s.setHoverScope);
  const [tip, setTip] = useState(null);
  const data = useMemo(() => (series ? rankBump(series, { mode, years, metric, ssp }) : { years: [], lines: [] }), [series, mode, years, metric, ssp]);
  const n = data.lines.length;
  const height = Math.max(160, n * 11 + M.top + M.bottom);
  const x = linearScale([years[0] ?? 1990, years[years.length - 1] ?? 2050], [M.left, Math.max(M.left + 80, width - M.right)]);
  const y = linearScale([1, Math.max(2, n)], [M.top, height - M.bottom]);
  const last = data.years.length - 1;
  const top = new Set(
    data.lines
      .filter((l) => l.ranks[last] !== null && l.ranks[last] <= 5)
      .map((l) => l.id),
  );
  const emph = (id) => top.has(id) || id === hoverScope || id === selectedScope;
  const order = [...data.lines].sort((a, b) => Number(emph(a.id)) - Number(emph(b.id)));
  const path = (l) => {
    let d = "";
    let pen = false;
    l.ranks.forEach((r, k) => {
      if (r === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(data.years[k]).toFixed(1)},${y(r).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const rows = data.lines.map((l) => ({ id: l.id, label: l.label, ...Object.fromEntries(data.years.map((yr, k) => [String(yr), l.ranks[k]])) }));
  const status = series ? (n ? { status: "ready" } : { status: "unavailable", reason: "No district series in this bundle." }) : { status: "loading" };

  return (
    <ChartTable
      title={`Rank bump · ${mode}`}
      status={status}
      columns={[{ key: "label", label: "District" }, ...data.years.map((yr) => ({ key: String(yr), label: String(yr), align: "right" }))]}
      rows={rows}
      caption={`Rank of each district (1 = highest ${metric}) at each frame; projected frames rank the ${ssp ?? ""} p50.`}
    >
      <div ref={boxRef} className="relative">
        <svg width={width} height={height} role="img" aria-label={`District ranks by ${metric} across frames. Use the table view for ranks.`}>
          {Number.isFinite(now) && <line x1={x(now)} x2={x(now)} y1={M.top - 4} y2={height - M.bottom} stroke={CHART.now} />}
          {yearTicks(x.domain[0], x.domain[1], width < 420 ? 20 : 10).map((t) => (
            <text key={t} x={x(t)} y={height - 5} textAnchor="middle" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
              {t}
            </text>
          ))}
          {[1, Math.ceil(n / 2), n].map((r) => (
            <text key={r} x={M.left - 6} y={y(r)} dy="0.32em" textAnchor="end" fill={CHART.axis} fontSize={10} fontFamily={CHART.font}>
              {r}
            </text>
          ))}
          {order.map((l) => {
            const on = emph(l.id);
            const endK = [...l.ranks.keys()].reverse().find((k) => l.ranks[k] !== null);
            return (
              <g key={l.id} onPointerEnter={() => setHoverScope(l.id)} onPointerLeave={() => setHoverScope(null)} onClick={() => onSelect?.(l.id)} className="cursor-pointer">
                <path d={path(l)} fill="none" stroke={on ? (l.id === selectedScope ? CHART.cursor : CHART.ink) : CHART.inkFaint} strokeOpacity={on ? 1 : 0.28} strokeWidth={on ? 1.75 : 1} />
                <path d={path(l)} fill="none" stroke="transparent" strokeWidth={8} />
                {l.ranks.map((r, k) =>
                  r === null ? null : (
                    <circle
                      key={k}
                      cx={x(data.years[k])}
                      cy={y(r)}
                      r={on ? 3 : 1.75}
                      fill={on ? CHART.ink : CHART.inkFaint}
                      fillOpacity={on ? 1 : 0.4}
                      onPointerEnter={(e) => {
                        const rect = boxRef.current.getBoundingClientRect();
                        setTip({ l, k, x: e.clientX - rect.left, y: e.clientY - rect.top });
                      }}
                      onPointerLeave={() => setTip(null)}
                    />
                  ),
                )}
                {on && endK !== undefined && (
                  <text x={x(data.years[endK]) + 6} y={y(l.ranks[endK])} dy="0.32em" fill={CHART.ink} fontSize={10.5}>
                    {l.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <ChartTip x={tip.x} y={tip.y} width={width}>
            <p className="text-ink-strong">{tip.l.label}</p>
            <p className="tnum font-mono">
              {data.years[tip.k]}: rank {tip.l.ranks[tip.k]} · {fmt(tip.l.values[tip.k], 1)}
            </p>
          </ChartTip>
        )}
      </div>
    </ChartTable>
  );
}

export default RankBump;
