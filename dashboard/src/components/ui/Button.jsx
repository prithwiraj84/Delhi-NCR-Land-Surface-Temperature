import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/cn.js";

/**
 * Button with a visible keyboard focus ring (2 px signal, 2 px offset). Hit targets are
 * >= 24 px (WCAG 2.2 2.5.8); `size="touch"` gives 44 px for touch layouts. No glow (the glow
 * budget is reserved for the playhead, the selection reticle and one alert).
 */
// eslint-disable-next-line react-refresh/only-export-components -- shadcn convention: variants are reusable
export const buttonVariants = cva(
  [
    "focus-ring inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md",
    "font-medium transition-[background-color,border-color,color] duration-instant",
    "disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "border border-signal/55 bg-signal/15 text-ink-strong hover:bg-signal/25",
        secondary: "border border-control bg-surface-3 text-ink hover:border-ink-faint hover:bg-panel-hover",
        ghost: "border border-transparent text-ink-muted hover:bg-surface-3/70 hover:text-ink",
        outline: "border border-control bg-transparent text-ink hover:border-signal/60",
        danger: "border border-crit/55 bg-crit/15 text-ink-strong hover:bg-crit/25",
        // v1 name
        violet: "border border-lunar/55 bg-lunar/15 text-ink-strong hover:bg-lunar/25",
      },
      size: {
        xs: "h-7 px-2 text-xs",
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        lg: "h-11 px-5 text-sm",
        touch: "h-11 min-w-11 px-4 text-sm",
        icon: "size-9 p-0",
        "icon-sm": "size-8 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

/**
 * @param {{variant?: string, size?: string, loading?: boolean, type?: string}} props
 *   `loading` shows a spinner, disables the button and sets aria-busy.
 */
export const Button = forwardRef(function Button(
  { className, variant, size, loading = false, disabled, type = "button", children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});
