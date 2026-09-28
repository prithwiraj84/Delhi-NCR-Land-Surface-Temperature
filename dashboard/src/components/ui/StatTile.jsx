import { forwardRef, useMemo } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Skeleton } from "./Skeleton.jsx";

const ACCENTS = {
  cyan: "text-cyan",
  violet: "text-violet",
  emerald: "text-emerald",
  rose: "text-rose",
  amber: "text-amber",
  default: "text-ink-muted",
};

const SPARK_STROKE = {
  cyan: "#22d3ee",
  violet: "#a78bfa",
  emerald: "#34d399",
  rose: "#fb7185",
  amber: "#fbbf24",
  default: "#94a3b8",
};

/**
 * 12-point-style sparkline: de-emphasised line, current (last) point in the accent colour.
 * Pure SVG, no axes (a trend cue, not a chart).
 */
function Sparkline({ values, accent }) {
  const path = useMemo(() => {
    const pts = values.map(Number).filter(Number.isFinite);
    if (pts.length < 2) return null;
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const span = max - min || 1;
    const W = 96;
    const H = 28;
    const coords = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - 3 - ((v - min) / span) * (H - 6)]);
    return { d: coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" "), last: coords.at(-1), W, H };
  }, [values]);
  if (!path) return null;
  return (
    <svg width={path.W} height={path.H} viewBox={`0 0 ${path.W} ${path.H}`} aria-hidden="true" className="overflow-visible">
      <path d={path.d} fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={path.last[0]} cy={path.last[1]} r={2.75} fill={SPARK_STROKE[accent] ?? SPARK_STROKE.default} />
    </svg>
  );
}

/**
 * KPI tile: label · value (+unit) · optional signed delta · optional sparkline.
 * Delta colour = direction × whether that direction is good (`goodDirection`, default "down"
 * because lower LST is better); an arrow icon + text always accompany the colour.
 * @param {{label: React.ReactNode, value: React.ReactNode, unit?: string, delta?: number,
 *          deltaText?: string, deltaLabel?: string, goodDirection?: "up"|"down"|"none",
 *          icon?: React.ComponentType, accent?: string, hint?: React.ReactNode,
 *          sparkline?: number[], loading?: boolean, size?: "sm"|"md"|"lg", className?: string}} props
 */
export const StatTile = forwardRef(function StatTile(
  {
    label,
    value,
    unit,
    delta,
    deltaText,
    deltaLabel,
    goodDirection = "down",
    icon: Icon,
    accent = "cyan",
    hint,
    sparkline,
    loading = false,
    size = "md",
    className,
    ...props
  },
  ref,
) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const direction = !hasDelta || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  const tone =
    direction === "flat" || goodDirection === "none"
      ? "text-ink-muted"
      : direction === goodDirection
        ? "text-emerald"
        : "text-rose";
  const DeltaIcon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  const valueSize = size === "lg" ? "text-3xl sm:text-4xl" : size === "sm" ? "text-lg" : "text-2xl";

  return (
    <div
      ref={ref}
      className={cn("glass relative flex min-w-0 flex-col gap-1.5 rounded-xl border p-3.5 sm:p-4", className)}
      {...props}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-ink-muted">{label}</span>
        {Icon && <Icon aria-hidden="true" className={cn("size-4 shrink-0", ACCENTS[accent] ?? ACCENTS.default)} />}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn("kpi-number truncate font-mono font-semibold text-ink-strong", valueSize)}>{value}</span>
            {unit && <span className="shrink-0 text-xs text-ink-muted">{unit}</span>}
          </div>
          {Array.isArray(sparkline) && <Sparkline values={sparkline} accent={accent} />}
        </div>
      )}
      {(hasDelta || deltaText) && !loading && (
        <div className="flex items-center gap-1 text-xs">
          <span className={cn("inline-flex items-center gap-0.5 font-mono font-medium", tone)}>
            <DeltaIcon aria-hidden="true" className="size-3.5" />
            {deltaText ?? delta}
          </span>
          {deltaLabel && <span className="truncate text-ink-faint">{deltaLabel}</span>}
        </div>
      )}
      {hint && !loading && <p className="text-[11px] leading-snug text-ink-faint">{hint}</p>}
    </div>
  );
});
