/**
 * Building blocks of a governance-zone card: epoch sparklines, the diverging SHAP
 * signature, driver chips, interaction pairs, district share bars and recommendations.
 *
 * Colour jobs (fixed across the dashboard):
 *   - the zone's own colour = identity (accent line, share bars, current-epoch dot);
 *   - cyan = cooling (negative SHAP / ΔLST), rose = warming (positive) - diverging pair
 *     around a neutral slate midline;
 *   - text always stays in ink tokens; colour lives in marks, dots and borders.
 */
import { useId, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, ChevronDown, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { THEME } from "../../lib/colors.js";
import { featureLabel, featureMeta, fmt, fmtDeltaC, fmtFeatureValue, fmtPct, isNum } from "../../lib/format.js";
import { Badge } from "../ui/Badge.jsx";
import { priorityMeta } from "./zoneModel.js";
import { intervalContains } from "../../lib/uncertainty.js";

const COOL = THEME.cyan;
const WARM = THEME.rose;

/** Tiny section label inside a card. */
export function CardLabel({ children, right }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <h4 className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">{children}</h4>
      {right ? <span className="text-[10px] text-ink-faint">{right}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Sparkline (one per metric; a trend cue - values live in text next to it)
// ---------------------------------------------------------------------------------------

const SPARK_W = 112;
const SPARK_H = 34;

/**
 * @param {{series: {year: number, value: number|null}[], currentYear: number, color: string,
 *          format: (v: number) => string, label: string}} props
 */
export function Sparkline({ series, currentYear, color, format, label }) {
  const pts = series.filter((p) => isNum(p.value));
  if (pts.length < 2) {
    return <span className="text-[10px] text-ink-faint">single epoch</span>;
  }
  const values = pts.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const xOf = (i) => 4 + (i / (pts.length - 1)) * (SPARK_W - 8);
  const yOf = (v) => SPARK_H - 5 - ((v - min) / span) * (SPARK_H - 10);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");
  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      role="img"
      aria-label={`${label}: ${pts.map((p) => `${p.year} ${format(p.value)}`).join(", ")}`}
      className="shrink-0 overflow-visible"
    >
      <path d={d} fill="none" stroke={THEME.inkFaint} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => {
        const current = p.year === currentYear;
        return (
          <g key={p.year}>
            <circle
              cx={xOf(i)}
              cy={yOf(p.value)}
              r={current ? 3.5 : 2}
              fill={current ? color : THEME.inkMuted}
              stroke={current ? "#0f1624" : "none"}
              strokeWidth={current ? 1.5 : 0}
            />
            {/* generous invisible hit target with a native tooltip */}
            <circle cx={xOf(i)} cy={yOf(p.value)} r={9} fill="transparent">
              <title>{`${p.year}: ${format(p.value)}`}</title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------
// SHAP signature (diverging mini bars on a scale shared by all four cards)
// ---------------------------------------------------------------------------------------

/**
 * @param {{rows: {feature: string, value: number}[], maxAbs: number, manifest: object, zoneName: string}} props
 */
export function ShapSignature({ rows, maxAbs, manifest, zoneName }) {
  const reduceMotion = useReducedMotion();
  if (!rows.length) return <p className="text-xs text-ink-muted">No SHAP means exported for this zone.</p>;
  return (
    <ul className="space-y-1" aria-label={`SHAP signature of ${zoneName}: mean contribution to LST per feature`}>
      {rows.map((r, i) => {
        const pct = Math.min(50, (Math.abs(r.value) / maxAbs) * 50);
        const warming = r.value > 0;
        const label = featureLabel(manifest, r.feature);
        return (
          <li
            key={r.feature}
            className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_3.4rem] items-center gap-2 text-[11px]"
            aria-label={`${label}: ${fmtDeltaC(r.value, 2)} (${warming ? "warming" : "cooling"})`}
          >
            <span className="truncate text-ink" title={label}>
              {label}
            </span>
            <span className="relative h-2.5" aria-hidden="true">
              <span className="absolute inset-y-[-2px] left-1/2 w-px -translate-x-1/2 bg-slate-500/60" />
              <motion.span
                className={cn("absolute inset-y-0", warming ? "left-1/2 rounded-r-[3px]" : "right-1/2 rounded-l-[3px]")}
                style={{ backgroundColor: warming ? WARM : COOL }}
                initial={reduceMotion ? false : { width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: reduceMotion ? 0 : i * 0.025 }}
              />
            </span>
            <span className="kpi-number text-right font-mono text-ink-muted">{fmt(r.value, 2)}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------
// Driver chips / interactions / districts
// ---------------------------------------------------------------------------------------

/** @param {{warming: {feature, shap}[], cooling: {feature, shap}[], manifest: object}} props */
export function DriverChips({ warming, cooling, manifest }) {
  const chips = [
    ...(warming ?? []).filter((d) => isNum(d?.shap)).map((d) => ({ ...d, kind: "warming" })),
    ...(cooling ?? []).filter((d) => isNum(d?.shap)).map((d) => ({ ...d, kind: "cooling" })),
  ];
  if (!chips.length) return <p className="text-xs text-ink-muted">No driver exceeds 0.01 °C.</p>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Top warming and cooling drivers">
      {chips.map((c) => {
        const Icon = c.kind === "warming" ? ArrowUpRight : ArrowDownRight;
        return (
          <li
            key={`${c.kind}-${c.feature}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-ink",
              c.kind === "warming" ? "border-rose/40 bg-rose/10" : "border-cyan/40 bg-cyan/10",
            )}
          >
            <Icon aria-hidden="true" className={cn("size-3", c.kind === "warming" ? "text-rose" : "text-cyan")} />
            <span className="sr-only">{c.kind}:</span>
            {featureLabel(manifest, c.feature)}
            <span className="kpi-number font-mono text-ink-muted">{fmt(c.shap, 2)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** @param {{pairs: {a, b, value}[], manifest: object}} props */
export function InteractionPairs({ pairs, manifest }) {
  const valid = (pairs ?? []).filter((p) => p?.a && p?.b && isNum(p.value));
  if (!valid.length) return <p className="text-xs text-ink-muted">No interaction pairs exported.</p>;
  return (
    <ul className="space-y-1 text-[11px]">
      {valid.map((p) => (
        <li key={`${p.a}-${p.b}`} className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-ink">
            {featureLabel(manifest, p.a)} <span className="text-ink-faint">×</span> {featureLabel(manifest, p.b)}
          </span>
          <span className="kpi-number ml-auto shrink-0 font-mono text-ink-muted">{fmt(p.value, 3)} °C</span>
        </li>
      ))}
    </ul>
  );
}

/** @param {{districts: {district, name, share}[], color: string}} props */
export function DistrictShares({ districts, color }) {
  const reduceMotion = useReducedMotion();
  const valid = (districts ?? []).filter((d) => isNum(d?.share)).slice(0, 5);
  if (!valid.length) return <p className="text-xs text-ink-muted">No district breakdown exported.</p>;
  return (
    <ul className="space-y-1">
      {valid.map((d, i) => (
        <li key={d.district ?? d.name} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_2.6rem] items-center gap-2 text-[11px]">
          <span className="truncate text-ink" title={d.name}>
            {d.name ?? `District ${d.district}`}
          </span>
          <span className="relative h-2 rounded-r-[3px] bg-slate-700/30" aria-hidden="true">
            <motion.span
              className="absolute inset-y-0 left-0 rounded-r-[3px]"
              style={{ backgroundColor: color, opacity: 0.85 }}
              initial={reduceMotion ? false : { width: 0 }}
              animate={{ width: `${Math.max(1, Math.min(100, d.share * 100))}%` }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: reduceMotion ? 0 : i * 0.03 }}
            />
          </span>
          <span className="kpi-number text-right font-mono text-ink-muted">{fmtPct(d.share, 0)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------------------

/** "Increase" / "Decrease" + icon for an action. */
export function ActionVerb({ action, className }) {
  const up = action !== "decrease";
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium text-ink-strong", className)}>
      <Icon aria-hidden="true" className="size-3.5 text-emerald" />
      {up ? "Increase" : "Decrease"}
    </span>
  );
}

/**
 * Model-based ΔLST with its bootstrap interval: "−1.30 °C [−1.60, −1.00]". `ciLabel` is
 * "95% CI" or "replicate range" (few replicates). An estimate that lies outside its own
 * interval (possible with percentile intervals of a biased resampling statistic) is flagged
 * instead of being shown as if the interval covered it.
 */
export function DeltaWithCi({ delta, ci, compact = false, ciLabel = "95% CI" }) {
  const inside = intervalContains(delta, ci);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className={cn("kpi-number font-mono font-semibold", isNum(delta) && delta < 0 ? "text-cyan-soft" : "text-ink")}>
        {fmtDeltaC(delta, 2)}
      </span>
      {ci ? (
        <span className="kpi-number font-mono text-[10.5px] text-ink-faint" title={ciLabel}>
          {compact ? "" : `${ciLabel} `}[{fmt(ci[0], 2)}, {fmt(ci[1], 2)}]
          {inside === false ? (
            <span className="ml-1 text-amber-soft" title="The estimate lies outside its bootstrap interval">
              (estimate outside interval)
            </span>
          ) : null}
        </span>
      ) : (
        <span className="text-[10.5px] text-ink-faint">no interval</span>
      )}
    </span>
  );
}

export function PriorityBadge({ priority }) {
  const meta = priorityMeta(priority);
  return (
    <Badge variant={meta.variant} size="sm" dot={meta.id === "high"}>
      {meta.label}
      <span className="sr-only"> priority</span>
    </Badge>
  );
}

/** Text that clamps to three lines with a keyboard-accessible "more / less" toggle. */
export function ClampText({ text, className, lines = 3 }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return null;
  const long = text.length > 140;
  return (
    <div className={className}>
      <p
        id={id}
        className={cn("leading-relaxed", !open && long && (lines === 2 ? "line-clamp-2" : "line-clamp-3"))}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="focus-ring mt-0.5 inline-flex items-center gap-0.5 rounded text-[10.5px] text-ink-faint hover:text-cyan-soft"
        >
          {open ? "less" : "more"}
          <ChevronDown aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

/** @param {{recs: object[], manifest: object, ciLabel?: string}} props */
export function RecommendationList({ recs, manifest, ciLabel = "95% CI" }) {
  const valid = (recs ?? []).filter((r) => r?.feature);
  if (!valid.length) {
    return (
      <p className="text-xs leading-relaxed text-ink-muted">
        No threshold-based action is expected to cool this zone by more than 0.05 °C.
      </p>
    );
  }
  return (
    <ol className="space-y-2">
      {valid.map((r, i) => {
        const meta = featureMeta(manifest, r.feature);
        const ci = Array.isArray(r.ci) && r.ci.length === 2 && isNum(r.ci[0]) && isNum(r.ci[1]) ? r.ci : null;
        return (
          <li
            key={`${r.feature}-${i}`}
            className="rounded-lg border border-panel-border bg-bg-raised/40 p-2.5 transition-colors hover:border-slate-500/40"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-xs">
                <ActionVerb action={r.action} /> <span className="text-ink">{meta?.label ?? r.feature}</span>
              </p>
              <PriorityBadge priority={r.priority} />
            </div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px]">
              <span className="kpi-number font-mono text-ink-muted">
                {fmtFeatureValue(meta, r.current)} <span className="text-ink-faint">→</span>{" "}
                <span className="text-ink">{fmtFeatureValue(meta, r.target)}</span>
              </span>
              <span className="inline-flex items-baseline gap-1">
                <span className="text-ink-faint">model ΔLST</span>
                <DeltaWithCi
                  delta={isNum(r.expected_delta_c) ? r.expected_delta_c : null}
                  ci={ci}
                  compact
                  ciLabel={ciLabel}
                />
              </span>
            </div>
            {r.rationale ? <ClampText text={r.rationale} lines={2} className="mt-1 text-[11px] text-ink-faint" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

