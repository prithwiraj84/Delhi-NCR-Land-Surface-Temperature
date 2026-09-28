/**
 * K diagnostics for the SHAP K-means: inertia (within-cluster sum of squares, the
 * "elbow") and mean silhouette against K, as two small multiples that share the K axis -
 * never a dual-axis chart, since the two measures have unrelated scales. The chosen K is
 * marked by a vertical band and a ringed point in both panels; hovering or focusing a K
 * column shows both values.
 */
import { useMemo, useRef, useState } from "react";
import { scaleLinear, scalePoint } from "d3-scale";
import { THEME } from "../../lib/colors.js";
import { fmt, fmtSig, isNum } from "../../lib/format.js";
import { CHART, useElementWidth } from "../performance/chartKit.js";
import { ChartTooltip, TooltipRow } from "../performance/ChartTooltip.jsx";
import { YAxisGrid } from "../performance/SvgAxes.jsx";
import { diagnosticsRows } from "./zoneModel.js";

const MARGIN = Object.freeze({ top: 12, right: 12, bottom: 28, left: 50 });
const HEIGHT = 170;

function linePath(points) {
  return points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
}

/**
 * One small multiple.
 * @param {{rows: {k: number, value: number|null}[], chosenK: number|null, color: string, title: string,
 *          format: (v: number) => string, hoverK: number|null, onHover: (k: number|null) => void}} props
 */
function MiniLine({ rows, chosenK, color, title, format, hoverK, onHover }) {
  const ref = useRef(null);
  const width = useElementWidth(ref, 300);
  const innerW = Math.max(60, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const valid = useMemo(() => rows.filter((r) => isNum(r.value)), [rows]);
  const x = useMemo(() => scalePoint().domain(rows.map((r) => r.k)).range([0, innerW]).padding(0.3), [rows, innerW]);
  const y = useMemo(() => {
    const vals = valid.map((r) => r.value);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    return scaleLinear().domain([lo - pad, hi + pad]).nice(4).range([innerH, 0]);
  }, [valid, innerH]);
  const step = x.step();
  const hovered = rows.find((r) => r.k === hoverK) ?? null;

  if (valid.length < 2) {
    return (
      <div ref={ref}>
        <p className="py-6 text-center text-xs text-ink-muted">Not enough {title.toLowerCase()} values.</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative min-w-0">
      <h4 className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">{title}</h4>
      <svg width={width} height={HEIGHT} className="block overflow-visible" role="img"
        aria-label={`${title} by number of clusters K: ${valid.map((r) => `K ${r.k} ${format(r.value)}`).join(", ")}${
          isNum(chosenK) ? `. Chosen K = ${chosenK}.` : ""
        }`}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {isNum(chosenK) && x(chosenK) !== undefined && (
            <rect
              x={x(chosenK) - step / 2}
              y={0}
              width={step}
              height={innerH}
              fill="rgba(34,211,238,0.08)"
              stroke="rgba(34,211,238,0.3)"
              strokeDasharray="3 3"
              rx={4}
              aria-hidden="true"
            />
          )}
          <YAxisGrid scale={y} width={innerW} ticks={4} format={(v) => format(v)} />
          <path
            d={linePath(valid.map((r) => [x(r.k), y(r.value)]))}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            aria-hidden="true"
          />
          {valid.map((r) => {
            const chosen = r.k === chosenK;
            const active = r.k === hoverK;
            return (
              <circle
                key={r.k}
                cx={x(r.k)}
                cy={y(r.value)}
                r={chosen || active ? 5 : 3.5}
                fill={chosen ? THEME.inkStrong : color}
                stroke={CHART.surface}
                strokeWidth={2}
                aria-hidden="true"
              />
            );
          })}
          {rows.map((r) => (
            <text
              key={`t${r.k}`}
              x={x(r.k)}
              y={innerH + 18}
              textAnchor="middle"
              fill={r.k === chosenK ? CHART.strongText : CHART.axisText}
              fontWeight={r.k === chosenK ? 600 : 400}
              fontSize={10.5}
              fontFamily={CHART.fontMono}
              aria-hidden="true"
            >
              {r.k}
            </text>
          ))}
          {/* hit columns: pointer + keyboard */}
          {rows.map((r) => (
            <rect
              key={`hit${r.k}`}
              x={x(r.k) - step / 2}
              y={0}
              width={step}
              height={innerH + 22}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`K ${r.k}: ${title} ${isNum(r.value) ? format(r.value) : "not available"}`}
              onPointerEnter={() => onHover(r.k)}
              onPointerLeave={() => onHover(null)}
              onFocus={() => onHover(r.k)}
              onBlur={() => onHover(null)}
              style={{ outline: "none" }}
            />
          ))}
          {hovered && x(hovered.k) !== undefined && (
            <rect
              x={x(hovered.k) - step / 2 + 1}
              y={0}
              width={step - 2}
              height={innerH}
              fill="none"
              stroke="rgba(148,163,184,0.45)"
              rx={4}
              aria-hidden="true"
            />
          )}
        </g>
      </svg>
      {hovered && isNum(hovered.value) && (
        <ChartTooltip
          x={MARGIN.left + x(hovered.k)}
          y={MARGIN.top + y(hovered.value) + 18}
          containerWidth={width}
          title={`K = ${hovered.k}${hovered.k === chosenK ? " · chosen" : ""}`}
          width={176}
        >
          <TooltipRow color={color} value={format(hovered.value)} label={title} />
        </ChartTooltip>
      )}
    </div>
  );
}

/** @param {{diagnostics: object|null, chosenK: number|null}} props */
export function KDiagnostics({ diagnostics, chosenK }) {
  const rows = useMemo(() => diagnosticsRows(diagnostics), [diagnostics]);
  const [hoverK, setHoverK] = useState(null);
  if (rows.length < 2) {
    return <p className="py-6 text-center text-xs text-ink-muted">No K diagnostics were exported.</p>;
  }
  const inertia = rows.map((r) => ({ k: r.k, value: r.inertia }));
  const silhouette = rows.map((r) => ({ k: r.k, value: r.silhouette }));
  const best = rows.reduce((b, r) => (isNum(r.silhouette) && (!b || r.silhouette > b.silhouette) ? r : b), null);
  return (
    <div className="space-y-2">
      <div className="grid gap-4 sm:grid-cols-2">
        <MiniLine rows={inertia} chosenK={chosenK} color={THEME.cyan} title="Inertia (elbow)" format={(v) => fmtSig(v, 3)} hoverK={hoverK} onHover={setHoverK} />
        <MiniLine rows={silhouette} chosenK={chosenK} color={THEME.violet} title="Silhouette" format={(v) => fmt(v, 3)} hoverK={hoverK} onHover={setHoverK} />
      </div>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        K is fixed at {isNum(chosenK) ? chosenK : 4} so the four zones keep stable, policy-readable identities across runs; the
        diagnostics show whether that choice sits near the inertia elbow
        {best ? ` (silhouette peaks at K = ${best.k}, ${fmt(best.silhouette, 3)})` : ""}.
      </p>
    </div>
  );
}
