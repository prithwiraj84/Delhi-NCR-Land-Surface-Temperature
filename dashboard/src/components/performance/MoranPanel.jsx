/**
 * Spatial autocorrelation of out-of-fold residuals.
 *
 * Left: residual Moran's I by model for one scheme/epoch as horizontal bars from zero, with
 * the target's own Moran's I (how clustered LST itself is) as a dashed reference line and
 * each bar direct-labelled with I and its permutation p-value. A good model shrinks I from
 * the target's level towards E[I] ≈ −1/(n−1) ≈ 0.
 *
 * Right: the "spatial residual dispersion plot" - a Moran scatter of the standardised
 * residual z against its spatial lag Wz (row-standardised KNN weights). The least-squares
 * slope through the origin of Wz on z IS Moran's I, drawn as the fitted line. Quadrants are
 * shaded LISA-style: HH (under-predicted cells among under-predicted neighbours - a hot
 * error cluster), LL (cool error cluster), HL / LH (spatial outliers).
 */
import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { scaleBand, scaleLinear } from "d3-scale";
import { quantileSorted } from "d3-array";
import { THEME } from "../../lib/colors.js";
import { fmt, isNum } from "../../lib/format.js";
import { Select } from "../ui/Select.jsx";
import SegmentedToggle from "../shap/SegmentedToggle.jsx";
import {
  CHART,
  horizontalBarPath,
  localPointer,
  nearestPointIndex,
  tickFormatter,
  useElementWidth,
} from "./chartKit.js";
import { ChartLegend, ChartTooltip, TooltipRow } from "./ChartTooltip.jsx";
import {
  ALPHA,
  formatP,
  listModels,
  listSchemes,
  modelLabel,
  moranRows,
  moranScatterData,
  moranTargetFor,
  moranYears,
  scatterModels,
  schemeMeta,
} from "./perfModel.js";

// ---------------------------------------------------------------------------------------
// Residual Moran's I bars
// ---------------------------------------------------------------------------------------

const BAR_MARGIN = Object.freeze({ top: 26, right: 112, bottom: 26, left: 96 });
const ROW_H = 30;

/**
 * @param {{rows: {model: string, I: number|null, p: number|null, z: number|null}[],
 *          target: {I: number|null, p: number|null}|null, color: string, scheme: string, year: number}} props
 */
