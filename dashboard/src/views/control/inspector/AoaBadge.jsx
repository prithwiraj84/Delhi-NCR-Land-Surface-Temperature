/**
 * Area-of-applicability badge (UI_SPEC_v2 §3.4 "AOA ✓ inside (DI 0.21 < 0.47)", SPEC §4.6):
 * whether the model is applicable at this cell for this frame (the cube's `aoa_out` bit / the
 * projection flags bit 0). The dissimilarity-index threshold is quoted from metrics.json when
 * exported; per-cell DI is not part of the bundle, so only the inside/outside verdict is shown.
 * Glyph + text, never colour alone.
 */
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { cn } from "../../../lib/cn.js";
import { fmt } from "../../../lib/format.js";

/** @param {{outside: boolean|null, threshold?: number|null, reason?: string|null, className?: string}} props */
export function AoaBadge({ outside, threshold = null, reason = null, className }) {
  if (outside === null || outside === undefined) {
    return (
      <p className={cn("flex items-center gap-1.5 text-[12px] text-ink-muted", className)}>
        <ShieldQuestion aria-hidden="true" className="size-3.5" strokeWidth={1.5} /> AOA {reason ?? "not available for this frame"}
      </p>
    );
  }
  const Icon = outside ? ShieldAlert : ShieldCheck;
  return (
    <p className={cn("flex items-center gap-1.5 text-[12px]", outside ? "text-warn" : "text-ink", className)} data-testid="aoa-badge">
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      {outside ? "Outside the area of applicability — treat values with caution (hatched on the map)" : "AOA ✓ inside the area of applicability"}
      {Number.isFinite(threshold) && <span className="font-mono text-[11px] text-ink-muted">(DI threshold {fmt(threshold, 2)})</span>}
    </p>
  );
}

export default AoaBadge;
