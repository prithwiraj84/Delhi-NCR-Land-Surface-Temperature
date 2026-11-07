/**
 * FRAME PROVENANCE TABLE (UI_SPEC §3.9): every frame × mode with its evidence tier (glyph +
 * text, from the manifest — never derived from the year), sensor, overpass time (IST),
 * compositing window, scene/composite count, coverage, native resolution and whether XAI and
 * 250 m rasters exist. Unavailable frame × mode pairs keep their row and say why. Filterable
 * by mode; a real <table>.
 */
import { useState } from "react";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { TierGlyph } from "../../components/ui/TierGlyph.jsx";
import { fmtPct, MISSING } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

export function FrameProvenanceTable({ rows }) {
  const [mode, setMode] = useState("all");
  const shown = rows.filter((r) => mode === "all" || r.mode === mode);
  return (
    <HudFrame
      solid
      title="Frame provenance"
      className="min-w-0"
      actions={
        <Segmented
          ariaLabel="Filter frames by mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "all", label: "All" },
            { value: "day", label: "Day" },
            { value: "night", label: "Night" },
          ]}
          layoutId="prov-mode"
        />
      }
    >
      <div tabIndex={0} role="region" aria-label="Frame provenance table (scrollable)" className="scrollbar-thin focus-ring max-h-[420px] overflow-auto rounded-md">
        <table className="w-full min-w-[760px] border-collapse text-xs">
          <caption className="sr-only">Every frame and mode with its evidence tier, sensor, overpass time, compositing window, scenes, coverage and native resolution.</caption>
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              {["Frame", "Mode", "Tier", "Sensor / source", "Overpass IST", "Window", "Scenes", "Coverage", "Native", "XAI · 250 m"].map((h) => (
                <th key={h} scope="col" className="border-b border-hairline px-2 py-1.5 text-left font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={cn("border-b border-hairline/50", !r.available && "text-ink-faint")}>
                <th scope="row" className="tnum px-2 py-1 text-left font-mono font-normal text-ink">
                  {r.year}
                </th>
                <td className="px-2 py-1">{r.mode}</td>
                <td className="px-2 py-1">{r.available ? <TierGlyph tier={r.tier} variant="label" /> : <span title={r.reason}>{MISSING} {r.reason}</span>}</td>
                <td className="px-2 py-1 text-ink">{r.sensor ?? MISSING}</td>
                <td className="tnum px-2 py-1 font-mono">{r.overpass ?? MISSING}</td>
                <td className="tnum px-2 py-1 font-mono">{r.window ?? MISSING}</td>
                <td className="tnum px-2 py-1 text-right font-mono">{r.scenes ?? MISSING}</td>
                <td className="tnum px-2 py-1 text-right font-mono">{Number.isFinite(r.coverage) ? fmtPct(r.coverage, 0) : MISSING}</td>
                <td className="tnum px-2 py-1 text-right font-mono">{r.native ? `${r.native} m` : MISSING}</td>
                <td className="px-2 py-1 text-[11px]">
                  {r.xai ? "XAI" : "—"} · {r.raster ? "250 m" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </HudFrame>
  );
}

export default FrameProvenanceTable;
