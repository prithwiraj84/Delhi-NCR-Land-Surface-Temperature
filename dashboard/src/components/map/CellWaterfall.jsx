/**
 * Per-cell SHAP waterfall (pure SVG).
 *
 * Reads top-to-bottom as the additive TreeSHAP decomposition of one 1 km² cell:
 *   base value E[f(x)] (°C)  ->  + contribution of each feature (largest |SHAP| first)
 *   ->  "other N features" (compact mode)  ->  predicted LST.
 * Each bar spans [running total before, running total after] on a shared °C axis:
 * cyan = cooling (negative SHAP), rose = warming (positive SHAP). Text always uses ink
 * tokens (never the series colour); the bar colour + sign of the value carry polarity.
 */
import { useMemo } from "react";
import { motion } from "framer-motion";
import { scaleLinear } from "d3-scale";
import { fmt, fmtSigned, fmtFeatureValue, featureLabel, featureMeta } from "../../lib/format.js";
import { THEME } from "../../lib/colors.js";

const COOLING = THEME.cyan;
const WARMING = THEME.rose;

const LAYOUT = {
  compact: { width: 340, row: 18, labelW: 104, rawW: 58, valueW: 50, font: 10.5 },
  full: { width: 380, row: 22, labelW: 124, rawW: 64, valueW: 54, font: 11.5 },
};
const AXIS_H = 20;
const GAP = 6;

