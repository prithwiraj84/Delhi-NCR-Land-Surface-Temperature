/**
 * MISSION CONTROL — the Control route of NCR THERMAL/OPS v2 (UI_SPEC_v2 §3.2, §3.10–§3.13).
 *
 * Renders OVER the persistent map stage (AppShell keeps ThermalStage mounted; this layer is
 * `pointer-events: none` and each panel opts back in), in 16 px gutters:
 *
 *   ┌ TELEMETRY ───────────────────────────────────────────────────────────────┐
 *   │ LAYER DOCK │            map (stage)          [compare chips]   FRAME │ INSPECTOR │
 *   │            │                                                 CONTEXT│  360 px   │
 *   │ LEGEND / BRIEFING                       DESCRIBE · MAP TOOLBAR      │           │
 *   ├ TIME RIBBON (full 128 · compact 104 on tablet · tape 72 on mobile) ──────────────┤
 *
 * Tablet (640–1279): dock as an icon column, inspector as an overlay drawer, compact ribbon.
 * Mobile (< 640): compact telemetry, compact frame card, collapsible legend, tape ribbon,
 * inspector as a bottom sheet, compare as the Δ layer with an A/B toggle.
 *
 * Also mounts the Control behaviours: the playback host, the NOW-crossing watcher, the H
 * "probe hottest cell" handler (shell event `ncr:probe-hottest`), the snap/mode/SSP live
 * announcements (never during playback). (The former `ncr:stage-padding` hint had no listener and
 * was removed: the engine keeps the camera centred on the full stage.)
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useBundleStoreApi, useCells, useFrameValues } from "../../data/hooks.js";
import { cn } from "../../lib/cn.js";
import { fmt } from "../../lib/format.js";
import { useSelectionStore } from "../../state/stores/selectionStore.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { SHELL_EVENTS } from "../../shell/actions.js";
import { announce } from "../../shell/announcer.js";
import { describeTimeState } from "../../time/announce.js";
import { useNowCrossingWatcher, usePlaybackHost, useViewport } from "../../time/hooks.js";
import { TimeRibbon } from "../../time/TimeRibbon.jsx";
import { CompareChips } from "./CompareChips.jsx";
import { CompareDivider } from "./CompareDivider.jsx";
import { ContextChip } from "./ContextChip.jsx";
import { hottestCellIndex } from "./controlModel.js";
import { DescribeMap } from "./DescribeMap.jsx";
import { FrameCardLive } from "./FrameCard.jsx";
import { HoverCard } from "./HoverCard.jsx";
import { InspectorPanel } from "./inspector/InspectorPanel.jsx";
import { LayerDock } from "./LayerDock.jsx";
import { MapToolbar } from "./MapToolbar.jsx";
import { TelemetryStrip } from "./TelemetryStrip.jsx";
import { ThermalLegendLive } from "./ThermalLegend.jsx";
import { useDistrictMeta, useTimelineData } from "./useControlData.js";

/**
 * The guarded Briefing (B) is only needed on demand, so it is code-split out of the Control
 * chunk (UI_SPEC §11 initial-JS budget) and prefetched when the browser is idle, so pressing B
 * shows it without a visible load. While the chunk loads, the legend stays in place.
 */
const loadBriefing = () => import("./briefing/Briefing.jsx");
const Briefing = lazy(() => loadBriefing().then((m) => ({ default: m.Briefing })));

function usePrefetchBriefing() {
  useEffect(() => {
    // A failed prefetch is harmless: the lazy component issues its own import on first use.
    const prefetch = () => loadBriefing().catch(() => {});
    const idle = typeof window.requestIdleCallback === "function";
    const handle = idle ? window.requestIdleCallback(prefetch, { timeout: 8000 }) : setTimeout(prefetch, 4000);
    return () => (idle ? window.cancelIdleCallback(handle) : clearTimeout(handle));
  }, []);
}

/** Polite announcement of the committed time state on snap / mode / SSP change. */
function useSnapAnnouncer() {
  const api = useBundleStoreApi();
  useEffect(() => {
    return useTimeStore.subscribe((s, p) => {
      if (s.playing || s.dragging) return;
      const changed = s.year !== p.year || s.mode !== p.mode || s.ssp !== p.ssp || (p.dragging && !s.dragging);
      if (!changed || !Number.isFinite(s.year)) return;
      announce(describeTimeState(api).text);
    });
  }, [api]);
}

