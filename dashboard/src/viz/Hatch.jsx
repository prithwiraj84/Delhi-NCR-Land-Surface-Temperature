/**
 * SVG pattern definitions shared by the analysis charts (UI_SPEC §4.6, §1 principle 5):
 *   recon  2 px diagonal hatch at 45° (reconstructed / modelled confidence bands)
 *   aoa    135° hatch (outside the area of applicability)
 *   fog    sparse dots over a fog tint (projected columns / fogged areas)
 * Strokes use --hatch (rgba(223,231,242,.22)); under forced colours they switch to CanvasText
 * (index.css), so the pattern survives high-contrast modes. Reference with
 * `hatchUrl(prefix, kind)` from chartTheme.js.
 * @param {{prefix: string}} props
 */
export function HatchDefs({ prefix }) {
  return (
    <defs>
      <pattern id={`${prefix}-hatch-recon`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="rgba(140,160,200,0.08)" />
        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatch, rgba(223,231,242,0.22))" strokeWidth="1.5" />
      </pattern>
      <pattern id={`${prefix}-hatch-aoa`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatch, rgba(223,231,242,0.22))" strokeWidth="1.5" />
      </pattern>
      <pattern id={`${prefix}-hatch-fog`} width="5" height="5" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" fill="var(--fog, rgba(140,160,200,0.10))" />
        <circle cx="1.25" cy="1.25" r="0.6" fill="var(--hatch, rgba(223,231,242,0.22))" />
      </pattern>
    </defs>
  );
}

/**
 * Small inline swatch of a pattern for legends (so the legend shows the same texture).
 * @param {{kind?: "recon"|"aoa"|"fog", label: string}} props
 */
export function HatchSwatch({ kind = "recon", label }) {
  const id = `swatch-${kind}`;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
      <svg width="14" height="10" aria-hidden="true" className="shrink-0 rounded-sm">
        <HatchDefs prefix={id} />
        <rect width="14" height="10" fill={`url(#${id}-hatch-${kind})`} stroke="rgba(160,185,225,0.28)" />
      </svg>
      {label}
    </span>
  );
}
