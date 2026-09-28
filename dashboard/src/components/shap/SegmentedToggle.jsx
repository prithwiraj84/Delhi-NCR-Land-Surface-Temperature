/**
 * Compact segmented control (a radio group styled as pills) used for the explorer's local
 * view toggles (importance scope, colour mode, interaction scope, region type).
 * Keyboard: Tab focuses the checked option; Arrow keys move and select (WAI-ARIA radio group).
 */
import { useRef } from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/cn.js";

/**
 * @param {object} props
 * @param {string} props.label             accessible name of the group
 * @param {Array<{value: string, label: string, dot?: string, title?: string}>} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {string} [props.layoutId]        unique id for the animated selection pill
 * @param {string} [props.className]
 */
export default function SegmentedToggle({ label, options, value, onChange, layoutId, className }) {
  const refs = useRef([]);
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const move = (offset) => {
    const next = (activeIndex + offset + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-panel-border bg-slate-950/50 p-0.5",
        className,
      )}
    >
      {options.map((option, i) => {
        const checked = i === activeIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium outline-none",
              "transition-colors focus-visible:ring-2 focus-visible:ring-cyan/70",
              checked ? "text-ink-strong" : "text-ink-muted hover:text-ink",
            )}
          >
            {checked ? (
              <motion.span
                layoutId={layoutId}
                aria-hidden="true"
                className="absolute inset-0 rounded-md border border-cyan/30 bg-cyan/10 shadow-[0_0_12px_-4px_rgba(34,211,238,0.6)]"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            ) : null}
            {option.dot ? (
              <span
                aria-hidden="true"
                className="relative h-2 w-2 rounded-full"
                style={{ backgroundColor: option.dot }}
              />
            ) : null}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