export function MoranBars({ rows, target, color, scheme, year }) {
  const containerRef = useRef(null);
  const width = useElementWidth(containerRef, 480);
  const reduceMotion = useReducedMotion();
  const finiteRows = useMemo(() => rows.filter((r) => isNum(r.I)), [rows]);
  const innerW = Math.max(80, width - BAR_MARGIN.left - BAR_MARGIN.right);
  const innerH = Math.max(ROW_H, finiteRows.length * ROW_H);
  const height = innerH + BAR_MARGIN.top + BAR_MARGIN.bottom;

  const x = useMemo(() => {
    const values = [0, ...finiteRows.map((r) => r.I)];
    if (target && isNum(target.I)) values.push(target.I);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return scaleLinear()
      .domain(lo === hi ? [lo, lo + 0.1] : [lo, hi])
      .nice(5)
      .range([0, innerW]);
  }, [finiteRows, target, innerW]);
  const y = useMemo(
    () => scaleBand().domain(finiteRows.map((r) => r.model)).range([0, innerH]).paddingInner(0.35).paddingOuter(0.2),
    [finiteRows, innerH],
  );
  const barH = Math.min(CHART.maxBar - 6, y.bandwidth());
  const x0 = x(0);
  // ~70 px per tick label keeps the axis legible at phone width.
  const tickCount = Math.max(2, Math.min(6, Math.floor(innerW / 70)));
  const ticks = x.ticks(tickCount);
  const formatTick = tickFormatter(x, tickCount);
  // Narrow screens keep only the significance star beside each bar (p-values stay in the aria-label).
  const showP = innerW >= 300;
  const targetX = target && isNum(target.I) ? x(target.I) : null;

  if (!finiteRows.length) {
    return <p className="py-8 text-center text-xs text-ink-muted">No residual Moran&apos;s I for this scheme and epoch.</p>;
  }

  return (
    <div ref={containerRef} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={
          `Residual Moran's I by model, ${schemeMeta(scheme).long} CV, ${year}. ` +
          finiteRows.map((r) => `${modelLabel(r.model)} ${fmt(r.I, 3)}, ${formatP(r.p)}`).join("; ") +
          (targetX !== null ? `. Target LST Moran's I ${fmt(target.I, 3)}.` : ".")
        }
        className="block overflow-visible"
      >
        <g transform={`translate(${BAR_MARGIN.left},${BAR_MARGIN.top})`}>
          {ticks.map((t) => (
            <g key={t} transform={`translate(${x(t)},0)`} aria-hidden="true">
              <line y1={0} y2={innerH} stroke={t === 0 ? CHART.baseline : CHART.grid} shapeRendering="crispEdges" />
              <text
                y={innerH + 16}
                textAnchor="middle"
                fill={CHART.axisText}
                fontSize={10.5}
                fontFamily={CHART.fontMono}
              >
                {formatTick(t)}
              </text>
            </g>
          ))}
          {!ticks.includes(0) && <line x1={x0} x2={x0} y1={0} y2={innerH} stroke={CHART.baseline} />}
          {targetX !== null && (
            <g aria-hidden="true">
              <line
                x1={targetX}
                x2={targetX}
                y1={-8}
                y2={innerH}
                stroke={THEME.ink}
                strokeOpacity={0.85}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <text
                x={targetX}
                y={-12}
                textAnchor={targetX > innerW * 0.7 ? "end" : "middle"}
                fill={THEME.ink}
                fontSize={10.5}
                fontFamily={CHART.fontSans}
              >
                LST itself · I = {fmt(target.I, 2)}
              </text>
            </g>
          )}
          {finiteRows.map((r, i) => {
            const yy = (y(r.model) ?? 0) + (y.bandwidth() - barH) / 2;
            const significant = isNum(r.p) && r.p < ALPHA;
            const end = x(r.I);
            const labelX = Math.max(end, x0) + 8;
            const pText = showP ? `  ${formatP(r.p)}${significant ? " *" : ""}` : significant ? " *" : "";
            // Monospace label: ~0.62 em per character. The backing rect masks the dashed
            // "LST itself" line where it would otherwise run through the gaps between words.
            const labelW = (fmt(r.I, 3).length + pText.length) * 10.5 * 0.62;
            return (
              <g key={r.model}>
                <text
                  x={-10}
                  y={yy + barH / 2}
                  dy="0.32em"
                  textAnchor="end"
                  fill={CHART.axisText}
                  fontSize={11}
                  fontFamily={CHART.fontSans}
                >
                  {modelLabel(r.model)}
                </text>
                <motion.path
                  key={`${scheme}-${year}-${r.model}`}
                  d={horizontalBarPath(yy, barH, x0, end)}
                  fill={color}
                  fillOpacity={significant ? 1 : 0.55}
                  initial={reduceMotion ? false : { scaleX: 0, opacity: 0 }}
                  animate={{ scaleX: 1, opacity: 1 }}
                  transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: i * 0.04 }}
                  style={{ originX: r.I >= 0 ? 0 : 1 }}
                />
                <rect
                  x={labelX - 3}
                  y={yy + barH / 2 - 8}
                  width={labelW + 6}
                  height={16}
                  rx={3}
                  fill={CHART.surface}
                  fillOpacity={0.92}
                  aria-hidden="true"
                />
                <text
                  x={labelX}
                  y={yy + barH / 2}
                  dy="0.32em"
                  fill={significant ? CHART.strongText : CHART.axisText}
                  fontSize={10.5}
                  fontWeight={significant ? 600 : 400}
                  fontFamily={CHART.fontMono}
                  stroke={CHART.surface}
                  strokeWidth={3}
                  paintOrder="stroke"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {fmt(r.I, 3)}
                  <tspan fill={CHART.axisText} fontWeight={400}>
                    {pText}
                  </tspan>
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Moran scatter ("spatial residual dispersion plot")
// ---------------------------------------------------------------------------------------

const SC_MARGIN = Object.freeze({ top: 14, right: 16, bottom: 40, left: 48 });

const QUADRANTS = Object.freeze({
  HH: { label: "HH", fill: "rgba(251,113,133,0.10)", meaning: "under-predicted among under-predicted neighbours" },
  LL: { label: "LL", fill: "rgba(34,211,238,0.10)", meaning: "over-predicted among over-predicted neighbours" },
  HL: { label: "HL", fill: "rgba(148,163,184,0.05)", meaning: "under-predicted outlier among over-predicted neighbours" },
  LH: { label: "LH", fill: "rgba(148,163,184,0.05)", meaning: "over-predicted outlier among under-predicted neighbours" },
});

/** Symmetric half-range from the 99.5th percentile of |values| (robust to a few outliers). */
function robustHalfRange(values) {
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  const q = quantileSorted(abs, 0.995) ?? 1;
  return Math.max(0.5, q * 1.1);
}

/** @param {{data: ReturnType<typeof moranScatterData>, model: string}} props */
export function MoranScatter({ data, model }) {
  const containerRef = useRef(null);
  const width = useElementWidth(containerRef, 480);
  const [hover, setHover] = useState(-1);
  const height = Math.max(260, Math.min(360, Math.round(width * 0.72)));
  const innerW = Math.max(80, width - SC_MARGIN.left - SC_MARGIN.right);
  const innerH = height - SC_MARGIN.top - SC_MARGIN.bottom;

  const { x, y, placed } = useMemo(() => {
    const mz = robustHalfRange(data.points.map((p) => p.z));
    const ml = robustHalfRange(data.points.map((p) => p.lag));
    const xs = scaleLinear().domain([-mz, mz]).range([0, innerW]).nice(4);
    const ys = scaleLinear().domain([-ml, ml]).range([innerH, 0]).nice(4);
    const [x0, x1] = xs.domain();
    const [y0, y1] = ys.domain();
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      x: xs,
      y: ys,
      placed: data.points.map((p) => {
        const clipped = p.z < x0 || p.z > x1 || p.lag < y0 || p.lag > y1;
        return {
          ...p,
          clipped,
          px: SC_MARGIN.left + xs(clamp(p.z, x0, x1)),
          py: SC_MARGIN.top + ys(clamp(p.lag, y0, y1)),
        };
      }),
    };
  }, [data, innerW, innerH]);

  const [dx0, dx1] = x.domain();
  const cx = x(0);
  const cy = y(0);
  const slope = data.slope;
  const total = data.points.length;
  const hovered = hover >= 0 ? placed[hover] : null;
  const pct = (n) => `${fmt((n / total) * 100, 0)}%`;
  const clipId = `moran-clip-${model}`;

  const onPointerMove = (event) => {
    const { x: px, y: py } = localPointer(event, event.currentTarget);
    setHover(nearestPointIndex(placed, px, py, 18));
  };

  const quadrantLabel = (q, qx, qy, anchor) => (
    <text
      x={qx}
      y={qy}
      textAnchor={anchor}
      fill={CHART.axisText}
      fontSize={10.5}
      fontFamily={CHART.fontMono}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      <tspan fontWeight={600} fill={CHART.strongText}>
        {q}
      </tspan>
      {` ${pct(data.counts[q])}`}
    </text>
  );

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="relative w-full">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={
            `Moran scatter of ${modelLabel(model)} spatial-CV residuals${data.year ? ` in ${data.year}` : ""}: ` +
            `${total} sampled cells, slope (Moran's I) ${fmt(slope, 3)}. ` +
            `Quadrant shares HH ${pct(data.counts.HH)}, LL ${pct(data.counts.LL)}, HL ${pct(data.counts.HL)}, LH ${pct(data.counts.LH)}.`
          }
          className="block overflow-visible"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(-1)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={innerW} height={innerH} />
            </clipPath>
          </defs>
          <g transform={`translate(${SC_MARGIN.left},${SC_MARGIN.top})`}>
            {/* quadrant shading */}
            <g aria-hidden="true">
              <rect x={cx} y={0} width={innerW - cx} height={cy} fill={QUADRANTS.HH.fill} />
              <rect x={0} y={cy} width={cx} height={innerH - cy} fill={QUADRANTS.LL.fill} />
              <rect x={cx} y={cy} width={innerW - cx} height={innerH - cy} fill={QUADRANTS.HL.fill} />
              <rect x={0} y={0} width={cx} height={cy} fill={QUADRANTS.LH.fill} />
            </g>
            {/* grid + axes */}
            <g aria-hidden="true">
              {x.ticks(5).map((t) => (
                <g key={`x${t}`} transform={`translate(${x(t)},0)`}>
                  <line y1={0} y2={innerH} stroke={t === 0 ? CHART.baseline : CHART.grid} shapeRendering="crispEdges" />
                  <text y={innerH + 15} textAnchor="middle" fill={CHART.axisText} fontSize={10.5} fontFamily={CHART.fontMono}>
                    {tickFormatter(x, 5)(t)}
                  </text>
                </g>
              ))}
              {y.ticks(5).map((t) => (
                <g key={`y${t}`} transform={`translate(0,${y(t)})`}>
                  <line x1={0} x2={innerW} stroke={t === 0 ? CHART.baseline : CHART.grid} shapeRendering="crispEdges" />
                  <text x={-8} dy="0.32em" textAnchor="end" fill={CHART.axisText} fontSize={10.5} fontFamily={CHART.fontMono}>
                    {tickFormatter(y, 5)(t)}
                  </text>
                </g>
              ))}
              <text x={innerW / 2} y={innerH + 32} textAnchor="middle" fill={CHART.faintText} fontSize={10.5} fontFamily={CHART.fontSans}>
                standardised residual z (observed − predicted)
              </text>
              <text
                transform={`translate(${-36},${innerH / 2}) rotate(-90)`}
                textAnchor="middle"
                fill={CHART.faintText}
                fontSize={10.5}
                fontFamily={CHART.fontSans}
              >
                spatial lag Wz
              </text>
              {quadrantLabel("HH", innerW - 6, 14, "end")}
              {quadrantLabel("LH", 6, 14, "start")}
              {quadrantLabel("LL", 6, innerH - 8, "start")}
              {quadrantLabel("HL", innerW - 6, innerH - 8, "end")}
            </g>
          </g>
          {/* points (absolute coordinates so hit-testing matches the pointer) */}
          <g aria-hidden="true">
            {placed.map((p, i) => (
              <circle
                key={i}
                cx={p.px}
                cy={p.py}
                r={2.25}
                fill={p.clipped ? THEME.inkFaint : "#cbd5e1"}
                fillOpacity={hover >= 0 ? 0.25 : 0.45}
              />
            ))}
          </g>
          {/* fitted line: Wz = I · z */}
          {isNum(slope) && (
            <g transform={`translate(${SC_MARGIN.left},${SC_MARGIN.top})`} clipPath={`url(#${clipId})`} aria-hidden="true">
              <line
                x1={x(dx0)}
                y1={y(slope * dx0)}
                x2={x(dx1)}
                y2={y(slope * dx1)}
                stroke={CHART.surface}
                strokeWidth={5}
                strokeLinecap="round"
              />
              <line
                x1={x(dx0)}
                y1={y(slope * dx0)}
                x2={x(dx1)}
                y2={y(slope * dx1)}
                stroke={THEME.cyan}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </g>
          )}
          {hovered && (
            <circle
              cx={hovered.px}
              cy={hovered.py}
              r={5}
              fill={THEME.inkStrong}
              stroke={CHART.surface}
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
        </svg>
        {hovered && (
          <ChartTooltip x={hovered.px} y={hovered.py} containerWidth={width} title={`${QUADRANTS[hovered.q].label} quadrant`} width={236}>
            <TooltipRow value={fmt(hovered.z, 2)} label="residual z" />
            <TooltipRow value={fmt(hovered.lag, 2)} label="neighbour mean (Wz)" />
            <p className="pt-0.5 text-[11px] leading-snug text-ink-muted">{QUADRANTS[hovered.q].meaning}</p>
            {hovered.clipped && <p className="text-[11px] text-ink-faint">outside the plotted range (pinned to the edge)</p>}
          </ChartTooltip>
        )}
      </div>
      <ChartLegend
        label="Moran scatter legend"
        items={[
          { key: "pts", label: `sampled cells (${total})`, color: "#cbd5e1", shape: "dot" },
          { key: "slope", label: `slope = Moran's I = ${fmt(slope, 3)}`, color: THEME.cyan, shape: "line" },
          { key: "hh", label: "HH hot error cluster", color: "rgba(251,113,133,0.55)", shape: "rect" },
          { key: "ll", label: "LL cool error cluster", color: "rgba(34,211,238,0.55)", shape: "rect" },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------

/** Schemes that actually have residual Moran rows, in canonical order. */
function moranSchemes(metrics) {
  const present = new Set((metrics?.moran ?? []).map((r) => r?.scheme).filter(Boolean));
  return listSchemes(metrics).filter((s) => present.has(s));
}

/** @param {{metrics: object}} props */
export function MoranPanel({ metrics }) {
  const schemes = useMemo(() => moranSchemes(metrics), [metrics]);
  const [schemeChoice, setSchemeChoice] = useState("spatial");
  const scheme = schemes.includes(schemeChoice) ? schemeChoice : (schemes[0] ?? "spatial");

  const years = useMemo(() => moranYears(metrics?.moran, scheme), [metrics, scheme]);
  const [yearChoice, setYearChoice] = useState(null);
  const year = years.includes(yearChoice) ? yearChoice : (years[years.length - 1] ?? null);

  const models = useMemo(() => listModels(metrics), [metrics]);
  const rows = useMemo(
    () => (year === null ? [] : moranRows(metrics?.moran, scheme, year, models)),
    [metrics, scheme, year, models],
  );
  const target = year === null ? null : moranTargetFor(metrics?.moran_target, year);

  const sModels = useMemo(() => scatterModels(metrics), [metrics]);
  const [modelChoice, setModelChoice] = useState("xgboost");
  const scatterModel = sModels.includes(modelChoice) ? modelChoice : (sModels[0] ?? null);
  const scatter = useMemo(() => (scatterModel ? moranScatterData(metrics, scatterModel) : null), [metrics, scatterModel]);
  const scatterRow = scatter
    ? moranRows(metrics?.moran, "spatial", scatter.year, models).find((r) => r.model === scatterModel)
    : null;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 className="font-display text-sm font-semibold text-ink-strong">Residual Moran&apos;s I by model</h4>
            <p className="text-[11px] text-ink-faint">
              bar = I of out-of-fold residuals · * and solid = significant (p &lt; {ALPHA}) · dashed = LST itself
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {schemes.length > 1 && (
              <SegmentedToggle
                label="Validation scheme for residual Moran's I"
                options={schemes.map((s) => ({ value: s, label: schemeMeta(s).label, dot: schemeMeta(s).color }))}
                value={scheme}
                onChange={(v) => {
                  setSchemeChoice(v);
                  setYearChoice(null);
                }}
                layoutId="perf-moran-scheme"
              />
            )}
            {years.length > 0 && (
              <Select
                label="Epoch"
                size="sm"
                value={year ?? ""}
                onValueChange={(v) => setYearChoice(Number(v))}
                options={years.map((yv) => ({ value: yv, label: String(yv) }))}
                className="w-24"
              />
            )}
          </div>
        </div>
        {year === null ? (
          <p className="py-8 text-center text-xs text-ink-muted">No residual Moran&apos;s I was exported.</p>
        ) : (
          <MoranBars rows={rows} target={target} color={schemeMeta(scheme).color} scheme={scheme} year={year} />
        )}
        {target && (
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Target LST in {year}: I = <span className="font-mono text-ink">{fmt(target.I, 3)}</span> ({formatP(target.p)}, z ={" "}
            <span className="font-mono text-ink">{fmt(target.z, 1)}</span>). Residual I near{" "}
            <span className="font-mono text-ink">0</span> means the model has absorbed the spatial structure.
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 className="font-display text-sm font-semibold text-ink-strong">Spatial residual dispersion</h4>
            <p className="text-[11px] text-ink-faint">
              Moran scatter · spatial CV{scatter?.year ? ` · ${scatter.year}` : ""}
              {scatterRow && isNum(scatterRow.p) ? ` · ${formatP(scatterRow.p)}` : ""}
            </p>
          </div>
          {sModels.length > 0 && (
            <Select
              label="Model"
              size="sm"
              value={scatterModel ?? ""}
              onValueChange={setModelChoice}
              options={sModels.map((m) => ({ value: m, label: modelLabel(m) }))}
              className="w-40"
            />
          )}
        </div>
        {scatter ? (
          <MoranScatter data={scatter} model={scatterModel} />
        ) : (
          <p className="py-8 text-center text-xs text-ink-muted">No Moran scatter sample was exported.</p>
        )}
      </div>
    </div>
  );
}
