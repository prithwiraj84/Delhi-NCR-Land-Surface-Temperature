import { forwardRef, useCallback } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "../../lib/cn.js";

const TONES = {
  cyan: { range: "bg-gradient-to-r from-cyan/70 to-cyan", thumb: "border-cyan shadow-glow-cyan" },
  violet: { range: "bg-gradient-to-r from-violet/70 to-violet", thumb: "border-violet shadow-glow-violet" },
  emerald: { range: "bg-gradient-to-r from-emerald/70 to-emerald", thumb: "border-emerald shadow-glow-emerald" },
  rose: { range: "bg-gradient-to-r from-rose/70 to-rose", thumb: "border-rose shadow-glow-rose" },
};

/**
 * Radix slider (keyboard: arrows, PageUp/Down, Home/End). Accepts `value`/`defaultValue`
 * as a number or an array; `onValueChange`/`onValueCommit` receive the same shape.
 * @param {{value?: number|number[], defaultValue?: number|number[], onValueChange?: Function,
 *          onValueCommit?: Function, min?: number, max?: number, step?: number,
 *          tone?: "cyan"|"violet"|"emerald"|"rose", thumbLabel?: string, className?: string}} props
 */
export const Slider = forwardRef(function Slider(
  { className, value, defaultValue, onValueChange, onValueCommit, tone = "cyan", thumbLabel, ...props },
  ref,
) {
  const scalar = typeof (value ?? defaultValue) === "number";
  const toArray = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
  const fromArray = useCallback((v) => (scalar ? v[0] : v), [scalar]);
  const values = toArray(value);
  const defaults = toArray(defaultValue);
  const thumbCount = (values ?? defaults ?? [0]).length;
  const styles = TONES[tone] ?? TONES.cyan;

  return (
    <SliderPrimitive.Root
      ref={ref}
      value={values}
      defaultValue={defaults}
      onValueChange={onValueChange ? (v) => onValueChange(fromArray(v)) : undefined}
      onValueCommit={onValueCommit ? (v) => onValueCommit(fromArray(v)) : undefined}
      className={cn(
        "relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-45",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-panel-border">
        <SliderPrimitive.Range className={cn("absolute h-full rounded-full", styles.range)} />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={thumbLabel ?? props["aria-label"]}
          className={cn(
            "block size-4 cursor-grab rounded-full border-2 bg-bg transition-transform duration-150",
            "hover:scale-110 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            styles.thumb,
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
});
