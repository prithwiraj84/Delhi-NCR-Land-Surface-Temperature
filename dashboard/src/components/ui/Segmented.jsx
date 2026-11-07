import { useRef } from "react";
import { motion } from "framer-motion";
import { springs } from "../../design/motion.js";
import { useMotionLevel } from "../../design/useMotionLevel.js";
import { cn } from "../../lib/cn.js";

/**
 * Segmented control = radio group with roving tabindex (UI_SPEC §12): one tab stop, arrow
 * keys move AND select (wrapping), Home/End jump to the ends, disabled options are skipped.
 * The active indicator is a surface-3 pill with a 2 px signal underline that slides with the
 * spring-ui token (chrome only; it jumps under Reduced/Off motion).
 *
 * Unavailable options stay visible with their reason (e.g. "Night unavailable in v1
 * bundle") in the tooltip and accessible description, instead of disappearing.
 *
 * @param {{value: string, onChange: (value: string) => void, options: Array<{value: string,
 *          label: React.ReactNode, icon?: React.ReactNode, disabled?: boolean, reason?: string,
 *          title?: string}>, ariaLabel: string, size?: "sm"|"md"|"touch", className?: string,
 *          layoutId?: string, accent?: (value: string) => string|undefined}} props
 *   `accent(value)` optionally returns a CSS colour for the active underline (e.g. solar for
 *   Day, lunar for Night) - the label/icon still identifies the option.
 */
export function Segmented({ value, onChange, options, ariaLabel, size = "md", className, layoutId, accent }) {
  const refs = useRef([]);
  const level = useMotionLevel();
  const enabled = options.map((o) => !o.disabled);

  const move = (from, delta) => {
    const n = options.length;
    for (let step = 1; step <= n; step += 1) {
      const i = (from + delta * step + n * n) % n;
      if (enabled[i]) return i;
    }
    return from;
  };

  const onKeyDown = (event, index) => {
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = move(index, 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = move(index, -1);
    else if (event.key === "Home") next = enabled.indexOf(true);
    else if (event.key === "End") next = enabled.lastIndexOf(true);
    if (next === null || next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    refs.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  };

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const heights = { sm: "h-7 text-xs", md: "h-8 text-[13px]", touch: "h-11 text-sm" }[size] ?? "h-8 text-[13px]";

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("inline-flex items-center gap-0.5 rounded-md border border-control/80 bg-surface-2 p-0.5", className)}>
      {options.map((opt, i) => {
        const selected = opt.value === value;
        const tabbable = selected || (!options.some((o) => o.value === value) && i === selectedIndex);
        const descId = opt.reason ? `${layoutId ?? ariaLabel}-${opt.value}-reason`.replace(/\s+/g, "-") : undefined;
        return (
          <button
            key={opt.value}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={opt.disabled || undefined}
            aria-describedby={descId}
            tabIndex={tabbable ? 0 : -1}
            title={opt.disabled ? opt.reason : opt.title}
            onClick={() => !opt.disabled && !selected && onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "focus-ring relative inline-flex min-w-6 select-none items-center justify-center gap-1.5 rounded px-2.5 font-medium transition-colors duration-instant",
              heights,
              selected ? "text-ink-strong" : "text-ink-muted hover:text-ink",
              opt.disabled && "cursor-not-allowed opacity-50 hover:text-ink-muted",
            )}
          >
            {selected && (
              <motion.span
                aria-hidden="true"
                layoutId={layoutId ? `${layoutId}-indicator` : undefined}
                transition={level === "full" ? springs.ui : { duration: 0 }}
                className="absolute inset-0 rounded bg-surface-3"
                style={{ boxShadow: `inset 0 -2px 0 0 ${accent?.(opt.value) ?? "var(--signal)"}` }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {opt.icon}
              {opt.label}
            </span>
            {descId && (
              <span id={descId} className="sr-only">
                {opt.reason}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
