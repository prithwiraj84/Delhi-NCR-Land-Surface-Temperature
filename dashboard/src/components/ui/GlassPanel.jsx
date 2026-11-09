import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.js";

/**
 * Glass surface for cards and panels (UI_SPEC §4.5): surface-1 @ 72 % + blur 12 px over the
 * map, 1 px hairline, inset top highlight, radius 12. `variant="strong"` is the solid
 * surface-2 fallback used for cards off the map, menus and during playback. Glow variants of
 * v1 are kept as names but render a hairline accent ring only (glow budget = 3).
 * For HUD corner brackets use <HudFrame> (or add `hud` to className).
 */
export const glassPanelVariants = cva("relative rounded-panel text-ink", {
  variants: {
    variant: {
      default: "glass",
      strong: "glass-strong",
      subtle: "border border-hairline bg-surface-2/50",
      outline: "border border-hairline bg-transparent",
    },
    glow: {
      none: "",
      cyan: "border-signal/35",
      violet: "border-lunar/35",
      emerald: "border-ok/35",
      rose: "border-crit/35",
      amber: "border-warn/40",
    },
    padding: {
      none: "p-0",
      sm: "p-3",
      md: "p-4 sm:p-5",
      lg: "p-5 sm:p-7",
    },
    interactive: {
      true: "transition-colors duration-quick hover:border-hairline-strong",
      false: "",
    },
  },
  defaultVariants: { variant: "default", glow: "none", padding: "md", interactive: false },
});

/**
 * @param {{as?: keyof JSX.IntrinsicElements, variant?: string, glow?: string, padding?: string,
 *          interactive?: boolean, className?: string}} props
 */
export const GlassPanel = forwardRef(function GlassPanel(
  { as: Component = "div", variant, glow, padding, interactive, className, children, ...props },
  ref,
) {
  return (
    <Component ref={ref} className={cn(glassPanelVariants({ variant, glow, padding, interactive }), className)} {...props}>
      {children}
    </Component>
  );
});
