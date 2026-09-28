/**
 * SHAP dependence plot for one feature (Recharts 2 ComposedChart).
 *
 * Layers, back to front:
 *   1. CI shading of each threshold (ReferenceArea, clipped to the plot),
 *   2. zero reference line (the "no effect" baseline),
 *   3. scatter sample of per-cell SHAP values (colour = interaction partner or zone),
 *   4. 95 % bootstrap band of the binned mean — a TRUE range area: the Area's dataKey holds
 *      `[lo, hi]`, which Recharts 2 renders as a band with `lo` as its baseline,
 *   5. binned mean curve (2 px line),
 *   6. threshold ReferenceLines (zero crossing / breakpoint / saturation) with labels.
 * Scatter, band and curve share ONE numeric x axis whose domain is computed from the data,
 * so they are drawn on the same scale (no category-axis misalignment).
 *
 * The tooltip snaps to the nearest plotted x (Recharts axis trigger) and shows the curve
 * interpolated at that x plus the matching scatter sample, if any.
 */
import { memo, useCallback, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { scaleLinear } from "d3-scale";
import { THEME } from "../../lib/colors.js";
import { fmt, fmtFeatureValue, isNum } from "../../lib/format.js";
import { GlassTooltipCard, TooltipRow } from "./GlassTooltip.jsx";
import { SEMANTIC, axisTickFormatter, axisTitle, interpolateCurve, paddedExtent } from "./shapMath.js";

const AXIS_TICK = { fill: THEME.inkMuted, fontSize: 11, fontFamily: '"JetBrains Mono", monospace' };
/** Tooltip key for the band: the curve hue at low opacity, like the band itself. */
const BAND_KEY = "rgba(248, 250, 252, 0.35)";
const AXIS_LABEL_STYLE = { fill: THEME.inkMuted, fontSize: 11, fontFamily: "Inter, sans-serif" };

/** Threshold markers drawn on the plot, in a fixed order so their labels stagger stably. */
const MARKERS = [
  { key: "zero_crossing", ciKey: "zero_crossing_ci", label: "zero crossing", color: SEMANTIC.zero },
  { key: "breakpoint", ciKey: "breakpoint_ci", label: "breakpoint", color: SEMANTIC.breakpoint },
  { key: "saturation", ciKey: "saturation_ci", label: "saturation", color: SEMANTIC.saturation },
];

/** Min/max of a numeric field across rows, skipping nulls. */
function extentOf(rows, keys) {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    for (const key of keys) {
      const v = row[key];
      if (isNum(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  return min <= max ? [min, max] : null;
}

/** Shared x domain for scatter + curve; fractions never extend beyond [0, 1]. */
function computeXDomain(meta, curve, points) {
  const a = extentOf(curve, ["x"]);
  const b = extentOf(points, ["x"]);
  if (!a && !b) return [0, 1];
  const min = Math.min(a?.[0] ?? Infinity, b?.[0] ?? Infinity);
  const max = Math.max(a?.[1] ?? -Infinity, b?.[1] ?? -Infinity);
  let [lo, hi] = paddedExtent(min, max, 0.02);
  if (meta?.display === "percent") {
    lo = Math.max(lo, 0);
    hi = Math.min(hi, 1);
  }
  return [lo, hi];
}

/**
 * Round-number ticks INSIDE a data-tight domain (d3 "nice" steps: 0, 0.2, 0.4 …). Recharts
 * would otherwise start its ticks at the raw domain minimum (e.g. −0.02, 0.18, …).
 */
function niceTicks([lo, hi], count = 6) {
  return scaleLinear().domain([lo, hi]).ticks(count);
}

/** Y domain covering scatter, band and zero, padded so markers do not touch the frame. */
function computeYDomain(curve, points) {
  const a = extentOf(curve, ["mean", "lo", "hi"]);
  const b = extentOf(points, ["y"]);
  const min = Math.min(0, a?.[0] ?? 0, b?.[0] ?? 0);
  const max = Math.max(0, a?.[1] ?? 0, b?.[1] ?? 0);
  return paddedExtent(min, max, 0.08) ?? [-1, 1];
}

/**
 * Label for a vertical threshold line: coloured key + ink text (text never wears the data
 * colour). `row` staggers the labels vertically; `flip` anchors the label left of the line
 * when the line sits in the right third of the plot.
 */
function ThresholdLabel({ viewBox, text, color, row, flip }) {
  if (!viewBox || !isNum(viewBox.x)) return null;
  const x = viewBox.x + (flip ? -6 : 6);
  const y = (viewBox.y ?? 0) + 12 + row * 15;
  return (
    <g pointerEvents="none">
      <rect x={flip ? x - 6 : x} y={y - 7} width={6} height={6} rx={1.5} fill={color} />
      <text
        x={flip ? x - 10 : x + 10}
        y={y}
        textAnchor={flip ? "end" : "start"}
        fill={THEME.ink}
        fontSize={11}
        fontFamily="Inter, sans-serif"
        paintOrder="stroke"
        stroke={THEME.bg}
        strokeWidth={3}
      >
        {text}
      </text>
    </g>
  );
}

/** Tooltip content: curve value at the hovered x and the scatter sample at that x, if any. */
function DependenceTooltip({ active, label, payload, meta, curve, colorMeta, colorMode, zoneName, colorOf, ciLabel }) {
  if (!active || !isNum(label)) return null;
  const mean = interpolateCurve(curve, label, "mean");
  const banded = curve.filter((r) => r.band);
  const lo = banded.length ? interpolateCurve(banded, label, "lo") : NaN;
  const hi = banded.length ? interpolateCurve(banded, label, "hi") : NaN;
  const sample = payload?.find?.((p) => p?.payload && "c" in p.payload)?.payload ?? null;
  return (
    <GlassTooltipCard title={`${meta?.label ?? ""} = ${fmtFeatureValue(meta, label)}`}>
      {isNum(mean) ? <TooltipRow color={SEMANTIC.curve} value={`${fmt(mean, 2)} °C`} label="binned mean SHAP" /> : null}
      {isNum(lo) && isNum(hi) ? (
        <TooltipRow color={BAND_KEY} value={`${fmt(lo, 2)} – ${fmt(hi, 2)}`} label={`bootstrap ${ciLabel} band`} />
      ) : null}
      {sample ? (
        <>
          <TooltipRow
            keyShape="dot"
            color={colorOf(sample)}
            value={`${fmt(sample.y, 2)} °C`}
            label="cell SHAP (sample)"
          />
          {colorMode === "zone" ? (
            <TooltipRow value={zoneName(sample.zone)} label="zone" />
          ) : (
            <TooltipRow value={fmtFeatureValue(colorMeta, sample.c)} label={colorMeta?.label ?? "partner"} />
          )}
          {sample.year ? <TooltipRow value={String(sample.year)} label="epoch" /> : null}
        </>
      ) : null}
    </GlassTooltipCard>
  );
}

/**
 * @param {object} props
 * @param {object} props.meta          manifest feature metadata of the plotted feature
 * @param {Array}  props.curve         rows from buildCurve()
 * @param {Array}  props.points        scatter rows { x, y, c, zone, year }
 * @param {(row) => string} props.colorOf  scatter colour for a row
 * @param {"partner"|"zone"} props.colorMode
 * @param {object|null} props.colorMeta metadata of the colour (partner) feature
 * @param {(id:number) => string} props.zoneName
 * @param {object|null} props.threshold dependence threshold object (§4.4)
 * @param {number} [props.height]
 */
function DependenceChart({ meta, curve, points, colorOf, colorMode, colorMeta, zoneName, threshold, height = 380, ciLabel = "95% CI" }) {
  const xDomain = useMemo(() => computeXDomain(meta, curve, points), [meta, curve, points]);
  const yDomain = useMemo(() => computeYDomain(curve, points), [curve, points]);
  const xTicks = useMemo(() => niceTicks(xDomain), [xDomain]);
  const yTicks = useMemo(() => niceTicks(yDomain), [yDomain]);
  const tickFormatter = useMemo(() => axisTickFormatter(meta), [meta]);

  // Only markers with a value inside the visible x range are drawn.
  const markers = useMemo(() => {
    const t = threshold ?? {};
    const span = xDomain[1] - xDomain[0] || 1;
    return MARKERS.filter((m) => isNum(t[m.key]) && t[m.key] >= xDomain[0] && t[m.key] <= xDomain[1]).map((m, row) => {
      const ci = Array.isArray(t[m.ciKey]) && isNum(t[m.ciKey][0]) && isNum(t[m.ciKey][1]) ? t[m.ciKey] : null;
      return {
        ...m,
        row,
        value: t[m.key],
        ci: ci ? [Math.max(Math.min(...ci), xDomain[0]), Math.min(Math.max(...ci), xDomain[1])] : null,
        flip: (t[m.key] - xDomain[0]) / span > 0.66,
      };
    });
  }, [threshold, xDomain]);

  // Custom scatter shape: one <circle> per point (cheaper than 1,500 <Cell> children).
  const renderDot = useCallback(
    ({ cx, cy, payload }) =>
      isNum(cx) && isNum(cy) ? <circle cx={cx} cy={cy} r={2.4} fill={colorOf(payload)} fillOpacity={0.72} /> : <g />,
    [colorOf],
  );

  const hasBand = curve.some((r) => r.band);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart margin={{ top: 12, right: 18, bottom: 30, left: 6 }}>
        <CartesianGrid stroke={THEME.grid} />
        <XAxis
          dataKey="x"
          type="number"
          domain={xDomain}
          allowDataOverflow
          allowDuplicatedCategory={false}
          tickFormatter={tickFormatter}
          tick={AXIS_TICK}
          ticks={xTicks}
          stroke={THEME.axis}
          tickLine={false}
          label={{ value: axisTitle(meta), position: "insideBottom", offset: -18, style: AXIS_LABEL_STYLE }}
        />
        <YAxis
          type="number"
          domain={yDomain}
          allowDataOverflow
          tickFormatter={(v) => fmt(v, 1)}
          tick={AXIS_TICK}
          ticks={yTicks}
          width={48}
          stroke={THEME.axis}
          tickLine={false}
          label={{ value: "SHAP (°C)", angle: -90, position: "insideLeft", offset: 12, style: AXIS_LABEL_STYLE }}
        />

        {markers.map((m) =>
          m.ci ? (
            <ReferenceArea
              key={`${m.key}-ci`}
              x1={m.ci[0]}
              x2={m.ci[1]}
              fill={m.color}
              fillOpacity={0.09}
              stroke="none"
              ifOverflow="hidden"
            />
          ) : null,
        )}
        <ReferenceLine y={0} stroke={THEME.inkFaint} strokeWidth={1} ifOverflow="hidden" />

        <Scatter
          name="Cell SHAP"
          data={points}
          dataKey="y"
          shape={renderDot}
          isAnimationActive={false}
          legendType="none"
        />
        {hasBand ? (
          <Area
            name={ciLabel === "95% CI" ? "95% band" : "replicate range"}
            data={curve}
            dataKey="band"
            type="linear"
            stroke="none"
            fill={SEMANTIC.band}
            fillOpacity={0.14}
            activeDot={false}
            isAnimationActive={false}
          />
        ) : null}
        <Line
          name="Binned mean"
          data={curve}
          dataKey="mean"
          type="linear"
          stroke={SEMANTIC.curve}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          dot={false}
          activeDot={false}
          animationDuration={500}
        />

        {markers.map((m) => (
          <ReferenceLine
            key={m.key}
            x={m.value}
            stroke={m.color}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            ifOverflow="hidden"
            label={
              <ThresholdLabel
                text={`${m.label} ${fmtFeatureValue(meta, m.value)}`}
                color={m.color}
                row={m.row}
                flip={m.flip}
              />
            }
          />
        ))}

        <Tooltip
          cursor={{ stroke: THEME.inkMuted, strokeWidth: 1 }}
          isAnimationActive={false}
          content={
            <DependenceTooltip
              meta={meta}
              curve={curve}
              colorMeta={colorMeta}
              colorMode={colorMode}
              zoneName={zoneName}
              colorOf={colorOf}
              ciLabel={ciLabel}
            />
          }
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export default memo(DependenceChart);
