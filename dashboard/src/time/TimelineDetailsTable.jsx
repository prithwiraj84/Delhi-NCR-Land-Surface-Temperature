/**
 * "Timeline details" table (UI_SPEC_v2 §12): the ribbon's track content as a real <table>, so
 * everything the patterned track, ticks and stripes encode is available to screen readers and
 * keyboard users (ticks are not tab stops). Rendered visually hidden inside the ribbon, and
 * visibly from the Tracks drawer's "Table" toggle.
 */
import { TierShape } from "../design/glyphs.jsx";
import { normalizeTier, TIER_META } from "../design/tiers.js";
import { cn } from "../lib/cn.js";
import { fmt, fmtPct, MISSING } from "../lib/format.js";

function TierCell({ entry }) {
  if (!entry?.available || !entry?.tier) return <span className="text-ink-faint">no data</span>;
  const id = normalizeTier(entry.tier);
  return (
    <span className="inline-flex items-center gap-1">
      <TierShape tier={id} size={10} />
      {TIER_META[id]?.label ?? entry.tier}
    </span>
  );
}

/**
 * @param {{timeline: object, ncrByYear?: Map<number, number>, mode: string, ssp?: string|null,
 *          visuallyHidden?: boolean, className?: string}} props
 */
export function TimelineDetailsTable({ timeline, ncrByYear = new Map(), mode, ssp = null, visuallyHidden = false, className }) {
  if (!timeline?.frames?.length) return null;
  return (
    <div className={cn(visuallyHidden ? "sr-only" : "scrollbar-thin max-h-56 overflow-auto", className)}>
      <table className="w-full border-collapse text-left font-mono text-[11px] text-ink">
        <caption className={visuallyHidden ? undefined : "micro-label pb-1 text-left"}>
          Timeline details · tiers from the bundle manifest · NCR mean ({mode}
          {ssp ? `, projections ${ssp}` : ""})
        </caption>
        <thead className="text-ink-faint">
          <tr>
            {["Frame", "Window", "Kind", "Day tier", "Day sensor", "Night tier", "Night sensor", "Scenes (day)", "Coverage", "NCR mean °C"].map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap border-b border-hairline px-2 py-1 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {timeline.frames.map((f) => {
            const entry = mode === "night" ? f.night : f.day;
            return (
              <tr key={f.year} className="border-b border-hairline/60">
                <th scope="row" className="px-2 py-1 font-semibold text-ink-strong">
                  {f.year}
                </th>
                <td className="whitespace-nowrap px-2 py-1">{f.window[0] === f.window[1] ? f.window[0] : `${f.window[0]}–${f.window[1]}`}</td>
                <td className="px-2 py-1">{f.kind}</td>
                <td className="whitespace-nowrap px-2 py-1">
                  <TierCell entry={f.day} />
                </td>
                <td className="px-2 py-1 text-ink-muted">{f.day?.sensor ?? MISSING}</td>
                <td className="whitespace-nowrap px-2 py-1">
                  <TierCell entry={f.night} />
                </td>
                <td className="px-2 py-1 text-ink-muted">{f.night?.sensor ?? MISSING}</td>
                <td className="tnum px-2 py-1">{Number.isFinite(f.day?.scenes) ? f.day.scenes : MISSING}</td>
                <td className="tnum px-2 py-1">{Number.isFinite(entry?.coverage) ? fmtPct(entry.coverage) : MISSING}</td>
                <td className="tnum px-2 py-1">{Number.isFinite(ncrByYear.get(f.year)) ? fmt(ncrByYear.get(f.year), 1) : MISSING}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default TimelineDetailsTable;