/** Trim a label so it fits the label column (SVG has no text-overflow). */
function clip(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Build the waterfall steps: feature rows (all, or the top `topN`), an optional "other"
 * row folding the tail, with running totals starting at the base value.
 */
function buildSteps(waterfall, manifest, topN) {
  const shown = topN ? waterfall.contributions.slice(0, topN) : waterfall.contributions;
  const rest = topN ? waterfall.contributions.slice(topN) : [];
  const steps = [];
  let running = waterfall.base;
  shown.forEach((c) => {
    const meta = featureMeta(manifest, c.name);
    steps.push({
      key: c.name,
      label: featureLabel(manifest, c.name),
      // Units live in the row's <title>; the narrow value column shows the bare number.
      raw: fmtFeatureValue(meta ? { ...meta, unit: "" } : meta, c.value),
      unit: meta?.unit ?? "",
      shap: c.shap,
      start: running,
      end: running + c.shap,
    });
    running += c.shap;
  });
  if (rest.length) {
    const restSum = rest.reduce((s, c) => s + c.shap, 0);
    steps.push({
      key: "__other__",
      label: `Other ${rest.length} feature${rest.length === 1 ? "" : "s"}`,
      raw: "",
      shap: restSum,
      start: running,
      end: running + restSum,
      isOther: true,
    });
    running += restSum;
  }
  return { steps, end: running };
}

/**
 * @param {object} props
 * @param {ReturnType<import('./mapMetrics.js').cellWaterfall>} props.waterfall
 * @param {object} props.manifest
 * @param {number|null} [props.topN] rows to show individually (null = all features)
 * @param {boolean} [props.animated] stagger rows in (docked panel only; not on hover)
 */
export function CellWaterfall({ waterfall, manifest, topN = 6, animated = false }) {
  const layout = topN ? LAYOUT.compact : LAYOUT.full;
  const { steps } = useMemo(() => buildSteps(waterfall, manifest, topN), [waterfall, manifest, topN]);

  const barX0 = layout.labelW + layout.rawW + GAP;
  const barX1 = layout.width - layout.valueW - GAP;
  const rowsTotal = steps.length + 2; // base row + steps + prediction row
  const height = rowsTotal * layout.row + AXIS_H;

  const x = useMemo(() => {
    const points = [waterfall.base, waterfall.prediction, ...steps.flatMap((s) => [s.start, s.end])];
    let lo = Math.min(...points);
    let hi = Math.max(...points);
    const pad = Math.max((hi - lo) * 0.08, 0.05);
    lo -= pad;
    hi += pad;
    return scaleLinear().domain([lo, hi]).range([barX0, barX1]);
  }, [waterfall, steps, barX0, barX1]);

  const ticks = x.ticks(3);
  const rowY = (i) => i * layout.row;
  const barH = Math.max(layout.row - 7, 8);
  const textY = (i) => rowY(i) + layout.row / 2 + layout.font * 0.36;
  const predRow = steps.length + 1;
  const ariaLabel =
    `SHAP waterfall: base ${fmt(waterfall.base, 2)} °C, ` +
    steps.map((s) => `${s.label} ${fmtSigned(s.shap, 2)}`).join(", ") +
    `, predicted ${fmt(waterfall.prediction, 2)} °C`;

  const Row = animated ? motion.g : "g";
  const rowMotion = (i) =>
    animated
      ? { initial: { opacity: 0, x: -6 }, animate: { opacity: 1, x: 0 }, transition: { delay: 0.02 * i, duration: 0.25 } }
      : {};

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${layout.width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className="block overflow-visible"
      style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: layout.font }}
    >
      {/* Recessive vertical gridlines at the axis ticks. */}
      {ticks.map((t) => (
        <line key={`g${t}`} x1={x(t)} x2={x(t)} y1={0} y2={rowsTotal * layout.row} stroke={THEME.grid} strokeWidth={1} />
      ))}

      {/* Base value row. */}
      <g>
        <text x={0} y={textY(0)} fill={THEME.inkMuted}>
          Base E[f(x)]
        </text>
        <circle cx={x(waterfall.base)} cy={rowY(0) + layout.row / 2} r={3.5} fill={THEME.ink} />
        <text x={layout.width} y={textY(0)} textAnchor="end" fill={THEME.ink} className="font-mono">
          {fmt(waterfall.base, 2)}
        </text>
      </g>

      {steps.map((s, idx) => {
        const i = idx + 1;
        const left = x(Math.min(s.start, s.end));
        const width = Math.max(Math.abs(x(s.end) - x(s.start)), 1.5);
        const color = s.shap < 0 ? COOLING : WARMING;
        return (
          <Row key={s.key} {...rowMotion(i)}>
            <title>{`${s.label}${s.raw ? ` = ${s.raw}${s.unit ? ` ${s.unit}` : ""}` : ""}: ${fmtSigned(s.shap, 3)} °C`}</title>
            {/* Connector from the previous running total. */}
            <line
              x1={x(s.start)}
              x2={x(s.start)}
              y1={rowY(i) - (layout.row - barH) / 2}
              y2={rowY(i) + (layout.row - barH) / 2}
              stroke={THEME.axis}
              strokeWidth={1}
            />
            <text x={0} y={textY(i)} fill={s.isOther ? THEME.inkMuted : THEME.ink}>
              {clip(s.label, Math.floor(layout.labelW / (layout.font * 0.58)))}
            </text>
            <text
              x={layout.labelW + layout.rawW}
              y={textY(i)}
              textAnchor="end"
              fill={THEME.inkMuted}
              className="font-mono"
            >
              {s.raw}
            </text>
            <rect
              x={left}
              y={rowY(i) + (layout.row - barH) / 2}
              width={width}
              height={barH}
              rx={2}
              fill={color}
              fillOpacity={s.isOther ? 0.55 : 0.9}
            />
            <text x={layout.width} y={textY(i)} textAnchor="end" fill={THEME.ink} className="font-mono">
              {fmtSigned(s.shap, 2)}
            </text>
          </Row>
        );
      })}

      {/* Prediction row. */}
      <g>
        <text x={0} y={textY(predRow)} fill={THEME.inkStrong} fontWeight={600}>
          Predicted LST
        </text>
        <line
          x1={x(waterfall.prediction)}
          x2={x(waterfall.prediction)}
          y1={rowY(predRow) + 2}
          y2={rowY(predRow) + layout.row - 2}
          stroke={THEME.inkStrong}
          strokeWidth={2}
        />
        <circle cx={x(waterfall.prediction)} cy={rowY(predRow) + layout.row / 2} r={3.5} fill={THEME.inkStrong} />
        <text
          x={layout.width}
          y={textY(predRow)}
          textAnchor="end"
          fill={THEME.inkStrong}
          fontWeight={600}
          className="font-mono"
        >
          {fmt(waterfall.prediction, 2)}
        </text>
      </g>

      {/* °C axis. */}
      <g transform={`translate(0, ${rowsTotal * layout.row})`}>
        <line x1={barX0} x2={barX1} y1={0} y2={0} stroke={THEME.axis} strokeWidth={1} />
        {ticks.map((t) => (
          <text key={`t${t}`} x={x(t)} y={13} textAnchor="middle" fill={THEME.inkFaint} fontSize={layout.font - 1.5}>
            {fmt(t, Math.abs(ticks[1] - ticks[0]) < 1 ? 1 : 0)}
          </text>
        ))}
        <text x={barX0 - GAP} y={13} textAnchor="end" fill={THEME.inkFaint} fontSize={layout.font - 1.5}>
          °C
        </text>
      </g>
    </svg>
  );
}

/**
 * One-line additivity check under the chart: base + ΣSHAP vs the stored prediction.
 * TreeSHAP is exact, so any gap is export rounding (SPEC: |err| ≤ 0.05 °C).
 */
export function WaterfallSumCheck({ waterfall }) {
  const err = waterfall.additivityError;
  const ok = !Number.isFinite(err) || Math.abs(err) <= 0.05;
  return (
    <p className="mt-1.5 font-mono text-[10.5px] leading-snug text-ink-muted">
      {fmt(waterfall.base, 2)} {fmtSigned(waterfall.sum, 2)} = {fmt(waterfall.reconstructed, 2)} °C
      <span className="text-ink-faint"> · model </span>
      {fmt(waterfall.prediction, 2)} °C{" "}
      <span className={ok ? "text-emerald" : "text-amber"}>
        {ok ? "✓" : "!"} Δ {Number.isFinite(err) ? fmtSigned(err, 2) : "n/a"}
      </span>
    </p>
  );
}
