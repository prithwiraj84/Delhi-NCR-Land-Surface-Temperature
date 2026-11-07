import { forwardRef } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import { cn } from "../../lib/cn.js";

/** App-wide tooltip provider (mounted once in App; InfoTip also works without it). */
export const TooltipProvider = TooltipPrimitive.Provider;

/** Solid glass tooltip bubble (portal-rendered, collision-aware). */
export const TooltipContent = forwardRef(function TooltipContent({ className, sideOffset = 6, children, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn("glass-strong z-toast max-w-xs rounded-md px-3 py-2 text-xs leading-relaxed text-ink", "tooltip-pop", className)}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-surface-2" width={10} height={5} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
});

/**
 * Small "i" button that explains a metric on hover or keyboard focus.
 * Pass `children` to use a custom trigger element instead of the icon.
 * @param {{content: React.ReactNode, label?: string, side?: "top"|"right"|"bottom"|"left",
 *          children?: React.ReactElement, className?: string}} props
 */
export function InfoTip({ content, label = "More information", side = "top", children, className }) {
  return (
    <TooltipPrimitive.Provider delayDuration={150} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          {children ?? (
            <button
              type="button"
              aria-label={label}
              className={cn(
                "focus-ring inline-flex size-6 items-center justify-center rounded-full text-ink-faint transition-colors duration-instant hover:text-signal",
                className,
              )}
            >
              <Info aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </TooltipPrimitive.Trigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/**
 * Tooltip for icon-only buttons (UI_SPEC §4.4: icon-only buttons carry aria-label plus a
 * tooltip). The child element must carry its own aria-label; the tooltip repeats it visually.
 * @param {{label: React.ReactNode, side?: string, children: React.ReactElement}} props
 */
export function IconTip({ label, side = "bottom", children }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipContent side={side} className="font-mono text-[11px] uppercase tracking-[0.08em]">
          {label}
        </TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
