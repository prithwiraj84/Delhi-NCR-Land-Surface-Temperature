/**
 * Grouped bar chart: one group per model, one bar per validation scheme, ±1 SD whiskers
 * across folds. Bars grow from the zero baseline (R² can be negative for weak models under
 * spatial CV), carry a 4 px rounded data-end and are separated by 2 px surface gaps.
 *
 * Interaction: each model group is the hit target (hover or keyboard focus) and shows ONE
 * tooltip listing every scheme; the other groups recede. Only the best spatial-CV bar is
 * direct-labelled - the table below carries every value.
 */
import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { fmt, isNum } from "../../lib/format.js";
import { CHART, groupedBandLayout, useElementWidth, verticalBarPath, zeroBasedLinear } from "./chartKit.js";
import { ChartTooltip, TooltipRow } from "./ChartTooltip.jsx";
import { XBandLabels, YAxisGrid } from "./SvgAxes.jsx";
import { modelLabel, schemeMeta } from "./perfModel.js";

const MARGIN = Object.freeze({ top: 22, right: 12, bottom: 34, left: 52 });

function extentValues(rows, schemes) {
  const values = [];
  for (const row of rows) {
    for (const s of schemes) {
      const { mean, sd } = row.values[s] ?? {};
      if (!isNum(mean)) continue;
      values.push(mean);
      if (isNum(sd)) values.push(mean - sd, mean + sd);
    }
  }
  return values;
}

function describeGroup(row, schemes, metric) {
  const parts = schemes.map((s) => {
    const { mean, sd } = row.values[s] ?? {};
    return `${schemeMeta(s).label} ${fmt(mean, metric.dp)}${isNum(sd) ? ` plus or minus ${fmt(sd, metric.dp)}` : ""}`;
  });
  return `${modelLabel(row.model)} ${metric.label}: ${parts.join(", ")}`;
}

/**
 * @param {{rows: {model: string, values: Record<string, {mean: number|null, sd: number|null}>}[],
 *          schemes: string[], metric: {key: string, label: string, unit: string, dp: number, better: string},
 *          bestByScheme: Record<string, string|null>, labelScheme?: string, height?: number}} props
 */
export function GroupedBarChart({ rows, schemes, metric, bestByScheme, labelScheme = "spatial", height = 300 }) {
  const containerRef = useRef(null);
  const width = useElementWidth(containerRef);
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState(null);

  const innerW = Math.max(60, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const models = useMemo(() => rows.map((r) => r.model), [rows]);
  const layout = useMemo(() => groupedBandLayout(models, schemes.length, innerW), [models, schemes.length, innerW]);
  const y = useMemo(() => zeroBasedLinear(extentValues(rows, schemes), [innerH, 0]), [rows, schemes, innerH]);
  const y0 = y(0);
  const useShort = layout.outer.bandwidth() < 84;
  const labelModel = bestByScheme?.[labelScheme] ?? null;

  const activeRow = rows.find((r) => r.model === active) ?? null;
  const tooltipX = activeRow ? MARGIN.left + (layout.outer(activeRow.model) ?? 0) + layout.outer.bandwidth() / 2 : 0;

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="group"
        aria-label={`${metric.label} by model and validation scheme, mean with one standard deviation across folds`}
        className="block overflow-visible"
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          <YAxisGrid scale={y} width={innerW} label={metric.unit || undefined} />
          {rows.map((row) => {
            const bandX = layout.outer(row.model) ?? 0;
            const step = layout.outer.step();
            const isActive = active === row.model;
            const dimmed = active !== null && !isActive;
            return (
              <g
                key={row.model}
                tabIndex={0}
                role="img"
                aria-label={describeGroup(row, schemes, metric)}
                onPointerEnter={() => setActive(row.model)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(row.model)}
                onBlur={() => setActive(null)}
                style={{ outline: "none", cursor: "default" }}
              >
                <rect
                  x={bandX - (step - layout.outer.bandwidth()) / 2}
                  y={-MARGIN.top + 4}
                  width={step}
                  height={innerH + MARGIN.top - 4}
                  rx={6}
                  fill={isActive ? "rgba(148,163,184,0.07)" : "transparent"}
                  stroke={isActive ? "rgba(34,211,238,0.35)" : "none"}
                />
                <g opacity={dimmed ? 0.4 : 1} style={{ transition: "opacity 150ms ease-out" }}>
                  {schemes.map((scheme, j) => {
                    const { mean, sd } = row.values[scheme] ?? {};
                    if (!isNum(mean)) return null;
                    const cx = layout.center(row.model, j);
                    const yv = y(mean);
                    const color = schemeMeta(scheme).color;
                    return (
                      <g key={scheme}>
                        <motion.path
                          key={`${metric.key}-${scheme}`}
                          d={verticalBarPath(cx - layout.barWidth / 2, layout.barWidth, y0, yv)}
                          fill={color}
                          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
                          animate={{ scaleY: 1, opacity: 1 }}
                          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: j * 0.05 }}
                          style={{ originY: mean >= 0 ? 1 : 0 }}
                        />
                        {isNum(sd) && sd > 0 && (
                          <g stroke={CHART.whisker} strokeWidth={1.25} opacity={0.85}>
                            <line x1={cx} x2={cx} y1={y(mean - sd)} y2={y(mean + sd)} />
                            <line x1={cx - 4} x2={cx + 4} y1={y(mean + sd)} y2={y(mean + sd)} />
                            <line x1={cx - 4} x2={cx + 4} y1={y(mean - sd)} y2={y(mean - sd)} />
                          </g>
                        )}
                        {scheme === labelScheme && row.model === labelModel && (
                          <text
                            x={cx}
                            y={(mean >= 0 ? y(mean + (isNum(sd) ? sd : 0)) - 6 : y(mean - (isNum(sd) ? sd : 0)) + 13)}
                            textAnchor="middle"
                            fill={CHART.strongText}
                            fontSize={10.5}
                            fontWeight={600}
                            fontFamily={CHART.fontMono}
                          >
                            {fmt(mean, metric.dp)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </g>
            );
          })}
          <XBandLabels
            scale={layout.outer}
            y={innerH + 20}
            labelFor={(m) => modelLabel(m, useShort)}
            activeCategory={active}
          />
        </g>
      </svg>
      {activeRow && (
        <ChartTooltip
          x={tooltipX}
          y={MARGIN.top + innerH / 2}
          containerWidth={width}
          title={`${modelLabel(activeRow.model)} · ${metric.label}${metric.unit ? ` (${metric.unit})` : ""}`}
        >
          {schemes.map((scheme) => {
            const { mean, sd } = activeRow.values[scheme] ?? {};
            const best = bestByScheme?.[scheme] === activeRow.model;
            return (
              <TooltipRow
                key={scheme}
                color={schemeMeta(scheme).color}
                value={`${fmt(mean, metric.dp)}${isNum(sd) ? ` ± ${fmt(sd, metric.dp)}` : ""}`}
                label={`${schemeMeta(scheme).label}${best ? " · best" : ""}`}
              />
            );
          })}
        </ChartTooltip>
      )}
    </div>
  );
}
