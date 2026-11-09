/**
 * THRESHOLD-CROSSING YEARS (UI_SPEC §3.5; SPEC §4.10 "threshold years = first projected frame
 * where the scope p50 exceeds L_base + {1,2,3} °C"): a real table, district × SSP × {+1, +2,
 * +3 °C}. "—" means the threshold is not crossed by the last projected frame. Projections are
 * a model + CMIP6 scenario, not observations.
 */
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { cn } from "../../lib/cn.js";
import { sspStyle } from "../../viz/chartTheme.js";
import { Unavailable } from "../../viz/Unavailable.jsx";
import { thresholdRows } from "./timelineModel.js";

export function ThresholdYearTable({ series, mode, ssps, selectedScope, reason = null, last = 2050 }) {
  const rows = series && !reason ? thresholdRows(series, mode, ssps) : [];
  const any = rows.some((r) => ssps.some((id) => ["+1", "+2", "+3"].some((k) => r[`${id}${k}`] !== null)));
  return (
    <HudFrame solid title={`Threshold-crossing years · ${mode}`} className="min-w-0">
      {reason || !ssps.length ? (
        <Unavailable reason={reason ?? "No scenarios selected or exported."} />
      ) : !any ? (
        <Unavailable reason={`No scope crosses +1 °C over its baseline by ${last}, or threshold years were not exported.`} />
      ) : (
        <div tabIndex={0} role="region" aria-label="Threshold-crossing years table (scrollable)" className="scrollbar-thin focus-ring max-h-[300px] overflow-auto rounded-md">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">
              First projected frame whose median exceeds the scope&apos;s weather-normalised baseline by 1, 2 and 3 °C, per scenario. A dash means not crossed by {last}.
            </caption>
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                <th scope="col" rowSpan={2} className="border-b border-hairline px-2 py-1 text-left font-sans text-[11px] font-medium text-ink-faint">
                  Scope
                </th>
                {ssps.map((id) => (
                  <th key={id} scope="colgroup" colSpan={3} className="border-b border-hairline px-2 py-1 text-center font-mono text-[11px] font-medium text-ink-muted">
                    {sspStyle(id).label}
                  </th>
                ))}
              </tr>
              <tr>
                {ssps.flatMap((id) =>
                  ["+1", "+2", "+3"].map((k) => (
                    <th key={`${id}${k}`} scope="col" className="border-b border-hairline px-1.5 py-1 text-right font-mono text-[10.5px] font-normal text-ink-faint">
                      {k} °C
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cn("border-b border-hairline/50", r.id === selectedScope && "bg-signal/10")}>
                  <th scope="row" className="px-2 py-1 text-left font-normal text-ink">
                    {r.label}
                  </th>
                  {ssps.flatMap((id) =>
                    ["+1", "+2", "+3"].map((k) => (
                      <td key={`${id}${k}`} className={cn("tnum px-1.5 py-1 text-right font-mono", r[`${id}${k}`] ? "text-ink" : "text-ink-faint")}>
                        {r[`${id}${k}`] ?? "—"}
                      </td>
                    )),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </HudFrame>
  );
}

export default ThresholdYearTable;
