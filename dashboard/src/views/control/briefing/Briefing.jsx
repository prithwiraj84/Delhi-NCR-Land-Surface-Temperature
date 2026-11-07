/**
 * Briefing (UI_SPEC_v2 §3.11, key `B`): a guarded, stepped story over the live map — a caption
 * card (bottom-left, 440 px) with ◄ ► controls and a progress bar. Each step sets the map state
 * (year, mode, SSP, variable, layer, compare, camera, bounded playback) and shows copy whose
 * claim is checked against the bundle (guards.js): when the data does not support the claim the
 * alternate wording is shown and the card says so.
 *
 * Keyboard-only completable: focus moves to the step heading on every step; ←/→ inside the card
 * change step (they do not step frames there); Esc (global) ends the briefing. Not a live
 * region — the focused heading is read instead.
 */
import { useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Info, X } from "lucide-react";
import { useMotionLevel } from "../../../design/useMotionLevel.js";
import { HudFrame } from "../../../components/ui/HudFrame.jsx";
import { useAsset, useCells, useCube, useResource } from "../../../data/hooks.js";
import { cn } from "../../../lib/cn.js";
import { useData } from "../../../state/DataContext.jsx";
import { useTimeStore } from "../../../state/stores/timeStore.js";
import { useViewStore } from "../../../state/stores/viewStore.js";
import { usePlaybackStatus } from "../../../time/playback.js";
import { useManifestData, useTimelineData } from "../useControlData.js";
import { briefingStats } from "./guards.js";
import { applyBriefingState, BRIEFING_STEPS, evaluateBriefing } from "./steps.js";

/** Stats for the guards, from the same resources the rest of Control reads. */
function useBriefingStats(active) {
  const timeline = useTimelineData();
  const manifest = useManifestData();
  const series = useResource(active ? "series" : null);
  const metrics = useAsset(active ? "metrics" : null);
  const cells = useCells();
  const dayCube = useCube(active && timeline?.modeIds?.includes("day") ? "day" : null, "obs");
  const model = useResource(active ? "model:day" : null);
  const data = useData() ?? {};
  return useMemo(() => {
    if (!active || !timeline || series.status !== "ready") return null;
    const res = Number(cells.data?.grid?.res) || 1000;
    return briefingStats({
      timeline,
      series: series.data,
      metrics: metrics.status === "ready" ? metrics.data : null,
      dayCube: dayCube.status === "ready" ? dayCube.data : null,
      cellAreaKm2: (res / 1000) ** 2,
      presets: data.presets ?? [],
      modelReady: model.status === "ready",
      districts: manifest?.districts ?? [],
    });
  }, [active, timeline, series, metrics, cells, dayCube, model, data.presets, manifest]);
}

export function Briefing({ className }) {
  const briefing = useViewStore((s) => s.briefing);
  const active = Boolean(briefing?.active);
  const step = briefing?.step ?? 0;
  const stats = useBriefingStats(active);
  const steps = useMemo(() => (stats ? evaluateBriefing(stats) : null), [stats]);
  const data = useData() ?? {};
  const headingRef = useRef(null);
  const applied = useRef(null);
  const level = useMotionLevel();
  const total = BRIEFING_STEPS.length;
  const current = steps?.[Math.min(step, total - 1)] ?? null;

  // Apply each step's state once, when it is entered (not when its text refreshes).
  useEffect(() => {
    if (!active) {
      applied.current = null;
      return;
    }
    if (!current || applied.current === current.id) return;
    applied.current = current.id;
    applyBriefingState(current.state, {
      time: useTimeStore,
      view: useViewStore,
      playback: usePlaybackStatus,
      setScenario: data.setScenario,
      presets: data.presets ?? [],
    });
  }, [active, current, data.setScenario, data.presets]);

  useEffect(() => {
    if (active && current) requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  }, [active, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- focus on step change only

  if (!active) return null;
  const go = (i) => {
    if (i < 0) return;
    if (i >= total) {
      useViewStore.getState().stopBriefing();
      return;
    }
    useViewStore.getState().setBriefingStep(i, total);
  };
  const onKeyDown = (e) => {
    if (e.key === "ArrowRight") go(step + 1);
    else if (e.key === "ArrowLeft") go(step - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <HudFrame
      as="section"
      aria-label="Briefing"
      aria-roledescription="guided tour"
      padding="md"
      active
      onKeyDown={onKeyDown}
      className={cn("pointer-events-auto w-[440px] max-w-[calc(100vw-2rem)]", className)}
      data-testid="briefing"
      data-state={!current ? "loading" : current.guardPassed ? `step ${step + 1}/${total}` : "guard-alt"}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="micro-label">
          Briefing · {step + 1}/{total}
        </p>
        <button type="button" aria-label="End briefing (Esc)" onClick={() => useViewStore.getState().stopBriefing()} className="focus-ring grid size-7 place-items-center rounded-md text-ink-muted hover:bg-surface-3 hover:text-ink">
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="mt-1.5 flex gap-0.5" aria-hidden="true">
        {BRIEFING_STEPS.map((s, i) => (
          <span key={s.id} className={cn("h-0.5 flex-1 rounded-full", i <= step ? "bg-signal" : "bg-surface-3")} />
        ))}
      </div>
      {!current ? (
        <p className="scan-skeleton mt-3 h-16" aria-label="Preparing the briefing" />
      ) : (
        <motion.div key={current.id} initial={level === "full" ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: level === "full" ? 0.22 : 0 }}>
          <h2 ref={headingRef} tabIndex={-1} className="mt-3 font-display text-[28px] font-semibold leading-[34px] text-ink-strong outline-none sm:text-[32px] sm:leading-[36px]">
            {current.title}
          </h2>
          <p className="mt-2 text-[14px] leading-[21px] text-ink">{current.text}</p>
          {!current.guardPassed && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-ink-muted">
              <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
              {current.unavailable ? "This bundle does not carry the data for this step." : "The data does not support the default claim here, so the alternate wording is shown."}
            </p>
          )}
        </motion.div>
      )}
      <div className="mt-3 flex items-center justify-between">
        <button type="button" onClick={() => go(step - 1)} disabled={step === 0} className="focus-ring inline-flex h-9 items-center gap-1 rounded-md px-2 text-[13px] text-ink hover:bg-surface-3 disabled:opacity-40">
          <ChevronLeft aria-hidden="true" className="size-4" /> Back
        </button>
        <button type="button" onClick={() => go(step + 1)} className="focus-ring inline-flex h-9 items-center gap-1 rounded-md border border-control px-3 text-[13px] font-medium text-ink-strong hover:bg-surface-3">
          {step === total - 1 ? "Done" : "Next"} <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </HudFrame>
  );
}

export default Briefing;
