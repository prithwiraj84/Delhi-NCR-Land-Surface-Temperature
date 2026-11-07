/**
 * Glass tooltip for SVG/canvas charts (UI_SPEC §4.6): mono values, always the tier glyph,
 * source and n. Positioned inside the chart's relative container and flipped to stay inside.
 * It enhances, never gates: every value is also in the chart's table view.
 * @param {{x: number, y: number, width: number, children: React.ReactNode, visible?: boolean}} props
 */
export function ChartTip({ x, y, width, children, visible = true }) {
  if (!visible) return null;
  const left = x > width * 0.62;
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-hairline-strong bg-surface-2/95 px-2.5 py-1.5 text-[11px] leading-snug text-ink shadow-panel"
      style={{ left: left ? undefined : x + 12, right: left ? width - x + 12 : undefined, top: Math.max(0, y - 8) }}
    >
      {children}
    </div>
  );
}

export default ChartTip;
