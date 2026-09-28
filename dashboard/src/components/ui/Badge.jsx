import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.js";

/** Compact status / label pill. Text stays high-contrast; the hue lives in border + dot. */
// eslint-disable-next-line react-refresh/only-export-components -- shadcn convention: variants are reusable
export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-mono font-medium uppercase tracking-wider",
  {
    variants: {
      variant: {
        default: "border-panel-border bg-panel/70 text-ink-muted",
        cyan: "border-cyan/40 bg-cyan/10 text-cyan-soft",
        violet: "border-violet/40 bg-violet/10 text-violet-soft",
        emerald: "border-emerald/40 bg-emerald/10 text-emerald-soft",
        rose: "border-rose/40 bg-rose/10 text-rose-soft",
        amber: "border-amber/50 bg-amber/10 text-amber-soft",
        outline: "border-panel-border bg-transparent text-ink-muted",
      },
      size: {
        sm: "px-2 py-0.5 text-[10px]",
        md: "px-2.5 py-1 text-[11px]",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

const DOT_COLOR = {
  default: "bg-ink-muted",
  cyan: "bg-cyan",
  violet: "bg-violet",
  emerald: "bg-emerald",
  rose: "bg-rose",
  amber: "bg-amber",
  outline: "bg-ink-muted",
};

/**
 * @param {{variant?: string, size?: string, dot?: boolean, pulse?: boolean}} props
 *   `dot` prepends a status dot; `pulse` animates it (respecting reduced motion).
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
          className={cn("size-1.5 rounded-full", DOT_COLOR[variant] ?? DOT_COLOR.default, pulse && "animate-glow-pulse")}
        />
      )}
      {children}
    </span>
  );
});
