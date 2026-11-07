import { forwardRef, useCallback } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "../../lib/cn.js";

const TONES = {
  signal: { range: "bg-signal", thumb: "border-signal" },
  solar: { range: "bg-solar", thumb: "border-solar" },
  lunar: { range: "bg-lunar", thumb: "border-lunar" },
  ok: { range: "bg-ok", thumb: "border-ok" },
  crit: { range: "bg-crit", thumb: "border-crit" },
  // v1 names
  cyan: { range: "bg-signal", thumb: "border-signal" },
  violet: { range: "bg-lunar", thumb: "border-lunar" },
  emerald: { range: "bg-ok", thumb: "border-ok" },
  rose: { range: "bg-crit", thumb: "border-crit" },
};

/**
 * Radix slider (keyboard: arrows, PageUp/Down, Home/End). Accepts `value`/`defaultValue`
 * as a number or an array; `onValueChange`/`onValueCommit` receive the same shape.
 * Track: surface-3 with a control-border outline (>= 3:1); 24 px tall hit area.
 * @param {{value?: number|number[], defaultValue?: number|number[], onValueChange?: Function,
 *          onValueCommit?: Function, min?: number, max?: number, step?: number,
 *          tone?: string, thumbLabel?: string, className?: string}} props
 */
export const Slider = forwardRef(function Slider(
  { className, value, defaultValue, onValueChange, onValueCommit, tone = "signal", thumbLabel, ...props },
  ref,
) {
  const scalar = typeof (value ?? defaultValue) === "number";
  const toArray = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
  const fromArray = useCallback((v) => (scalar ? v[0] : v), [scalar]);
  const values = toArray(value);
  const defaults = toArray(defaultValue);
  const thumbCount = (values ?? defaults ?? [0]).length;
  const styles = TONES[tone] ?? TONES.signal;

  return (
    <SliderPrimitive.Root
      ref={ref}
      value={values}
      defaultValue={defaults}
      onValueChange={onValueChange ? (v) => onValueChange(fromArray(v)) : undefined}
      onValueCommit={onValueCommit ? (v) => onValueCommit(fromArray(v)) : undefined}
      className={cn("relative flex h-6 w-full touch-none select-none items-center data-[disabled]:opacity-45", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full border border-control/70 bg-surface-3">
        <SliderPrimitive.Range className={cn("absolute h-full rounded-full", styles.range)} />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={thumbLabel ?? props["aria-label"]}
          className={cn(
            "block size-4 cursor-grab rounded-full border-2 bg-bg transition-transform duration-instant",
            "hover:scale-110 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            styles.thumb,
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
});
