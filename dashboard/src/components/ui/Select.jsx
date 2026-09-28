import { forwardRef, useId } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn.js";

const SIZES = {
  sm: "h-8 pl-2.5 pr-8 text-xs",
  md: "h-9 pl-3 pr-9 text-sm",
};

/**
 * Styled native <select> (native keyboard + screen-reader behaviour, works on mobile).
 * Options come from `options` ([{value, label, disabled?}] or [{label, options: [...]}]
 * for <optgroup>s) or from children. `onValueChange(value)` is a convenience alongside the
 * native `onChange(event)`.
 * @param {{value?: string|number, onChange?: Function, onValueChange?: Function, options?: Array,
 *          label?: React.ReactNode, hideLabel?: boolean, size?: "sm"|"md", className?: string}} props
 */
export const Select = forwardRef(function Select(
  { className, selectClassName, label, hideLabel = false, options, onChange, onValueChange, size = "md", id, children, ...props },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;

  const handleChange = (event) => {
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  const renderOption = (opt) => (
    <option key={String(opt.value)} value={opt.value} disabled={opt.disabled}>
      {opt.label ?? String(opt.value)}
    </option>
  );

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      {label && (
        <label
          htmlFor={selectId}
          className={cn("text-[11px] font-medium uppercase tracking-wider text-ink-muted", hideLabel && "sr-only")}
        >
          {label}
        </label>
      )}
      <div className="relative min-w-0">
        <select
          ref={ref}
          id={selectId}
          onChange={handleChange}
          className={cn(
            "focus-ring w-full min-w-0 cursor-pointer appearance-none truncate rounded-lg border border-panel-border",
            "bg-bg-raised/80 text-ink transition-colors hover:border-ink-faint/60 disabled:cursor-not-allowed disabled:opacity-45",
            SIZES[size] ?? SIZES.md,
            selectClassName,
          )}
          {...props}
        >
          {options
            ? options.map((opt) =>
                Array.isArray(opt.options) ? (
                  <optgroup key={opt.label} label={opt.label}>
                    {opt.options.map(renderOption)}
                  </optgroup>
                ) : (
                  renderOption(opt)
                ),
              )
            : children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
        />
      </div>
    </div>
  );
});
