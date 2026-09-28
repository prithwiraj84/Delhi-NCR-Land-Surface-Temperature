import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.js";

/**
 * Frosted-glass surface used for every card/panel. Translucent slate over the animated
 * background with a hairline border, inner highlight and optional neon edge glow.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shadcn convention: variants are reusable
export const glassPanelVariants = cva("relative rounded-2xl border text-ink shadow-glass", {
  variants: {
    variant: {
      default: "glass",
      strong: "glass-strong",
      subtle: "border-panel-border bg-panel/35 backdrop-blur-md",
      outline: "border-panel-border bg-transparent",
    },
    glow: {
      none: "",
      cyan: "shadow-glow-cyan border-cyan/30",
      violet: "shadow-glow-violet border-violet/30",
      emerald: "shadow-glow-emerald border-emerald/30",
      rose: "shadow-glow-rose border-rose/30",
      amber: "shadow-glow-amber border-amber/30",
    },
    padding: {
      none: "p-0",
      sm: "p-3",
      md: "p-4 sm:p-5",
      lg: "p-5 sm:p-7",
    },
    interactive: {
      true: "transition-colors duration-200 hover:border-cyan/35 hover:bg-panel-hover/60",
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
