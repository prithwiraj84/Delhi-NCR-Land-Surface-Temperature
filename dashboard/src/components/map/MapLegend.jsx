/**
 * Map legend (bottom-left).
 *
 * - Sequential / diverging layers: a continuous gradient bar sampled from the same colour
 *   scale the cells use, with "nice" ticks in °C. Diverging domains are symmetric around 0
 *   so the neutral midpoint always means "no effect"; the two arms are named in words
 *   (cooling / warming) so polarity is never carried by colour alone.
 * - Categorical layers (zones, dominant driver): swatches for the categories present in
 *   the current epoch with their share of cells, sorted by share.
 */
import { useMemo } from "react";
import { motion } from "framer-motion";
import { scaleLinear } from "d3-scale";
import { fmt, fmtPct } from "../../lib/format.js";
import { rgbToCss } from "../../lib/colors.js";
import { NODATA_RGBA, UNAFFECTED_RGBA } from "./mapMetrics.js";

/** Decimal places that keep adjacent tick labels distinct. */
function tickDecimals(ticks) {
  if (ticks.length < 2) return 1;
  const step = Math.abs(ticks[1] - ticks[0]);
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  return 2;
}

function ContinuousLegend({ metric }) {
  const [lo, hi] = metric.domain;
  const ticks = useMemo(() => scaleLinear().domain([lo, hi]).ticks(5), [lo, hi]);
  const dp = tickDecimals(ticks);
  const diverging = metric.kind === "diverging";
  return (
    <div>
      <div
        className="h-2.5 w-full rounded-sm ring-1 ring-white/10"
        style={{ background: metric.scale?.gradientCss }}
        role="img"
        aria-label={`${metric.title}: colour scale from ${fmt(lo, 2)} to ${fmt(hi, 2)} ${metric.unit}`}
      />
      <div className="relative mt-1 h-4 font-mono text-[10px] tabular-nums text-ink-muted">
        {ticks.map((t) => {
          const pct = ((t - lo) / (hi - lo)) * 100;
          return (
            <span
              key={t}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${Math.min(Math.max(pct, 3), 97)}%` }}
            >
              <span className="absolute -top-1.5 left-1/2 h-1 w-px bg-ink-muted/60" aria-hidden="true" />
              {diverging && t > 0 ? "+" : ""}
              {fmt(t, dp)}
            </span>
          );
        })}
      </div>
      {diverging ? (
        <div className="mt-0.5 flex justify-between text-[10px] uppercase tracking-wider">
          <span className="text-cyan-soft">◀ cooling</span>
          <span className="text-ink-faint">0 = no effect</span>
          <span className="text-rose-soft">warming ▶</span>
        </div>
      ) : (
        <div className="mt-0.5 flex justify-between text-[10px] uppercase tracking-wider text-ink-faint">
          <span>p02 · cooler</span>
          <span>hotter · p98</span>
        </div>
      )}
    </div>
  );
}

function CategoricalLegend({ shares }) {
  if (!shares.length) {
    return <p className="text-xs text-ink-muted">No categorised cells in this epoch.</p>;
  }
  return (
    <ul className="max-h-44 space-y-1 overflow-y-auto pr-1" aria-label="Categories and share of cells">
      {shares.map((c) => (
        <li key={c.key} className="flex items-center gap-2 text-xs">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/40"
            style={{ background: rgbToCss([c.rgba[0], c.rgba[1], c.rgba[2]]) }}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-ink">{c.label}</span>
          <span className="font-mono tabular-nums text-ink-muted">{fmtPct(c.share, c.share < 0.1 ? 1 : 0)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * @param {object} props
 * @param {object} props.metric   resolved metric (mapMetrics.resolveMetric)
 * @param {Array}  props.shares   categoryShares(metric) for categorical layers
 * @param {string} props.footnote   encoding note, e.g. "1 km² prisms · height ∝ value"
 */
export default function MapLegend({ metric, shares, footnote }) {
  const categorical = metric.kind === "categorical";
  return (
    <motion.section
      key={metric.layer + metric.title}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="w-72 rounded-xl border border-panel-border bg-panel/70 p-3 shadow-glass backdrop-blur-md"
      aria-label="Map legend"
    >
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="truncate font-display text-[13px] font-semibold text-ink-strong">{metric.title}</h3>
        {metric.unit ? <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">{metric.unit}</span> : null}
      </header>
      {!metric.available ? (
        <p className="text-xs text-ink-muted">{metric.emptyReason}</p>
      ) : categorical ? (
        <CategoricalLegend shares={shares} />
      ) : (
        <ContinuousLegend metric={metric} />
      )}
      {/* Wraps onto two lines instead of truncating when the swatch label is long (scenario layer). */}
      <footer className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-t border-white/5 pt-2 text-[10px] text-ink-faint">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            className="h-2 w-2 rounded-[2px]"
            style={{ background: rgbToCss(metric.isScenario ? UNAFFECTED_RGBA : NODATA_RGBA) }}
            aria-hidden="true"
          />
          {metric.isScenario ? "outside scenario region" : "no data"}
        </span>
        <span className="whitespace-nowrap">{footnote}</span>
      </footer>
    </motion.section>
  );
}
