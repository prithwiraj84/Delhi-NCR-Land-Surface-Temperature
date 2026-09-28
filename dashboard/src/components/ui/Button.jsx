import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/cn.js";

/** shadcn-style button with neon accents and a visible keyboard focus ring. */
// eslint-disable-next-line react-refresh/only-export-components -- shadcn convention: variants are reusable
export const buttonVariants = cva(
  [
    "focus-ring inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg",
    "font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150",
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "border border-cyan/50 bg-cyan/15 text-cyan-soft hover:bg-cyan/25 hover:shadow-glow-cyan",
        secondary: "border border-panel-border bg-panel/70 text-ink hover:border-ink-faint/60 hover:bg-panel-hover",
        ghost: "border border-transparent text-ink-muted hover:bg-panel/60 hover:text-ink",
        outline: "border border-panel-border bg-transparent text-ink hover:border-cyan/45 hover:text-cyan-soft",
        violet: "border border-violet/50 bg-violet/15 text-violet-soft hover:bg-violet/25 hover:shadow-glow-violet",
        danger: "border border-rose/50 bg-rose/15 text-rose-soft hover:bg-rose/25 hover:shadow-glow-rose",
      },
      size: {
        xs: "h-7 px-2 text-xs",
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        lg: "h-11 px-5 text-sm",
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
