import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.js";

/**
 * Compact status / label pill (JetBrains Mono, uppercase). Text stays in ink tokens (>= 4.5:1);
 * the hue lives only in the border, the tint and the optional dot, so a badge never relies on
 * colour alone (UI_SPEC §4.1). v1 variant names are kept and mapped onto the v2 palette.
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-sans font-medium tracking-normal",
  {
    variants: {
      variant: {
        default: "border-hairline bg-surface-3/70 text-ink-muted",
        outline: "border-hairline bg-transparent text-ink-muted",
        signal: "border-signal/40 bg-signal/10 text-ink",
        solar: "border-solar/40 bg-solar/10 text-ink",
        lunar: "border-lunar/40 bg-lunar/10 text-ink",
        ok: "border-ok/40 bg-ok/10 text-ink",
        warn: "border-warn/50 bg-warn/10 text-ink",
        crit: "border-crit/50 bg-crit/10 text-ink",
        // v1 names
        cyan: "border-signal/40 bg-signal/10 text-ink",
        violet: "border-lunar/40 bg-lunar/10 text-ink",
        emerald: "border-ok/40 bg-ok/10 text-ink",
        rose: "border-crit/50 bg-crit/10 text-ink",
        amber: "border-warn/50 bg-warn/10 text-ink",
      },
      size: {
        sm: "px-2.5 py-0.5 text-[11.5px]",
        md: "px-3 py-1 text-[12px]",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

const DOT_COLOR = {
  default: "bg-ink-muted",
  outline: "bg-ink-muted",
  signal: "bg-signal",
  solar: "bg-solar",
  lunar: "bg-lunar",
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-crit",
  cyan: "bg-signal",
  violet: "bg-lunar",
  emerald: "bg-ok",
  rose: "bg-crit",
  amber: "bg-warn",
};

/**
 * @param {{variant?: string, size?: string, dot?: boolean, pulse?: boolean}} props
 *   `dot` prepends a status dot; `pulse` animates it (the live-dot pulse, 2.8 s, is the only
 *   ambient motion allowed; it stops under Reduced/Off motion).
 */
export const Badge = forwardRef(function Badge(
  { className, variant = "default", size, dot = false, pulse = false, children, ...props },
  ref,
) {
  return (
    <span ref={ref} className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && (
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", DOT_COLOR[variant] ?? DOT_COLOR.default, pulse && "animate-live-pulse")}
        />
      )}
      {children}
    </span>
  );
});
