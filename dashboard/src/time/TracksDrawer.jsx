/**
 * Tracks drawer (UI_SPEC_v2 §3.3, graft from Concept C): 96 px of extra timeline context on
 * the same x-scale as the ribbon.
 *
 *   SENSOR  day (top lane) and night (bottom lane) sensors per frame, merged into runs
 *   NIGHT   night evidence tier per frame (glyph), e.g. ◇ modelled before 2003
 *   COVER   valid-pixel fraction per frame for the display mode (bar height)
 *   NOTES   manifest annotations (◆ 2003 Landsat 7 SLC-off, ◆ 2022 Terra/Aqua drift …)
 *
 * All rows read the manifest (frames[].{day,night}.sensor/tier/coverage, timeline.annotations).
 * A "Table" toggle swaps the graphics for the TimelineDetailsTable.
 */
import { useMemo, useState } from "react";
import { Table2 } from "lucide-react";
import { TierShape } from "../design/glyphs.jsx";
import { cn } from "../lib/cn.js";
import { fmtPct } from "../lib/format.js";
import { TimelineDetailsTable } from "./TimelineDetailsTable.jsx";

export const TRACKS_DRAWER_HEIGHT = 96;
const ROW = 24;
const ROWS = ["Sensor", "Night", "Cover", "Notes"];

/** Merge consecutive ticks with the same sensor string into runs. */
function sensorRuns(frames, mode, scale) {
  const runs = [];
  frames.forEach((f, i) => {
    const entry = f[mode];
    const sensor = entry?.available ? entry.sensor ?? null : null;
    const left = i === 0 ? scale.x0 : (scale.x(frames[i - 1].year) + scale.x(f.year)) / 2;
    const right = i === frames.length - 1 ? scale.x1 : (scale.x(f.year) + scale.x(frames[i + 1].year)) / 2;
    const last = runs[runs.length - 1];
    if (last && last.sensor === sensor) last.x1 = right;
    else runs.push({ sensor, x0: left, x1: right, from: f.year, kind: f.kind });
  });
  return runs.filter((r) => r.sensor);
}

function RunLane({ runs, y, h }) {
  return runs.map((r) => {
    const w = Math.max(0, r.x1 - r.x0 - 2);
    const fits = r.sensor.length * 6.4 + 8 < w;
    return (
      <g key={`${r.from}-${r.sensor}`}>
        <rect x={r.x0 + 1} y={y} width={w} height={h} rx={2} fill={r.kind === "projected" ? "var(--fog)" : "var(--surface-3)"} stroke="var(--hairline)" strokeDasharray={r.kind === "projected" ? "3 3" : undefined}>
          <title>{`${r.sensor} (from ${r.from})`}</title>
        </rect>
        {fits && (
          <text x={r.x0 + 5} y={y + h - 2.5} style={{ font: "10.5px var(--font-mono)", fill: "var(--ink-muted)" }}>
            {r.sensor}
          </text>
        )}
      </g>
    );
  });
}

/**
 * @param {{timeline: object, scale: object, mode: string, svgWidth: number, labelWidth: number,
 *          ncrByYear?: Map<number,number>, ssp?: string|null}} props
 */
export function TracksDrawer({ timeline, scale, mode, svgWidth, labelWidth, ncrByYear, ssp }) {
  const [table, setTable] = useState(false);
  const physical = mode === "night" ? "night" : "day";
  const data = useMemo(() => {
    if (!timeline?.frames?.length || !scale) return null;
    const frames = timeline.frames;
    return {
      day: sensorRuns(frames, "day", scale),
      night: sensorRuns(frames, "night", scale),
      notes: (timeline.annotations ?? []).filter((a) => a.year >= scale.first && a.year <= scale.last),
    };
  }, [timeline, scale]);
  if (!data) return null;

  return (
    <div className="flex border-t border-hairline" style={{ minHeight: TRACKS_DRAWER_HEIGHT }} data-testid="tracks-drawer">
      <div className="flex shrink-0 flex-col justify-between px-3 py-1" style={{ width: labelWidth }}>
        {!table &&
          ROWS.map((r) => (
            <span key={r} className="micro-label leading-[24px]">
              {r}
            </span>
          ))}
        <button
          type="button"
          aria-pressed={table}
          onClick={() => setTable((v) => !v)}
          className={cn("focus-ring mt-auto inline-flex h-7 items-center gap-1 self-start rounded-md px-1.5 font-mono text-[11px] text-ink-muted hover:bg-surface-3 hover:text-ink", table && "text-ink")}
        >
          <Table2 aria-hidden="true" className="size-3.5" strokeWidth={1.5} /> Table
        </button>
      </div>
      {table ? (
        <TimelineDetailsTable timeline={timeline} ncrByYear={ncrByYear} mode={physical} ssp={ssp} className="min-w-0 flex-1 py-1 pr-3" />
      ) : (
        <svg width={svgWidth} height={TRACKS_DRAWER_HEIGHT} role="img" aria-label="Timeline tracks: sensors, night evidence, coverage and notes (the same content is in the Timeline details table)" className="block">
          <RunLane runs={data.day} y={2} h={10} />
          <RunLane runs={data.night} y={13} h={10} />
          {timeline.frames.map((f) => {
            const x = scale.x(f.year);
            const night = f.night;
            const entry = f[physical];
            const cov = Number.isFinite(entry?.coverage) && entry.available ? entry.coverage : null;
            return (
              <g key={f.year}>
                {night?.available ? (
                  <g style={{ color: "var(--ink-muted)" }}>
                    <TierShape tier={night.tier} size={10} x={x - 5} y={ROW + 7} />
                  </g>
                ) : (
                  <path d={`M${x - 3} ${ROW + 12}h6`} stroke="var(--ink-faint)" />
                )}
                {cov !== null ? (
                  <rect x={x - 4} y={2 * ROW + (ROW - 4) * (1 - cov) + 2} width={8} height={Math.max(1, (ROW - 4) * cov)} rx={2} fill="var(--ink-muted)" fillOpacity={f.kind === "projected" ? 0.35 : 0.8}>
                    <title>{`${f.year}: ${fmtPct(cov)} valid pixels (${physical})`}</title>
                  </rect>
                ) : (
                  <path d={`M${x - 3} ${3 * ROW - 3}h6`} stroke="var(--ink-faint)" />
                )}
              </g>
            );
          })}
          {data.notes.map((a, i) => {
            const x = scale.x(a.year);
            const anchor = x > scale.x1 - 120 ? "end" : "start";
            // Two staggered lines so neighbouring notes (e.g. 2002 and 2003) do not collide.
            const cy = 3 * ROW + (i % 2 ? 17 : 7);
            return (
              <g key={`${a.year}-${i}`}>
                <title>{`${a.year}: ${a.label}`}</title>
                <path d={`M${x} ${cy - 4}l4 4-4 4-4-4Z`} fill="var(--ink-muted)" />
                <text x={anchor === "end" ? x - 7 : x + 7} y={cy + 3.5} textAnchor={anchor} style={{ font: "10.5px var(--font-mono)", fill: "var(--ink-muted)" }}>
                  {`${a.year} ${a.label}`}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export default TracksDrawer;
