import { forwardRef, useId } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/cn.js";

/**
 * Radix switch (Space/Enter toggles, role="switch"). With `label`, renders an associated
 * <label> (clicking the text toggles too); otherwise pass an `aria-label`.
 * @param {{checked?: boolean, defaultChecked?: boolean, onCheckedChange?: Function,
 *          label?: React.ReactNode, description?: React.ReactNode, className?: string}} props
 */
export const Switch = forwardRef(function Switch({ className, label, description, id, ...props }, ref) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={switchId}
      className={cn(
        "focus-ring peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-panel-border",
        "bg-panel transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45",
        "data-[state=checked]:border-cyan/60 data-[state=checked]:bg-cyan/30",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-ink-muted shadow transition-transform duration-200",
          "data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-cyan data-[state=checked]:shadow-glow-cyan",
        )}
      />
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    <div className="flex items-start gap-2.5">
      <div className="pt-0.5">{control}</div>
      <label htmlFor={switchId} className="cursor-pointer select-none text-sm leading-tight text-ink">
        {label}
        {description && <span className="mt-0.5 block text-xs text-ink-muted">{description}</span>}
      </label>
    </div>
  );
});
