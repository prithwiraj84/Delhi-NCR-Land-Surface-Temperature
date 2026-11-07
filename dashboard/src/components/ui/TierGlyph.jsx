import { TierShape } from "../../design/glyphs.jsx";
import { normalizeTier, TIER_META } from "../../design/tiers.js";
import { cn } from "../../lib/cn.js";

/**
 * Evidence-tier mark (UI_SPEC §1.3, §9): glyph + text, never hue alone. The tier string MUST
 * come from the manifest (`timeline.frames[].{day,night}.tier`) or a hook that reads it -
 * never from a year.
 *
 * Variants
 *   glyph  shape only, with an accessible name (role="img")
 *   short  shape + "OBS" / "PROJ" …
 *   label  shape + "Observed" …
 *   chip   bordered chip: shape + label + optional `detail` ("Landsat 8/9 C2 ST · 10:40 IST")
 * `downscaled` appends the "250 m · DOWNSCALED" resolution attribute. Unknown tiers render a
 * neutral dash with the raw string, so a bad bundle value is visible rather than hidden.
 * @param {{tier: string, variant?: "glyph"|"short"|"label"|"chip", detail?: React.ReactNode,
 *          downscaled?: boolean, size?: number, className?: string}} props
 */
export function TierGlyph({ tier, variant = "label", detail, downscaled = false, size = 12, className, ...props }) {
  const id = normalizeTier(tier);
  const meta = id ? TIER_META[id] : null;
  const label = meta?.label ?? (tier ? String(tier) : "Unknown tier");
  const tone = id === "projected" || id === "modelled" ? "text-ink-muted" : "text-ink";

  if (variant === "glyph") {
    return (
      <span role="img" aria-label={`${label}${downscaled ? ", downscaled to 250 m" : ""}`} title={label} className={cn("inline-flex items-center", tone, className)} {...props}>
        <TierShape tier={id} size={size} />
      </span>
    );
  }

  const text = variant === "short" ? meta?.short ?? label : label;
  const body = (
    <>
      <TierShape tier={id} size={size} className="shrink-0" />
      <span className={cn("shrink-0 whitespace-nowrap", variant === "short" && "font-mono text-[11px] uppercase tracking-[0.1em]")}>{text}</span>
      {detail && <span className="min-w-0 truncate text-ink-muted">· {detail}</span>}
      {downscaled && <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-muted">· 250 m · Downscaled</span>}
    </>
  );

  if (variant === "chip") {
    return (
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-surface-2/80 px-2 py-0.5 text-xs",
          tone,
          id === "projected" && "border-dashed",
          className,
        )}
        {...props}
      >
        {body}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 text-xs", tone, className)} {...props}>
      {body}
    </span>
  );
}
