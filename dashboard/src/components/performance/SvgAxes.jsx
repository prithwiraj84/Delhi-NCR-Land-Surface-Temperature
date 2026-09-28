/**
 * Recessive SVG axis chrome: hairline solid gridlines one step off the surface, a stronger
 * zero baseline, and muted tabular tick labels. Shared by the hand-built charts.
 */
import { CHART, tickFormatter } from "./chartKit.js";

/**
 * Horizontal gridlines + left tick labels for a linear y scale.
 * @param {{scale: import("d3-scale").ScaleLinear<number, number>, width: number,
 *          format?: (v: number) => string, ticks?: number, label?: string}} props
 *   `format` defaults to a precision-aware formatter derived from the tick step.
 */
export function YAxisGrid({ scale, width, format, ticks = 5, label }) {
  const formatTick = format ?? tickFormatter(scale, ticks);
  const values = scale.ticks(ticks);
  const [d0, d1] = scale.domain();
  const showZero = d0 < 0 && d1 > 0;
  return (
    <g aria-hidden="true">
      {values.map((v) => (
        <g key={v} transform={`translate(0,${scale(v)})`}>
          <line x1={0} x2={width} stroke={v === 0 ? CHART.baseline : CHART.grid} strokeWidth={1} shapeRendering="crispEdges" />
          <text
            x={-8}
            dy="0.32em"
            textAnchor="end"
            fill={CHART.axisText}
            fontSize={10.5}
            fontFamily={CHART.fontMono}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {formatTick(v)}
          </text>
        </g>
      ))}
      {showZero && !values.includes(0) && (
        <line x1={0} x2={width} y1={scale(0)} y2={scale(0)} stroke={CHART.baseline} strokeWidth={1} shapeRendering="crispEdges" />
      )}
      {label && (
        <text
          x={-8}
          y={scale.range()[1] - 10}
          textAnchor="end"
          fill={CHART.faintText}
          fontSize={10}
          fontFamily={CHART.fontSans}
        >
          {label}
        </text>
      )}
    </g>
  );
}

/**
 * Category labels centred under each band of a d3 band scale.
 * @param {{scale: import("d3-scale").ScaleBand<string>, y: number, labelFor: (c: string) => string,
 *          activeCategory?: string|null}} props
 */
export function XBandLabels({ scale, y, labelFor, activeCategory = null }) {
  return (
    <g aria-hidden="true">
      {scale.domain().map((c) => (
        <text
          key={c}
          x={(scale(c) ?? 0) + scale.bandwidth() / 2}
          y={y}
          textAnchor="middle"
          fill={c === activeCategory ? CHART.strongText : CHART.axisText}
          fontSize={11}
          fontWeight={c === activeCategory ? 600 : 400}
          fontFamily={CHART.fontSans}
        >
          {labelFor(c)}
        </text>
      ))}
    </g>
  );
}
