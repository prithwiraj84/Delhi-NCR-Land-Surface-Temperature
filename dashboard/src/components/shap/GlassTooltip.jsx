/**
 * Glass tooltip shell shared by the explorer's charts (Recharts `content` renderers and the
 * HTML heatmap). Values lead, labels follow: the number is the strong element and the
 * series name is secondary; series are keyed by a short line/swatch, never by coloured text.
 */
import { cn } from "../../lib/cn.js";

/** Outer glass card. `className` lets a caller position it (e.g. absolutely in a heatmap). */
export function GlassTooltipCard({ title, children, className, style }) {
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-none min-w-[11rem] max-w-[18rem] rounded-lg border border-panel-border",
        "bg-slate-900/85 px-3 py-2 text-xs text-ink shadow-glass backdrop-blur-md",
        className,
      )}
      style={style}
    >
      {title ? <div className="mb-1.5 font-mono text-[11px] text-ink-muted">{title}</div> : null}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/**
 * One tooltip row: coloured key + strong value + muted label.
 * `keyShape` "line" (for lines/curves) or "dot" (for points/cells) mirrors the mark.
 */
export function TooltipRow({ color, value, label, keyShape = "line" }) {
  return (
    <div className="flex items-baseline gap-2">
      {color ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-block shrink-0 translate-y-[-2px]",
            keyShape === "line" ? "h-0.5 w-3" : "h-2 w-2 rounded-full",
          )}
          style={{ backgroundColor: color }}
        />
      ) : null}
      <span className="font-mono text-[12px] font-semibold text-ink-strong">{value}</span>
      <span className="truncate text-ink-muted">{label}</span>
    </div>
  );
}
