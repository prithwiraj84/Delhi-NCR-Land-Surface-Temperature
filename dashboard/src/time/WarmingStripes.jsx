/**
 * Warming stripes under the ribbon track (UI_SPEC_v2 §3.3): NCR mean minus the reference
 * period (`timeline.reference_period`, e.g. 2000–2020) on the diverging Polar ramp, one stripe
 * per frame window. Projected frames show the selected SSP's p50 at 60 % alpha; frames without
 * data stay empty (never filled in). The domain is symmetric about 0 so "no change" sits on
 * the ramp's neutral midpoint. Colour is never the only channel: every stripe has a <title>
 * and the values are in the ribbon's "Timeline details" table.
 */
import { memo } from "react";
import { lutRgb } from "../design/ramps.js";
import { fmtSigned } from "../lib/format.js";

/**
 * @param {{cells: Array<{year,x0,x1,value,projected,tier}>, maxAbs:number, y:number, height:number,
 *          referenceLabel?: string|null, sspLabel?: string|null}} props
 */
export const WarmingStripes = memo(function WarmingStripes({ cells, maxAbs, y, height, referenceLabel, sspLabel }) {
  if (!cells?.length) return null;
  const rgb = [0, 0, 0];
  return (
    <g aria-hidden="true" data-testid="warming-stripes">
      {cells.map((c) => {
        const w = Math.max(0, c.x1 - c.x0 - 1); // 1 px surface gap between stripes
        if (!Number.isFinite(c.value)) {
          return <rect key={c.year} x={c.x0} y={y} width={w} height={height} fill="none" stroke="var(--hairline)" strokeDasharray="2 2" />;
        }
        lutRgb("polar", c.value, -maxAbs, maxAbs, rgb);
        return (
          <rect key={c.year} x={c.x0} y={y} width={w} height={height} rx={1} fill={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`} fillOpacity={c.projected ? 0.6 : 1}>
            <title>{`${c.year}: ${fmtSigned(c.value, 1)} °C vs ${referenceLabel ?? "reference"}${c.projected ? ` (${sspLabel ?? "scenario"} p50, projected)` : ""}`}</title>
          </rect>
        );
      })}
    </g>
  );
});
