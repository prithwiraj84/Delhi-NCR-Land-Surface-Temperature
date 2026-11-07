import { cn } from "../../lib/cn.js";

/**
 * Scanline skeleton (UI_SPEC §5.2 K): surface-2 blocks with a 1 px signal line @ 30 % sweeping
 * every 1.6 s (static under Reduced/Off motion). Announces "Loading …" once to assistive
 * technology via role="status"; the blocks themselves are hidden from it.
 * @param {{label?: string, lines?: number, height?: number|string, className?: string,
 *          blockClassName?: string, detail?: React.ReactNode}} props
 *   `lines` > 1 renders stacked bars (last one shorter); otherwise one block of `height`.
 */
export function ScanSkeleton({ label = "Loading", lines = 1, height = 96, className, blockClassName, detail }) {
  const h = typeof height === "number" ? `${height}px` : height;
  return (
    <div role="status" aria-live="polite" className={cn("flex w-full flex-col gap-2", className)}>
      <span className="sr-only">{label}…</span>
      {lines > 1 ? (
        Array.from({ length: lines }, (_, i) => (
          <div key={i} aria-hidden="true" className={cn("scan-skeleton h-3", i === lines - 1 && "w-2/3", blockClassName)} />
        ))
      ) : (
        <div aria-hidden="true" className={cn("scan-skeleton w-full", blockClassName)} style={{ height: h }} />
      )}
      {detail && <p className="micro-label">{detail}</p>}
    </div>
  );
}
