/**
 * VSUP wedge (UI_SPEC_v2 §4.2): the value-suppressing uncertainty palette as a legend. Rows are
 * the uncertainty tiers U0–U3 by p5–p95 half-width (< 0.5, 0.5–1, 1–2, > 2 °C); each row keeps
 * fewer value bins (16 / 8 / 4 / 2), less chroma and more fog, and U3 is hatched — so the
 * legend shows exactly how the map suppresses precision where projections are uncertain.
 * Colours come from design/ramps.js `vsupRgb`, the CPU reference the shader mirrors.
 */
import { memo, useId } from "react";
import { VSUP_TIERS, vsupRgb } from "../../design/ramps.js";

const ROW_LABELS = ["< ±0.5", "±0.5–1", "±1–2", "> ±2 °C"];

/** @param {{ramp: string, width?: number, className?: string}} props */
export const VsupWedge = memo(function VsupWedge({ ramp, width = 168, className }) {
  const hatchId = `vsup-hatch-${useId().replace(/:/g, "")}`;
  const rowH = 9;
  const labelW = 54;
  const barW = width - labelW;
  return (
    <figure className={className} aria-label="Uncertainty legend: colour precision drops as the p5–p95 half-width grows">
      <svg width={width} height={VSUP_TIERS.length * (rowH + 2)} role="img" aria-hidden="true" className="block">
        <defs>
          <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--void)" strokeOpacity="0.45" strokeWidth="1.2" />
          </pattern>
        </defs>
        {VSUP_TIERS.map((tier, row) => {
          const y = row * (rowH + 2);
          const binW = barW / tier.bins;
          return (
            <g key={tier.id}>
              {Array.from({ length: tier.bins }, (_, b) => {
                const [r, g, bl] = vsupRgb(ramp, (b + 0.5) / tier.bins, row);
                return <rect key={b} x={labelW + b * binW} y={y} width={Math.max(0.5, binW - 0.5)} height={rowH} fill={`rgb(${r}, ${g}, ${bl})`} />;
              })}
              {tier.hatch && <rect x={labelW} y={y} width={barW} height={rowH} fill={`url(#${hatchId})`} />}
              <text x={labelW - 4} y={y + rowH - 1} textAnchor="end" style={{ font: "10.5px var(--font-mono)", fill: "var(--ink-faint)" }}>
                {ROW_LABELS[row]}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-0.5 font-mono text-[11px] text-ink-faint">uncertainty (p5–p95 half-width)</figcaption>
    </figure>
  );
});

export default VsupWedge;
