/**
 * ATLAS (UI_SPEC §3.5): small multiples of every frame, one Day row and one Night row, on the
 * FIXED per-mode domain (thumbnails compare across years), the current frame ringed, click =
 * set the year (and mode). Projected thumbnails show the selected SSP's p50 with a dashed
 * frame and the ○ tier; a mode that the bundle lacks shows its reason instead of a row.
 */
import { useMemo } from "react";
import { useCells, useCube, useTimeline } from "../../data/hooks.js";
import { cubeFrameIndex, decodeCubeFrame } from "../../data/cubes.js";
import { domainFor, modeAvailable, modeUnavailableReason, tierOf } from "../../data/timeline.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { rampGradientCss } from "../../design/ramps.js";
import { fmt } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { SmallMultiples } from "../../viz/SmallMultiples.jsx";
import { cellPixels } from "../../viz/thumbRaster.js";
import { Unavailable } from "../../viz/Unavailable.jsx";

const RAMP = { day: "solar", night: "nocturne" };

/** Ring the frame the map shows (same year and mode). */
function markCurrent(items, m, year, mode) {
  const shown = mode === "dtr" ? "day" : mode;
  return items.map((it) => (it.year === year && m === shown ? { ...it, current: true } : it));
}

function useModeItems(mode, ssp, timeline, enabled) {
  const obs = useCube(enabled ? mode : null, "obs");
  const proj = useCube(enabled && ssp ? mode : null, ssp ?? "obs");
  return useMemo(() => {
    if (!timeline || !enabled) return { items: [], status: "unavailable" };
    const domain = domainFor(timeline, mode, "abs");
    if (!domain) return { items: [], status: "unavailable", reason: `No fixed ${mode} domain in this bundle` };
    const items = timeline.frames.map((frame) => {
      const cube = frame.kind === "projected" ? proj : obs;
      let values = null;
      let reason = null;
      if (cube.status === "ready") {
        const f = cubeFrameIndex(cube.data, frame.year);
        if (f >= 0) values = decodeCubeFrame(cube.data, f, { q: "p50" });
        else reason = `${frame.year} is not in the ${frame.kind === "projected" ? ssp : "observation"} cube`;
      } else if (cube.status !== "loading" && cube.status !== "idle") reason = cube.reason ?? "unavailable";
      return {
        key: `${mode}-${frame.kind === "projected" ? ssp : "obs"}-${frame.year}`,
        year: frame.year,
        mode,
        label: `${frame.year} ${mode}${frame.kind === "projected" ? ` ${ssp}` : ""}`,
        tier: tierOf(timeline, frame.year, mode),
        values,
        reason,
        ramp: RAMP[mode],
        domain,
        projected: frame.kind === "projected",
      };
    });
    return { items, status: obs.status, reason: obs.reason, domain };
  }, [timeline, enabled, obs, proj, mode, ssp]);
}

export function AtlasStrip({ ssp }) {
  const tl = useTimeline();
  const cells = useCells();
  const timeline = tl.status === "ready" ? tl.data : null;
  const year = useTimeStore((s) => s.year);
  const mode = useTimeStore((s) => s.mode);
  const dayOk = modeAvailable(timeline, "day");
  const nightOk = modeAvailable(timeline, "night");
  const day = useModeItems("day", ssp, timeline, dayOk);
  const night = useModeItems("night", ssp, timeline, nightOk);
  const grid = useMemo(() => (cells.status === "ready" ? cellPixels(cells.data, 140) : null), [cells]);

  const dayItems = useMemo(() => markCurrent(day.items, "day", year, mode), [day.items, year, mode]);
  const nightItems = useMemo(() => markCurrent(night.items, "night", year, mode), [night.items, year, mode]);

  const onSelect = (item) => {
    const s = useTimeStore.getState();
    s.setMode?.(item.mode);
    s.setYear?.(item.year, { snap: true });
  };

  const rows = (timeline?.frames ?? []).map((f) => ({ id: f.year, year: f.year, day: tierOf(timeline, f.year, "day") ?? "—", night: tierOf(timeline, f.year, "night") ?? "—", kind: f.kind }));
  const status = cells.status !== "ready" ? cells : tl;

  const legend = (m, domain) =>
    domain && (
      <div className="flex items-center gap-2 text-[11px] text-ink-faint">
        <span className="font-mono">{fmt(domain[0], 0)}</span>
        <span aria-hidden="true" className="h-2 w-24 rounded-sm" style={{ backgroundImage: rampGradientCss(RAMP[m]) }} />
        <span className="font-mono">{fmt(domain[1], 0)} °C</span>
        <span>fixed {m} scale, all years</span>
      </div>
    );

  return (
    <ChartTable
      title="Atlas · every frame on a fixed scale"
      status={status}
      columns={[
        { key: "year", label: "Frame" },
        { key: "kind", label: "Kind" },
        { key: "day", label: "Day tier" },
        { key: "night", label: "Night tier" },
      ]}
      rows={rows}
      caption="Evidence tier of every frame and mode. Thumbnails show the frame's map on the fixed per-mode colour domain; click a thumbnail to show that frame."
    >
      <div className="space-y-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="micro-label text-solar">Day</span>
            {legend("day", day.domain)}
          </div>
          {dayOk ? <SmallMultiples items={dayItems} grid={grid} gridKey="atlas" onSelect={onSelect} ariaLabel="Day frames" /> : <Unavailable reason={modeUnavailableReason(timeline, "day")} />}
        </div>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="micro-label text-lunar">Night</span>
            {nightOk && legend("night", night.domain)}
          </div>
          {nightOk ? <SmallMultiples items={nightItems} grid={grid} gridKey="atlas" onSelect={onSelect} ariaLabel="Night frames" /> : <Unavailable reason={modeUnavailableReason(timeline, "night")} />}
        </div>
      </div>
    </ChartTable>
  );
}

export default AtlasStrip;
