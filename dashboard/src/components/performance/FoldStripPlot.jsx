/**
 * Per-fold strip plot: every held-out fold's score as a ringed dot, placed in the same
 * model × scheme slots as the grouped bars above so the two charts read as one figure.
 * A short 2 px tick marks the fold mean. Folds are spread horizontally by a deterministic
 * offset (fold index), never random jitter, so the plot is stable across renders.
 *
 * Hover uses a nearest-point search (24 px radius) so readers never have to land on an
 * 8 px dot. A collapsible table lists every fold value for keyboard / screen-reader users.
 */
import { useMemo, useRef, useState } from "react";
import { fmt, fmtInt, isNum } from "../../lib/format.js";
import { CHART, groupedBandLayout, localPointer, nearestPointIndex, useElementWidth, zeroBasedLinear } from "./chartKit.js";
import { ChartTooltip, TooltipRow } from "./ChartTooltip.jsx";
import { XBandLabels, YAxisGrid } from "./SvgAxes.jsx";
import { modelLabel, schemeMeta } from "./perfModel.js";

const MARGIN = Object.freeze({ top: 18, right: 12, bottom: 34, left: 52 });
const DOT_R = 4;

function foldOffset(fold, nFolds, slotWidth) {
  if (nFolds <= 1) return 0;
  const spread = Math.min(slotWidth - DOT_R * 2 - 2, 18);
  return ((fold % nFolds) / (nFolds - 1) - 0.5) * Math.max(0, spread);
}

/**
 * @param {{points: {model: string, scheme: string, fold: number, value: number, nTest: number|null,
 *          device: string|null}[], models: string[], schemes: string[], metric: object,
 *          means: Record<string, number|null>, height?: number}} props
 *   `means` maps "scheme|model" -> fold mean (for the mean tick).
 */
