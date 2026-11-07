/**
 * One telemetry readout (UI_SPEC_v2 §3.2, §8 `TelemetryItem`):
 *   MICRO LABEL  value unit  Δ  ▁▂▃▅   (tier glyph)
 *
 * Props: `label, value, unit, delta, semantics, spark, tier, interpolating`, plus `status`
 * ("exact" | "interpolating" | "loading" | "n/a"), `reason` (shown for n/a) and `title`.
 * Interpolating readouts dim and carry "≈" (principle 4); n/a readouts say why instead of a
 * dash alone. Values use JetBrains Mono 600 with tabular figures; units at 0.7 em.
 */
import { memo } from "react";
import { TierShape } from "../../design/glyphs.jsx";
import { normalizeTier, TIER_META } from "../../design/tiers.js";
import { cn } from "../../lib/cn.js";
import { Delta } from "../../components/ui/Delta.jsx";

function Spark({ points }) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p));
  if (pts.length < 2) return null;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const w = 36;
  const h = 14;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * (w - 2) + 1).toFixed(1)} ${(h - 1 - ((v - lo) / (hi - lo || 1)) * (h - 2)).toFixed(1)}`).join("");
  return (
    <svg width={w} height={h} aria-hidden="true" className="shrink-0">
      <path d={d} fill="none" stroke="var(--ink-muted)" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w - 1} cy={h - 1 - ((pts[pts.length - 1] - lo) / (hi - lo || 1)) * (h - 2)} r={1.75} fill="var(--ink)" />
    </svg>
  );
}

/**
 * @param {{label: string, value?: React.ReactNode, unit?: string, delta?: number|null, deltaContext?: string,
 *          semantics?: "temperature"|"neutral", spark?: number[]|null, tier?: string|null,
 *          status?: "exact"|"interpolating"|"loading"|"n/a", reason?: string|null, title?: string,
 *          compact?: boolean, className?: string}} props
 */
export const TelemetryItem = memo(function TelemetryItem({ label, value, unit, delta = null, deltaContext, semantics = "temperature", spark = null, tier = null, status = "exact", reason = null, title, compact = false, className }) {
  const interpolating = status === "interpolating";
  const na = status === "n/a";
  const loading = status === "loading";
  const tierId = normalizeTier(tier);
  return (
    <div
      className={cn("flex shrink-0 snap-start items-center gap-2 px-3", compact ? "h-8" : "h-11", className)}
      title={title ?? (na ? reason ?? undefined : undefined)}
      data-status={status}
    >
      <span className="micro-label whitespace-nowrap">{label}</span>
      <span className={cn("flex items-baseline gap-1.5 transition-opacity duration-quick", interpolating && "opacity-60")}>
        {loading ? (
          <span className="scan-skeleton inline-block h-3 w-12" aria-label="loading" />
        ) : na ? (
          <span className="whitespace-nowrap font-mono text-[12px] text-ink-faint">{reason ? "n/a" : "—"}</span>
        ) : (
          <span className={cn("tnum whitespace-nowrap font-mono font-semibold text-ink-strong", compact ? "text-[14px]" : "text-[16px]", interpolating && "italic")}>
            {interpolating && <span aria-hidden="true">≈</span>}
            {value}
            {unit && <span className="unit">{unit}</span>}
          </span>
        )}
        {!loading && !na && Number.isFinite(delta) && <Delta value={delta} dp={1} semantics={semantics} context={deltaContext} approx={interpolating} className="text-[12px]" />}
      </span>
      {!compact && !na && !loading && <Spark points={spark} />}
      {tierId && (
        <span role="img" aria-label={TIER_META[tierId].label} className="text-ink-muted">
          <TierShape tier={tierId} size={10} />
        </span>
      )}
      {na && reason && <span className="sr-only">{reason}</span>}
    </div>
  );
});

export default TelemetryItem;
