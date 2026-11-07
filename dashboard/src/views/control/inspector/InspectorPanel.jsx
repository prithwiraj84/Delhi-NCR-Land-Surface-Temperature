/**
 * Inspector (UI_SPEC_v2 §3.4, §8 `InspectorPanel`): right 360 px panel on desktop, a 380 px
 * overlay drawer on tablet, a bottom sheet on mobile.
 *
 * States
 *   empty           hint "Click a cell or press H for the hottest cell"
 *   district        district block (selectionStore.districtId)
 *   cell            district of the pinned cell + the cell block (selectionStore.pinnedIndex)
 *   playing-frozen  while playing the content stays on the frame where playback started, with a
 *                   "► playing" badge (no per-frame re-renders of heavy panels)
 *   xai-unavailable rendered by CellSummary ("drivers exist for frames with XAI: …")
 *
 * Esc unpins (shell keyboard map); ✕ clears the selection.
 */
import { useRef } from "react";
import { MousePointerClick, Play, X } from "lucide-react";
import { HudFrame } from "../../../components/ui/HudFrame.jsx";
import { useCells } from "../../../data/hooks.js";
import { cn } from "../../../lib/cn.js";
import { useSelectionStore } from "../../../state/stores/selectionStore.js";
import { useTimeStore } from "../../../state/stores/timeStore.js";
import { useDistrictMeta, useManifestData, useTimelineData } from "../useControlData.js";
import { BottomSheet } from "./BottomSheet.jsx";
import { CellSummary } from "./CellSummary.jsx";
import { DistrictSummary } from "./DistrictSummary.jsx";

/** Committed year, frozen at its value while playback runs. */
function useFrozenYear() {
  const year = useTimeStore((s) => s.year);
  const playing = useTimeStore((s) => Boolean(s.playing));
  const frozen = useRef(year);
  if (!playing) frozen.current = year;
  return { year: playing ? frozen.current : year, playing };
}

function Content({ pinned, districtId, year, mode, ssp, timeline, manifest, districts }) {
  if (pinned === null && districtId === null) {
    return (
      <div className="flex items-start gap-2 py-2 text-[13px] text-ink-muted" data-state="empty">
        <MousePointerClick aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        <p>
          Click a cell or press <kbd className="rounded border border-control px-1 font-mono text-[11px]">H</kbd> for the hottest cell. Pick a district from the command palette (
          <kbd className="rounded border border-control px-1 font-mono text-[11px]">Ctrl K</kbd>).
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-state={pinned !== null ? "cell" : "district"}>
      {districtId !== null && <DistrictSummary districtId={districtId} district={districts.get(districtId) ?? null} t={year} mode={mode} ssp={ssp} timeline={timeline} />}
      {pinned !== null && <CellSummary index={pinned} t={year} mode={mode} ssp={ssp} timeline={timeline} manifest={manifest} districtName={districts.get(districtId)?.name ?? null} />}
    </div>
  );
}

/** @param {{variant?: "panel"|"drawer"|"sheet", className?: string}} props */
export function InspectorPanel({ variant = "panel", className }) {
  const pinned = useSelectionStore((s) => s.pinnedIndex);
  const selectedDistrict = useSelectionStore((s) => s.districtId);
  const mode = useTimeStore((s) => s.mode ?? "day");
  const ssp = useTimeStore((s) => s.ssp);
  const { year, playing } = useFrozenYear();
  const timeline = useTimelineData();
  const manifest = useManifestData();
  const districts = useDistrictMeta();
  const cells = useCells();
  if (!timeline) return null;
  const districtOfCell = pinned !== null && cells.status === "ready" ? Number(cells.data.district[pinned]) : null;
  const districtId = selectedDistrict ?? districtOfCell;
  const open = pinned !== null || districtId !== null;
  const header = (
    <div className="flex items-center justify-between gap-2">
      <h2 className="micro-label">Inspector</h2>
      <div className="flex items-center gap-1">
        {playing && (
          <span className="inline-flex items-center gap-1 rounded-full border border-hairline px-1.5 font-mono text-[11px] text-ink-muted" data-state="playing-frozen">
            <Play aria-hidden="true" className="size-3" /> playing
          </span>
        )}
        {open && (
          <button
            type="button"
            aria-label="Close inspector (Esc unpins)"
            onClick={() => {
              useSelectionStore.getState().unpin();
              useSelectionStore.getState().setDistrict(null);
            }}
            className="focus-ring grid size-7 place-items-center rounded-md text-ink-muted hover:bg-surface-3 hover:text-ink"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
  const body = <Content pinned={pinned} districtId={districtId} year={year} mode={mode} ssp={ssp} timeline={timeline} manifest={manifest} districts={districts} />;

  if (variant === "sheet") {
    if (!open) return null;
    return (
      <BottomSheet title={header} label="Inspector">
        {body}
      </BottomSheet>
    );
  }
  if (variant === "drawer" && !open) return null;
  return (
    <HudFrame
      as="aside"
      aria-label="Inspector"
      padding="sm"
      active={pinned !== null}
      className={cn("pointer-events-auto flex max-h-full min-h-0 flex-col", variant === "drawer" ? "w-[380px] max-w-[calc(100vw-2rem)]" : "w-[360px]", className)}
      data-testid="inspector"
    >
      {header}
      <div className="scrollbar-thin mt-1.5 min-h-0 flex-1 overflow-y-auto pr-1">{body}</div>
    </HudFrame>
  );
}

export default InspectorPanel;