export function FoldStripPlot({ points, models, schemes, metric, means, height = 240 }) {
  const containerRef = useRef(null);
  const width = useElementWidth(containerRef);
  const [hoverIndex, setHoverIndex] = useState(-1);

  const innerW = Math.max(60, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const layout = useMemo(() => groupedBandLayout(models, schemes.length, innerW), [models, schemes.length, innerW]);
  const y = useMemo(() => {
    const values = points.map((p) => p.value);
    // Strip plots show spread: pad the observed range instead of forcing a zero baseline.
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return zeroBasedLinear([], [innerH, 0]);
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    return zeroBasedLinear([], [innerH, 0]).domain([lo - pad, hi + pad]).nice(5);
  }, [points, innerH]);

  const placed = useMemo(() => {
    const foldsPerSlot = new Map();
    for (const p of points) {
      const k = `${p.scheme}|${p.model}`;
      foldsPerSlot.set(k, (foldsPerSlot.get(k) ?? 0) + 1);
    }
    return points
      .filter((p) => models.includes(p.model) && schemes.includes(p.scheme))
      .map((p) => {
        const j = schemes.indexOf(p.scheme);
        const n = foldsPerSlot.get(`${p.scheme}|${p.model}`) ?? 1;
        return {
          ...p,
          px: MARGIN.left + layout.center(p.model, j) + foldOffset(Number(p.fold) || 0, n, layout.slotWidth),
          py: MARGIN.top + y(p.value),
        };
      });
  }, [points, models, schemes, layout, y]);

  const hovered = hoverIndex >= 0 ? placed[hoverIndex] : null;

  const onPointerMove = (event) => {
    const { x, y: py } = localPointer(event, event.currentTarget);
    setHoverIndex(nearestPointIndex(placed, x, py));
  };

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="relative w-full">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Per-fold ${metric.label} by model and scheme; ${placed.length} folds. The table below lists every value.`}
          className="block overflow-visible"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverIndex(-1)}
        >
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            <YAxisGrid scale={y} width={innerW} label={metric.unit || undefined} />
            {models.map((model) =>
              schemes.map((scheme, j) => {
                const mean = means[`${scheme}|${model}`];
                if (!isNum(mean)) return null;
                const cx = layout.center(model, j);
                const half = Math.min(layout.slotWidth / 2 - 1, 12);
                return (
                  <line
                    key={`${scheme}|${model}`}
                    x1={cx - half}
                    x2={cx + half}
                    y1={y(mean)}
                    y2={y(mean)}
                    stroke={schemeMeta(scheme).color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    opacity={0.55}
                  />
                );
              }),
            )}
            <XBandLabels scale={layout.outer} y={innerH + 20} labelFor={(m) => modelLabel(m, layout.outer.bandwidth() < 84)} />
          </g>
          {placed.map((p, i) => (
            <circle
              key={`${p.scheme}|${p.model}|${p.fold}|${i}`}
              cx={p.px}
              cy={p.py}
              r={i === hoverIndex ? DOT_R + 1.5 : DOT_R}
              fill={schemeMeta(p.scheme).color}
              stroke={CHART.surface}
              strokeWidth={2}
              opacity={hoverIndex >= 0 && i !== hoverIndex ? 0.55 : 1}
            />
          ))}
        </svg>
        {hovered && (
          <ChartTooltip
            x={hovered.px}
            y={hovered.py}
            containerWidth={width}
            title={`${modelLabel(hovered.model)} · fold ${hovered.fold}`}
          >
            <TooltipRow
              color={schemeMeta(hovered.scheme).color}
              keyShape="dot"
              value={`${fmt(hovered.value, metric.dp)}${metric.unit ? ` ${metric.unit}` : ""}`}
              label={`${metric.label} · ${schemeMeta(hovered.scheme).label}`}
            />
            <TooltipRow value={fmtInt(hovered.nTest)} label="test cells" />
            {hovered.device && <TooltipRow value={hovered.device} label="device" />}
          </ChartTooltip>
        )}
      </div>
      <FoldTable points={placed} metric={metric} />
    </div>
  );
}

/** Collapsible table twin of the strip plot. */
function FoldTable({ points, metric }) {
  if (!points.length) return null;
  const sorted = [...points].sort(
    (a, b) => a.scheme.localeCompare(b.scheme) || a.model.localeCompare(b.model) || Number(a.fold) - Number(b.fold),
  );
  return (
    <details className="group rounded-lg border border-panel-border bg-bg-raised/40 text-xs">
      <summary className="focus-ring cursor-pointer select-none rounded-lg px-3 py-2 text-ink-muted hover:text-ink">
        Per-fold values ({points.length})
      </summary>
      <div className="scrollbar-thin max-h-64 overflow-auto px-3 pb-3">
        <table className="w-full text-left">
          <caption className="sr-only">Per-fold {metric.label} for every model and validation scheme</caption>
          <thead className="sticky top-0 bg-bg-raised text-[11px] uppercase tracking-wider text-ink-faint">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">Scheme</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Model</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Fold</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">{metric.label}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">Test cells</th>
              <th scope="col" className="py-1.5 font-medium">Device</th>
            </tr>
          </thead>
          <tbody className="kpi-number font-mono text-ink">
            {sorted.map((p, i) => (
              <tr key={`${p.scheme}|${p.model}|${p.fold}|${i}`} className="border-t border-panel-border/60">
                <td className="py-1 pr-3 font-sans">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: schemeMeta(p.scheme).color }} />
                    {schemeMeta(p.scheme).label}
                  </span>
                </td>
                <td className="py-1 pr-3 font-sans">{modelLabel(p.model)}</td>
                <td className="py-1 pr-3">{p.fold}</td>
                <td className="py-1 pr-3 text-right">{fmt(p.value, metric.dp)}</td>
                <td className="py-1 pr-3 text-right">{fmtInt(p.nTest)}</td>
                <td className="py-1 text-ink-muted">{p.device ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
