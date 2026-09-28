/**
 * Glass tooltip + legend primitives for the hand-built SVG charts of the performance and
 * zoning views. Values lead and labels follow (the number is the strong element); series
 * are keyed by a short stroke / dot in the series colour, never by coloured text.
 *
 * Tooltips only ever enhance: every value they show is also available as a direct label,
 * an aria-label or a table, so they are aria-hidden to avoid double announcements.
 */
import { cn } from "../../lib/cn.js";

const TOOLTIP_OFFSET = 14;

/**
 * Absolutely positioned tooltip inside a `relative` chart container. Flips to the left of
 * the pointer when it would overflow the container's right edge.
 * @param {{x: number, y: number, containerWidth: number, title?: React.ReactNode,
 *          children: React.ReactNode, width?: number}} props
 */
export function ChartTooltip({ x, y, containerWidth, title, children, width = 208 }) {
  const flip = x + TOOLTIP_OFFSET + width > containerWidth;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-20 rounded-lg border border-panel-border bg-slate-900/90 px-3 py-2",
        "text-xs text-ink shadow-glass backdrop-blur-md",
      )}
      style={{
        left: x,
        top: y,
        width,
        transform: flip
          ? `translate(calc(-100% - ${TOOLTIP_OFFSET}px), -50%)`
          : `translate(${TOOLTIP_OFFSET}px, -50%)`,
      }}
    >
      {title ? <div className="mb-1.5 truncate font-mono text-[11px] text-ink-muted">{title}</div> : null}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/**
 * One tooltip row: series key (line or dot) + strong value + muted label.
 * @param {{color?: string, value: React.ReactNode, label?: React.ReactNode, keyShape?: "line"|"dot"}} props
 */
export function TooltipRow({ color, value, label, keyShape = "line" }) {
  return (
    <div className="flex items-baseline gap-2">
      {color ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-block shrink-0 -translate-y-0.5",
            keyShape === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-full",
          )}
          style={{ backgroundColor: color }}
        />
      ) : null}
      <span className="kpi-number font-mono text-[12px] font-semibold text-ink-strong">{value}</span>
      {label ? <span className="min-w-0 truncate text-ink-muted">{label}</span> : null}
    </div>
  );
}

/**
 * Chart legend: swatches mirror the mark ("rect" for bars/areas, "line" for lines,
 * "dot" for points). Text stays in ink tokens.
 * @param {{items: {key: string, label: React.ReactNode, color: string, shape?: "rect"|"line"|"dot"}[],
 *          className?: string, label?: string}} props
 */
export function ChartLegend({ items, className, label = "Legend" }) {
  return (
    <ul aria-label={label} className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted", className)}>
      {items.map((item) => (
        <li key={item.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "inline-block shrink-0",
              item.shape === "line" && "h-0.5 w-3.5 rounded-full",
              item.shape === "dot" && "size-2.5 rounded-full",
              (!item.shape || item.shape === "rect") && "h-2.5 w-3 rounded-[3px]",
            )}
            style={{ backgroundColor: item.color }}
          />
          <span className="text-ink">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
