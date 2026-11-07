/**
 * Sparkline: a tiny, axis-free line for inline context (table cells, cards). Decorative by
 * default (`aria-hidden`) — the surrounding text or table carries the values; pass `label`
 * to make it an image with an accessible name. Missing values break the line.
 * @param {{points: {x: number, y: number}[], width?: number, height?: number, color?: string,
 *          xDomain?: [number, number], yDomain?: [number, number], dashed?: boolean,
 *          highlightX?: number|null, label?: string, className?: string}} props
 */
import { CHART, linePath, linearScale, niceDomain } from "./chartTheme.js";

export function Sparkline({ points = [], width = 96, height = 24, color = CHART.ink, xDomain, yDomain, dashed = false, highlightX = null, label, className }) {
  const xs = points.map((p) => p.x).filter(Number.isFinite);
  const xd = xDomain ?? [Math.min(...xs), Math.max(...xs)];
  const yd = yDomain ?? niceDomain(points.map((p) => p.y), { pad: 0.1, minSpan: 0.5 });
  const x = linearScale(xd, [2, width - 2]);
  const y = linearScale(yd, [height - 2, 2]);
  const hp = highlightX !== null ? points.find((p) => p.x === highlightX && Number.isFinite(p.y)) : null;
  return (
    <svg width={width} height={height} className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      <path d={linePath(points, x, y)} fill="none" stroke={color} strokeWidth={1.25} strokeDasharray={dashed ? "2 2" : undefined} strokeLinecap="round" />
      {hp && <circle cx={x(hp.x)} cy={y(hp.y)} r={2.5} fill={color} stroke={CHART.surface} strokeWidth={1} />}
    </svg>
  );
}

export default Sparkline;
