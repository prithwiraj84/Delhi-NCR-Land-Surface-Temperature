/**
 * Result panel of the scenario simulator.
 *
 * Headline: the model-based mean ΔLST over the cells that actually changed (animated), then the spread
 * (min / p10 / p90 / max), baseline vs scenario mean, the per-cell Δ histogram, the most
 * affected districts, and an "additive" cross-check computed from the dependence curve alone.
 *
 * Why the additive check matters: the dependence curve is a main-effect summary (average SHAP
 * at each x). Shifting x along it ignores interactions (the same greening cools a dense core
 * more than a village), the compositional rebalancing of the other land covers and the
 * coupled spectral response. The difference "model − additive" is therefore a direct,
 * readable measure of non-additivity for this scenario.
 */
import { memo, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { THEME } from "../../lib/colors.js";
import { fmt, fmtC, fmtDeltaC, fmtInt, fmtKm2, isNum } from "../../lib/format.js";
import AnimatedNumber from "./AnimatedNumber.jsx";
import { GlassTooltipCard, TooltipRow } from "./GlassTooltip.jsx";
import { SEMANTIC, appliedChangeText, emptyScenarioMessage } from "./shapMath.js";

const AXIS_TICK = { fill: THEME.inkMuted, fontSize: 10, fontFamily: '"JetBrains Mono", monospace' };
const TOP_DISTRICTS = 8;

/** Colour of a Δ value: cyan = cooling, rose = warming, slate ≈ no change. */
function deltaColor(v, eps = 0.005) {
  if (!isNum(v) || Math.abs(v) < eps) return SEMANTIC.neutral;
  return v < 0 ? SEMANTIC.cooling : SEMANTIC.warming;
}

function toneOf(v) {
  if (!isNum(v) || Math.abs(v) < 0.005) return { label: "no change", Icon: Minus, color: SEMANTIC.neutral };
  return v < 0
    ? { label: "cooling", Icon: ArrowDownRight, color: SEMANTIC.cooling }
    : { label: "warming", Icon: ArrowUpRight, color: SEMANTIC.warming };
}

function MiniStat({ label, value, hint }) {
  return (
    <div className="min-w-0 rounded-lg border border-panel-border bg-slate-950/40 px-2.5 py-2">
      <div className="truncate text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</div>
      <div className="truncate font-mono text-sm font-semibold text-ink-strong">{value}</div>
      {hint ? <div className="truncate text-[10px] text-ink-muted">{hint}</div> : null}
    </div>
  );
}

function HistogramTooltip({ active, payload }) {
  const row = active ? payload?.[0]?.payload : null;
  if (!row) return null;
  return (
    <GlassTooltipCard title={`${fmtDeltaC(row.x0)} … ${fmtDeltaC(row.x1)}`}>
      <TooltipRow keyShape="dot" color={deltaColor(row.mid)} value={fmtInt(row.count)} label="cells" />
    </GlassTooltipCard>
  );
}

/** Histogram of per-cell Δ (touching bars separated by a 2 px surface gap). */
function DeltaHistogram({ histogram }) {
  const data = useMemo(
    () => (histogram ?? []).map((b) => ({ ...b, mid: (b.x0 + b.x1) / 2, label: fmt((b.x0 + b.x1) / 2, 2) })),
    [histogram],
  );
  if (!data.length) return null;
  return (
    <figure className="space-y-1">
      <figcaption className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        Per-cell ΔLST distribution (°C)
      </figcaption>
      <ResponsiveContainer width="100%" height={132}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap={1}>
          <CartesianGrid stroke={THEME.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            stroke={THEME.axis}
            interval="preserveStartEnd"
            minTickGap={18}
          />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
          <Tooltip
            content={<HistogramTooltip />}
            cursor={{ fill: "rgba(148,163,184,0.08)" }}
            isAnimationActive={false}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={24} animationDuration={400}>
            {data.map((b) => (
              <Cell key={b.x0} fill={deltaColor(b.mid)} fillOpacity={0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

/** Diverging per-district bars centred on 0 °C (top N by |mean Δ|). */
function DistrictBreakdown({ byDistrict }) {
  const rows = useMemo(
    () =>
      [...(byDistrict ?? [])]
        .filter((d) => isNum(d.mean))
        .sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))
        .slice(0, TOP_DISTRICTS),
    [byDistrict],
  );
  if (!rows.length) return null;
  const maxAbs = Math.max(1e-6, ...rows.map((d) => Math.abs(d.mean)));
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        <span>By district (top {rows.length})</span>
        <span>mean Δ · cells</span>
      </div>
      <ul className="space-y-1">
        {rows.map((d) => {
          const width = `${(Math.abs(d.mean) / maxAbs) * 50}%`;
          return (
            <li
              key={d.id}
              className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_4.25rem] items-center gap-2 text-xs"
            >
              <span className="truncate text-ink" title={d.name}>
                {d.name}
              </span>
              <span className="relative h-2.5 rounded-sm bg-slate-800/50" aria-hidden="true">
                <span className="absolute inset-y-0 left-1/2 w-px bg-slate-500/60" />
                <span
                  className={cn("absolute inset-y-0", d.mean < 0 ? "rounded-l-[3px]" : "rounded-r-[3px]")}
                  style={{
                    backgroundColor: deltaColor(d.mean),
                    width,
                    left: d.mean < 0 ? `calc(50% - ${width})` : "50%",
                  }}
                />
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums text-ink">
                {fmt(d.mean, 2)}
                <span className="ml-1 text-ink-faint">{fmtInt(d.count)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Model vs additive estimate, with the non-additive remainder spelled out. */
function AdditiveComparison({ modelMean, additive, featureLabel }) {
  const hasModel = isNum(modelMean);
  const hasAdditive = isNum(additive?.mean);
  const gap = hasModel && hasAdditive ? modelMean - additive.mean : NaN;
  let reading = "Additive estimate unavailable (no dependence curve for this feature).";
  if (hasAdditive && !hasModel) {
    reading = "Model estimate unavailable; the additive estimate assumes the SHAP main effect acts alone.";
  } else if (hasAdditive && hasModel) {
    const share = Math.abs(additive.mean) > 1e-6 ? Math.abs(gap / additive.mean) : Infinity;
    reading =
      Math.abs(gap) < 0.05 || share < 0.15
        ? `The main effect of ${featureLabel} explains this scenario almost entirely – interactions play a minor role.`
        : `${fmtDeltaC(gap)} comes from interactions, land-cover rebalancing and coupled spectral change – effects the single-feature curve cannot see.`;
  }
  return (
    <div className="space-y-2 rounded-lg border border-panel-border bg-slate-950/40 p-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">Model</div>
          <div className="font-mono text-sm font-semibold text-ink-strong">{fmtDeltaC(modelMean)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">Additive</div>
          <div className="font-mono text-sm font-semibold text-ink-strong">{fmtDeltaC(additive?.mean)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">Non-additive</div>
          <div className="font-mono text-sm font-semibold text-violet-soft">{fmtDeltaC(gap)}</div>
        </div>
      </div>
      <p className="text-[11px] leading-snug text-ink-muted">{reading}</p>
      <p className="text-[10px] leading-snug text-ink-faint">
        Additive = mean over changed cells of curve(x + Δ) − curve(x), interpolated on the dependence-curve bin centres
        {hasAdditive ? ` (${fmtInt(additive.count)} cells)` : ""}.
      </p>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.result       scenarioResult from useData()
 * @param {{mean: number, count: number}} props.additive
 * @param {string} props.featureLabel
 * @param {(v: number) => string} [props.formatChange]  formats a change of the scenario feature
 * @param {"all"|"district"|"zone"} [props.regionKind]
 * @param {number|null} [props.year]
 * @param {boolean} props.hasModel
 * @param {boolean} props.stale             inputs changed and the result is being recomputed
 */
function ScenarioResults({ result, additive, featureLabel, formatChange, regionKind = "all", year = null, hasModel, stale }) {
  const stats = result?.stats ?? null;
  const tone = toneOf(stats?.mean);
  const ToneIcon = tone.Icon;
  const appliedText = appliedChangeText(stats, formatChange);
  const changed = stats?.changedCount ?? stats?.count;
  const applicable = stats?.applicableCount;
  const unchanged = isNum(applicable) && isNum(changed) ? applicable - changed : 0;

  if (!hasModel) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg border border-dashed border-amber/40 bg-amber/5 p-3 text-xs text-ink">
          The in-browser model (<span className="font-mono">model_web.json</span>) is not available, so only the
          additive curve-based estimate can be shown.
        </p>
        <AdditiveComparison modelMean={NaN} additive={additive} featureLabel={featureLabel} />
      </div>
    );
  }

  if (!stats) {
    return <p className="text-xs text-ink-muted">Running the scenario on the current epoch…</p>;
  }

  if (!stats.count) {
    return (
      <p className="rounded-lg border border-dashed border-panel-border p-3 text-xs text-ink-muted">
        {emptyScenarioMessage({ result, featureLabel, regionKind, year })}
      </p>
    );
  }

  return (
    <div className={cn("space-y-4 transition-opacity duration-200", stale && "opacity-60")} aria-busy={stale}>
      {/* headline */}
      <div className="relative overflow-hidden rounded-xl border border-panel-border bg-slate-950/50 p-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-3xl"
          style={{ backgroundColor: tone.color, opacity: 0.18 }}
        />
        <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted">Mean ΔLST · changed cells</div>
        <div className="mt-1 flex items-baseline gap-2" aria-live="polite">
          <span className="font-sans text-5xl font-semibold tracking-tight text-ink-strong">
            <AnimatedNumber
              value={stats.mean}
              format={(v) => (isNum(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), 2)}` : "—")}
            />
          </span>
          <span className="text-lg text-ink-muted">°C</span>
        </div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-panel-border bg-slate-900/60 px-2 py-0.5 text-[11px] text-ink">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tone.color }} />
          <ToneIcon aria-hidden="true" className="h-3 w-3 text-ink-muted" />
          {tone.label}
        </div>
        {appliedText ? <p className="mt-2 font-mono text-[11px] text-amber-soft">{appliedText}</p> : null}
        {unchanged > 0 ? (
          <p className="mt-1 text-[11px] leading-snug text-ink-muted">
            {fmtInt(unchanged)} of {fmtInt(applicable)} region cells could not take this change and are left out of the
            mean (region-wide average {fmtDeltaC(stats.regionMean)}).
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MiniStat
          label="Changed cells"
          value={isNum(applicable) ? `${fmtInt(stats.count)} / ${fmtInt(applicable)}` : fmtInt(stats.count)}
          hint={`${fmtKm2(stats.areaKm2)} changed`}
        />
        <MiniStat
          label="Baseline → scenario"
          value={`${fmtC(stats.baselineMeanC)} → ${fmt(stats.scenarioMeanC, 1)}`}
          hint="mean predicted LST"
        />
        <MiniStat label="Min / max" value={`${fmt(stats.min, 2)} / ${fmt(stats.max, 2)}`} hint="°C per cell" />
        <MiniStat label="p10 / p90" value={`${fmt(stats.p10, 2)} / ${fmt(stats.p90, 2)}`} hint="°C per cell" />
      </div>

      <DeltaHistogram histogram={result.histogram} />
      <DistrictBreakdown byDistrict={result.byDistrict} />
      <AdditiveComparison modelMean={stats.mean} additive={additive} featureLabel={featureLabel} />
    </div>
  );
}

export default memo(ScenarioResults);