/** `H`: pin the hottest cell of the current exact frame and fly to it. */
function useProbeHottest() {
  const values = useFrameValues();
  const cells = useCells();
  const districts = useDistrictMeta();
  const ref = useRef({ values, cells, districts });
  ref.current = { values, cells, districts };
  useEffect(() => {
    const onProbe = () => {
      const { values: v, cells: c, districts: d } = ref.current;
      if (v.status !== "ready") {
        announce(v.reason ? `Hottest cell unavailable: ${v.reason}` : "The frame is still loading");
        return;
      }
      const i = hottestCellIndex(v.data.values);
      if (i < 0) {
        announce("No valid cell in this frame");
        return;
      }
      useSelectionStore.getState().pin(i);
      const districtId = c.status === "ready" ? Number(c.data.district[i]) : null;
      if (districtId !== null) useSelectionStore.getState().setDistrict(districtId);
      window.dispatchEvent(new CustomEvent(SHELL_EVENTS.flyTo, { detail: { cellIndex: i, source: "probe-hottest" } }));
      const cellId = c.status === "ready" ? c.data.cell_id[i] : i;
      announce(`Hottest cell ${cellId}${districtId !== null && d.get(districtId) ? ` in ${d.get(districtId).name}` : ""}: ${fmt(v.data.values[i], 1)} degrees Celsius`);
    };
    window.addEventListener(SHELL_EVENTS.probeHottest, onProbe);
    return () => window.removeEventListener(SHELL_EVENTS.probeHottest, onProbe);
  }, []);
}

export function MissionControl() {
  const rootRef = useRef(null);
  const { kind, width } = useViewport();
  const timeline = useTimelineData();
  const compare = useTimeStore((s) => s.compare);
  const briefingActive = useViewStore((s) => Boolean(s.briefing?.active));
  const pinned = useSelectionStore((s) => s.pinnedIndex);
  const district = useSelectionStore((s) => s.districtId);
  const [describeOpen, setDescribeOpen] = useState(false);
  const [stageWidth, setStageWidth] = useState(0);
  usePlaybackHost();
  useNowCrossingWatcher();
  useSnapAnnouncer();
  useProbeHottest();
  usePrefetchBriefing();

  const mobile = kind === "mobile";
  const tablet = kind === "tablet";
  const inspectorOpen = pinned !== null || district !== null;

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const measure = () => setStageWidth(el.getBoundingClientRect().width);
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  if (!timeline) {
    return (
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <p className="micro-label">Timeline loading…</p>
      </div>
    );
  }

  const compareOn = Boolean(compare?.kind);
  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0" data-testid="mission-control" data-viewport={kind}>
      {/* Every route owns its H1 (headings navigation); the map route's is visually hidden. */}
      <h1 className="sr-only">Mission control: Delhi NCR land surface temperature map</h1>
      {compareOn && !mobile && <CompareDivider labelA="A" labelB="B" />}
      <HoverCard containerRef={rootRef} />
      <DescribeMap open={false} />

      <div className={cn("relative flex h-full flex-col", mobile ? "gap-1.5 p-2" : "gap-2 p-4")}>
        <TelemetryStrip compact={mobile} />

        <div className="relative flex min-h-0 flex-1 gap-3">
          {/* left column */}
          <div className="flex min-h-0 flex-col justify-between gap-2">
            <LayerDock compact={mobile || tablet} />
          </div>

          {/* centre: floating overlays over the map */}
          <div className="relative min-h-0 min-w-0 flex-1">
            {compareOn && (
              <div className="absolute inset-x-0 top-0 flex justify-center">
                <CompareChips mobile={mobile} stageWidth={stageWidth} />
              </div>
            )}
            <div className={cn("absolute right-0 top-0 flex flex-col items-end gap-2", compareOn && !mobile && "top-14")}>
              <FrameCardLive compact={mobile} />
              {!mobile && <ContextChip className="w-[220px]" />}
            </div>
            <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2">
              <div className="flex min-w-0 flex-col items-start gap-2">
                {briefingActive ? (
                  <Suspense fallback={<ThermalLegendLive compact={mobile} />}>
                    <Briefing />
                  </Suspense>
                ) : (
                  <ThermalLegendLive compact={mobile} />
                )}
              </div>
              {/* The Briefing card (440 px) takes the legend's slot and would collide with the toolbar on
                  any stage narrower than ~800 px; the Briefing drives the map itself, so the view
                  options step aside until it ends (keyboard shortcuts keep working). */}
              {!mobile && !briefingActive && (
                <div className="flex min-w-0 max-w-[calc(100%-264px)] flex-col items-end gap-2">
                  {describeOpen && <DescribeMapPanel onClose={() => setDescribeOpen(false)} />}
                  <MapToolbar describeOpen={describeOpen} onToggleDescribe={() => setDescribeOpen((v) => !v)} compact={tablet || width < 1600} />
                </div>
              )}
            </div>
            {tablet && inspectorOpen && (
              <div className="absolute bottom-0 right-0 top-0 flex">
                <InspectorPanel variant="drawer" />
              </div>
            )}
          </div>

          {kind === "desktop" && (
            <div className="flex min-h-0 shrink-0">
              <InspectorPanel variant="panel" />
            </div>
          )}
        </div>

        <div className={cn("pointer-events-auto", mobile && inspectorOpen && "mb-[96px]")}>
          <TimeRibbon variant={mobile ? "tape" : tablet || width < 1280 ? "compact" : "full"} />
        </div>
      </div>

      {mobile && <InspectorPanel variant="sheet" />}
    </div>
  );
}

/** Visible DescribeMap panel (the visually hidden sentence is always mounted above). */
function DescribeMapPanel({ onClose }) {
  return <DescribeMap open hiddenSentence={false} onClose={onClose} className="max-h-[50vh] overflow-auto" />;
}

export default MissionControl;
