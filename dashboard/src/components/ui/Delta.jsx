import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { ramps } from "../../design/tokens.js";
import { fmtSigned } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

/** Polar-arm colours for the arrow only (text always stays in ink tokens). */
const WARM = ramps.polar[5];
const COOL = ramps.polar[1];

/**
 * Signed difference (UI_SPEC §4.3, §5.2 J): explicit sign with a true minus (U+2212), "±0.0"
 * at zero, unit at 0.7 em. For temperatures the arrow is coloured from the Polar arms (warm
 * rose / cool azure) and the accessible name says "warmer" / "cooler", so colour is never the
 * only cue. `semantics="neutral"` drops the warm/cool reading (e.g. km², ranks).
 * @param {{value: number, unit?: string, dp?: number, semantics?: "temperature"|"neutral",
 *          context?: string, approx?: boolean, className?: string}} props
 *   `context` completes the label ("vs NCR"); `approx` prefixes "≈" (interpolated values).
 */
export function Delta({ value, unit = "°C", dp = 1, semantics = "temperature", context, approx = false, className, ...props }) {
  const finite = typeof value === "number" && Number.isFinite(value);
  const rounded = finite ? Number(value.toFixed(dp)) : NaN;
  const dir = !finite || rounded === 0 ? 0 : rounded > 0 ? 1 : -1;
  const Icon = dir > 0 ? ArrowUpRight : dir < 0 ? ArrowDownRight : Minus;
  const text = finite ? fmtSigned(value, dp) : "—";
  const word = semantics === "temperature" ? (dir > 0 ? "warmer" : dir < 0 ? "cooler" : "no change") : dir > 0 ? "higher" : dir < 0 ? "lower" : "no change";
  const arrowColor = semantics === "temperature" && dir !== 0 ? (dir > 0 ? WARM : COOL) : undefined;
  const aria = finite ? `${approx ? "about " : ""}${text.replace("−", "minus ")} ${unit} ${word}${context ? ` ${context}` : ""}` : "not available";

  return (
    <span role="img" aria-label={aria} className={cn("tnum inline-flex items-baseline gap-0.5 font-mono font-medium text-ink", className)} {...props}>
      <Icon aria-hidden="true" className="size-3.5 self-center" style={arrowColor ? { color: arrowColor } : undefined} />
      <span aria-hidden="true">
        {approx && finite ? "≈" : ""}
        {text}
        {finite && unit && <span className="unit">{unit}</span>}
      </span>
    </span>
  );
}
