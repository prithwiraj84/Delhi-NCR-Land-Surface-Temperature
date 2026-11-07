/**
 * TIME RIBBON — the signature component of NCR THERMAL/OPS v2 (UI_SPEC_v2 §3.3, §5.2 A–C, §12).
 *
 *   ┌ ► |◄ ►| 1× ⟲ ┬ sparkline: frame means · annual line · SSP strands + fans from NOW      ┐
 *   │ Day|Night SSP▾│ TRACK 24: tier patterns · ticks (manifest tier glyphs) · NOW · brackets │
 *   │               │ STRIPES 12: frame mean − reference period, Polar ramp                    │
 *   │ tier legend   │ ● OBSERVED ◒ OBSERVED-SPARSE …                         [Tracks ▴]        │
 *   └ TRACKS DRAWER (optional, 96 px): sensor · night · cover · notes                         ┘
 *
 * Variants: `full` (128 px, desktop), `compact` (104 px, tablet; stripes hidden below 900 px)
 * and `tape` (72 px mobile "tape measure": fixed centre playhead, the axis scrolls under it
 * with momentum and snap; track + ticks only, 44 px play button).
 *
 * Interaction
 *   - Pointer down on the track jumps the playhead there; dragging follows the pointer 1:1
 *     (rAF-batched `scrubTo`, the map tweens continuously). On release the playhead snaps
 *     magnetically to the nearest frame within 2.5 years (critically damped, ~250 ms in Full
 *     motion, a jump otherwise); holding Shift at release disables the snap.
 *   - Shift + drag starting OFF the playhead draws a compare bracket A↔B: on release it turns
 *     on `cmp=y:<A>` (timeStore.setCompare {kind:"y", a, b}) and `v=delta`.
 *   - Hover shows a ghost playhead, the window bracket under a tick and a tooltip
 *     ("2040 · PROJECTED · SSP2-4.5 p50 38.9 °C [37.8–40.2] · n GCM = 34").
 *   - Keyboard (the ribbon is one `role="slider"` tab stop that owns the arrow keys):
 *     ←/→ previous/next frame, Shift+←/→ tier boundary, ↑/↓ ±1 year, PgUp +10 / PgDn −10
 *     years (WAI-ARIA slider convention, as in the global map), Home/End first/last frame.
 *
 * Rendering: the playhead and aria-valuenow/valuetext are written imperatively from a
 * timeStore subscription, so scrubbing and playback never re-render this component; it
 * re-renders on committed changes (year, mode, SSP, compare) and coarse hover moves only.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp } from "lucide-react";
import { TierShape } from "../design/glyphs.jsx";
import { normalizeTier, TIER_META } from "../design/tiers.js";
import { useMotionLevel } from "../design/useMotionLevel.js";
import { useBundleStoreApi, useSeries, useTimeline } from "../data/hooks.js";
import { frameModeAvailability, modeUnavailableReason, tierOf } from "../data/timeline.js";
import { seriesValueAt } from "../data/series.js";
import { cn } from "../lib/cn.js";
import { fmt, fmtInterval, fmtSsp } from "../lib/format.js";
import { useTimeStore } from "../state/stores/timeStore.js";
import { useViewStore } from "../state/stores/viewStore.js";
import { announce } from "../shell/announcer.js";
import { describeTimeState } from "./announce.js";
import { DiurnalSwitch } from "./DiurnalSwitch.jsx";
import { useElementWidth, usePlaybackHost } from "./hooks.js";
import { useNowCrossing } from "./nowCrossing.js";
import { usePlaybackStatus } from "./playback.js";
import { PlaybackControls } from "./PlaybackControls.jsx";
import { Playhead } from "./Playhead.jsx";
import {
  compareFromDrag,
  createRibbonScale,
  frameTicks,
  hoverInfo,
  momentumTarget,
  snapDurationMs,
  snapEase,
  snapTarget,
  stripeCells,
  tapeLayout,
  tickLabelStride,
  tierSegments,
} from "./ribbonScale.js";
import { RibbonSparkline } from "./RibbonSparkline.jsx";
import { RibbonTrack } from "./RibbonTrack.jsx";
import { ScenarioPicker } from "./ScenarioPicker.jsx";
import { TimelineDetailsTable } from "./TimelineDetailsTable.jsx";
import { TracksDrawer } from "./TracksDrawer.jsx";
import { WarmingStripes } from "./WarmingStripes.jsx";

const LAYOUTS = Object.freeze({
  full: { height: 128, controls: 204, spark: [4, 54], track: [62, 22], label: 96, stripes: [101, 10], svgH: 112, labels: true },
  compact: { height: 104, controls: 176, spark: [3, 34], track: [41, 20], label: 73, stripes: [77, 8], svgH: 86, labels: false },
});

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const EMPTY = Object.freeze([]);

/** Tooltip lines for a hovered position. */
function hoverLines(info, { timeline, ncr, mode, ssp, scenarios }) {
  if (!info) return null;
  if (!info.frame) {
    const b = info.bracket;
    return { title: `≈${info.year}`, body: b && b.yA !== b.yB ? `between ${b.yA} and ${b.yB} · interpolated, not a frame` : "not a frame" };
  }
  const f = info.frame;
  const tier = tierOf(timeline, f.year, mode === "dtr" ? "dtr" : mode);
  const avail = frameModeAvailability(f, mode);
  const tierText = tier ? (TIER_META[normalizeTier(tier)]?.label ?? tier).toUpperCase() : "NO DATA";
  const window = f.window[0] !== f.window[1] ? `${f.window[0]}–${String(f.window[1]).slice(2)} Apr–Jun` : null;
  if (!avail.available) return { title: `${f.year} · ${tierText}`, body: avail.reason ?? `no ${mode} data`, tier };
  if (f.kind === "projected") {
    const sc = scenarios.find((s) => s.id === ssp);
    const v = seriesValueAt(ncr, f.year, ssp);
    const value = v && finite(v.mean) ? `p50 ${fmt(v.mean, 1)} °C ${fmtInterval([v.p05, v.p95])}` : "no NCR fan exported";
    const gcm = sc?.n_gcm ? ` · n GCM = ${sc.n_gcm}` : "";
    return { title: `${f.year} · ${tierText} · ${sc?.label ?? fmtSsp(ssp)}`, body: `${value}${gcm}${window ? ` · window ${window}` : ""}`, tier };
  }
  const entry = mode === "dtr" ? null : f[mode];
  const v = seriesValueAt(ncr, f.year, null);
  const parts = [
    entry?.sensor,
    entry?.overpass_ist ? `${entry.overpass_ist} IST` : null,
    window,
    finite(entry?.scenes) && entry.scenes > 0 ? `n = ${entry.scenes} scenes` : null,
  ].filter(Boolean);
  const value = v && finite(v.mean) ? `NCR ${fmt(v.mean, 1)} °C${v.ci ? ` ${fmtInterval(v.ci)}` : ""}` : null;
  return { title: `${f.year} · ${tierText}`, body: [parts.join(" · "), value].filter(Boolean).join(" · "), tier };
}

/** Animate the playhead to `target` (no overshoot) and commit; jump when motion is reduced. */
function settleTo(target, level, rafRef) {
  const store = useTimeStore.getState();
  const from = store.scrubT;
  const ms = snapDurationMs(level);
  if (rafRef.current) cancelAnimationFrame(rafRef.current);
  if (!finite(from) || !ms || Math.abs(target - from) < 0.01) {
    store.setYear(target);
    return;
  }
  const start = performance.now();
  const stepFn = (now) => {
    const p = Math.min(1, (now - start) / ms);
    if (p >= 1) {
      rafRef.current = 0;
      useTimeStore.getState().setYear(target);
      return;
    }
    useTimeStore.getState().scrubTo(from + (target - from) * snapEase(p));
    rafRef.current = requestAnimationFrame(stepFn);
  };
  rafRef.current = requestAnimationFrame(stepFn);
}

function TierLegend({ ticks, className }) {
  const tiers = [...new Set(ticks.filter((t) => t.available && t.tier).map((t) => t.tier))];
  if (!tiers.length) return null;
  return (
    <ul className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5", className)} aria-label="Evidence tiers on this timeline">
      {tiers.map((t) => {
        const id = normalizeTier(t);
        return (
          <li key={t} className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
            <TierShape tier={id} size={10} />
            {TIER_META[id]?.label ?? t}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------
// Tape (mobile)
// ---------------------------------------------------------------------------------------

function TapeRibbon({ timeline, mode, className }) {
  const api = useBundleStoreApi();
  const wrapRef = useRef(null);
  const axisRef = useRef(null);
  const width = useElementWidth(wrapRef);
  const level = useMotionLevel();
  const year = useTimeStore((s) => s.year);
  const scenarios = timeline.scenarios ?? EMPTY;
  const svgWidth = Math.max(120, width - 52);
  const ppy = Math.max(5, svgWidth / 28);
  const scale = useMemo(() => createRibbonScale({ first: timeline.first, last: timeline.last, width: (timeline.last - timeline.first) * ppy, left: 0, right: 0 }), [timeline, ppy]);
  const ticks = useMemo(() => frameTicks(timeline, mode, scale), [timeline, mode, scale]);
  const segments = useMemo(() => tierSegments(ticks, scale), [ticks, scale]);
  const prefix = `tape-${useId().replace(/:/g, "")}`;
  const drag = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const write = () => {
      const t = useTimeStore.getState().scrubT;
      const { offset } = tapeLayout({ t: (finite(t) ? t : timeline.now) - timeline.first, pxPerYear: ppy, width: svgWidth });
      axisRef.current?.setAttribute("transform", `translate(${offset},0)`);
      const live = describeTimeState(api);
      const el = wrapRef.current?.querySelector('[role="slider"]');
      if (el) {
        el.setAttribute("aria-valuenow", String(Math.round(live.now ?? timeline.now)));
        el.setAttribute("aria-valuetext", live.text);
      }
    };
    write();
    return useTimeStore.subscribe((s, p) => {
      if (s.scrubT !== p.scrubT || s.mode !== p.mode || s.ssp !== p.ssp) write();
    });
  }, [api, scenarios, timeline, ppy, svgWidth]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (useTimeStore.getState().playing) useTimeStore.getState().pause();
    drag.current = { x: e.clientX, t: useTimeStore.getState().scrubT ?? timeline.now, lastX: e.clientX, lastT: performance.now(), v: 0 };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dx = e.clientX - d.lastX;
    const dt = Math.max(1, now - d.lastT);
    d.v = 0.8 * (-dx / ppy / dt) + 0.2 * d.v;
    d.lastX = e.clientX;
    d.lastT = now;
    useTimeStore.getState().scrubTo(d.t - (e.clientX - d.x) / ppy);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const t = useTimeStore.getState().scrubT;
    const target = momentumTarget(t, level === "full" ? d.v : 0, timeline.years, { first: timeline.first, last: timeline.last });
    settleTo(target, level, rafRef);
  };
  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  const tier = tierOf(timeline, year, mode);
  const tierId = normalizeTier(tier);
  return (
    <div ref={wrapRef} className={cn("glass flex h-[72px] items-center gap-1 rounded-panel px-1", className)} data-variant="tape">
      <PlaybackControls size="touch" showSpeed={false} showLoop={false} showSteps={false} />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Time: drag the tape to change the year"
        aria-valuemin={timeline.first}
        aria-valuemax={timeline.last}
        aria-orientation="horizontal"
        onKeyDown={(e) => handleSliderKey(e, timeline)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="focus-ring relative min-w-0 flex-1 touch-none select-none overflow-hidden rounded-md"
        style={{ height: 60 }}
      >
        <svg width={svgWidth} height={60} className="block" aria-hidden="true">
          <g ref={axisRef}>
            <RibbonTrack prefix={prefix} ticks={ticks} segments={segments} scale={scale} trackY={10} trackH={20} labelY={46} now={timeline.now} nowTop={6} currentYear={year} hoverYear={null} labelStride={1} compact />
          </g>
          <line x1={svgWidth / 2} x2={svgWidth / 2} y1={2} y2={52} stroke="var(--signal)" strokeWidth={2} style={{ filter: "drop-shadow(0 0 6px rgba(69, 224, 255, 0.55))" }} />
        </svg>
        <span className="pointer-events-none absolute right-1 top-1 inline-flex items-center gap-1 rounded bg-surface-2/90 px-1 font-mono text-[11px] text-ink">
          <TierShape tier={tierId} size={9} />
          {TIER_META[tierId]?.short ?? ""}
        </span>
      </div>
    </div>
  );
}

/** Shared slider keyboard handling (UI_SPEC §2.3 keys, scoped to the focused ribbon). */
function handleSliderKey(e, timeline) {
  const s = useTimeStore.getState();
  let handled = true;
  switch (e.key) {
    case "ArrowLeft":
      if (e.shiftKey) s.jumpTier(-1);
      else s.step(-1);
      break;
    case "ArrowRight":
      if (e.shiftKey) s.jumpTier(1);
      else s.step(1);
      break;
    case "ArrowDown":
      s.nudge(-1);
      break;
    case "ArrowUp":
      s.nudge(1);
      break;
    // WAI-ARIA slider convention: Page Up increases (+10 years), Page Down decreases.
    case "PageUp":
      s.nudge(10);
      break;
    case "PageDown":
      s.nudge(-10);
      break;
    case "Home":
      s.setYear(timeline.first);
      break;
    case "End":
      s.setYear(timeline.last);
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
    if (s.playing) s.pause();
  }
}

// ---------------------------------------------------------------------------------------
// Full / compact ribbon
// ---------------------------------------------------------------------------------------

/**
 * @param {{variant?: "full"|"compact"|"tape", className?: string, showModeControls?: boolean,
 *          defaultTracksOpen?: boolean}} props
 */
export function TimeRibbon({ variant = "full", className, showModeControls = true, defaultTracksOpen = false }) {
  usePlaybackHost();
  const tl = useTimeline();
  const timeline = tl.status === "ready" ? tl.data : null;
  const mode = useTimeStore((s) => s.mode ?? "day");
  if (!timeline) {
    return (
      <div className={cn("glass grid place-items-center rounded-panel", className)} style={{ height: variant === "tape" ? 72 : LAYOUTS[variant]?.height ?? 128 }}>
        <span className="micro-label">{tl.status === "unavailable" || tl.status === "error" ? tl.reason ?? "Timeline unavailable" : "Timeline loading…"}</span>
      </div>
    );
  }
  if (variant === "tape") return <TapeRibbon timeline={timeline} mode={mode} className={className} />;
  return <RibbonBody timeline={timeline} mode={mode} variant={variant} className={className} showModeControls={showModeControls} defaultTracksOpen={defaultTracksOpen} />;
}

function RibbonBody({ timeline, mode, variant, className, showModeControls, defaultTracksOpen }) {
  const api = useBundleStoreApi();
  const layout = LAYOUTS[variant] ?? LAYOUTS.full;
  const areaRef = useRef(null);
  const sliderRef = useRef(null);
  const playheadRef = useRef(null);
  const ghostRef = useRef(null);
  const rafRef = useRef(0);
  const moveFrame = useRef(0);
  const dragRef = useRef(null);
  const prefix = `rib-${useId().replace(/:/g, "")}`;
  const areaWidth = useElementWidth(areaRef);
  const level = useMotionLevel();

  const year = useTimeStore((s) => s.year);
  const ssp = useTimeStore((s) => s.ssp);
  const compareState = useTimeStore((s) => s.compare);
  const buffering = usePlaybackStatus((s) => s.buffering);
  const bufferingYear = usePlaybackStatus((s) => s.bufferingYear);
  const crossingSeq = useNowCrossing((s) => s.seq);
  const ncrRes = useSeries("ncr", mode);
  const ncr = ncrRes.status === "ready" ? ncrRes.data : null;
  const [tracksOpen, setTracksOpen] = useState(defaultTracksOpen);
  const [hover, setHover] = useState(null); // {key, x, info}
  const [liveBracket, setLiveBracket] = useState(null);
  const [interpolated, setInterpolated] = useState(false);

  const scenarios = timeline.scenarios ?? EMPTY;
  const showLabels = layout.labels && scenarios.length > 0;
  const svgWidth = Math.max(160, areaWidth);
  const scale = useMemo(() => createRibbonScale({ first: timeline.first, last: timeline.last, width: svgWidth, right: showLabels ? 52 : 26 }), [timeline, svgWidth, showLabels]);
  const ticks = useMemo(() => frameTicks(timeline, mode, scale), [timeline, mode, scale]);
  const segments = useMemo(() => tierSegments(ticks, scale), [ticks, scale]);
  const stripes = useMemo(() => stripeCells(timeline, ncr, ssp, scale), [timeline, ncr, ssp, scale]);
  const labelStride = useMemo(() => tickLabelStride(scale, ticks.length), [scale, ticks.length]);
  // Stripes are level differences vs the reference period: hidden when the bundle's levels are
  // not harmonised across sensors / overpass times (a v1 bundle), where they would show drift.
  const levelsHarmonised = timeline.harmonised === true;
  const showStripes = levelsHarmonised && (variant === "full" || svgWidth + layout.controls >= 900);
  const ncrByYear = useMemo(() => {
    const m = new Map();
    for (const f of ncr?.frames ?? []) m.set(f.year, f.mean);
    for (const r of ncr?.ssp?.[ssp] ?? []) if (!m.has(r.year)) m.set(r.year, r.p50);
    return m;
  }, [ncr, ssp]);
  const nightTier = useMemo(() => (finite(year) ? tierOf(timeline, Math.round(year), "night") : null), [timeline, year]);
  const available = { day: timeline.modeIds.includes("day"), night: timeline.modeIds.includes("night"), dtr: Boolean(timeline.dtrAvailable) };
  const reasons = { day: modeUnavailableReason(timeline, "day"), night: modeUnavailableReason(timeline, "night"), dtr: modeUnavailableReason(timeline, "dtr") };

  // ---- imperative playhead + aria (no React render per scrub tick) ------------------------
  useEffect(() => {
    let lastAria = 0;
    let ariaTimer = null;
    const writeAria = () => {
      ariaTimer = null;
      lastAria = Date.now();
      const el = sliderRef.current;
      if (!el) return;
      const live = describeTimeState(api);
      el.setAttribute("aria-valuenow", String(Math.round((live.now ?? timeline.now) * 10) / 10));
      el.setAttribute("aria-valuetext", live.text);
    };
    const write = (s) => {
      const t = finite(s.scrubT) ? s.scrubT : timeline.now;
      playheadRef.current?.setAttribute("transform", `translate(${scale.x(t)},0)`);
      const interp = Boolean(s.bracket) && s.bracket.iA !== s.bracket.iB && s.bracket.mix > 0;
      setInterpolated((prev) => (prev === interp ? prev : interp));
      const since = Date.now() - lastAria;
      if (since >= 100) writeAria();
      else if (!ariaTimer) ariaTimer = setTimeout(writeAria, 100 - since);
    };
    write(useTimeStore.getState());
    const unsub = useTimeStore.subscribe((s, p) => {
      if (s.scrubT !== p.scrubT || s.mode !== p.mode || s.ssp !== p.ssp || s.bracket !== p.bracket) write(s);
    });
    // Series arriving later improves the valuetext.
    const unsubApi = api.subscribe((b, pb) => {
      if (b.resources?.series !== pb.resources?.series) writeAria();
    });
    return () => {
      unsub();
      unsubApi();
      if (ariaTimer) clearTimeout(ariaTimer);
    };
  }, [api, scale, scenarios, timeline]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (moveFrame.current) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  // ---- pointer -----------------------------------------------------------------------------
  const localX = (e) => {
    const rect = sliderRef.current?.getBoundingClientRect();
    return rect ? e.clientX - rect.left : 0;
  };

  const updateHover = useCallback(
    (x) => {
      const t = scale.invert(x);
      ghostRef.current?.setAttribute("transform", `translate(${scale.x(t)},0)`);
      const info = hoverInfo(t, timeline);
      const key = info?.frame ? `f${info.frame.year}` : `y${info?.year}`;
      setHover((prev) => (prev?.key === key ? { ...prev, x } : { key, x, info }));
    },
    [scale, timeline],
  );

  const onPointerDown = (e) => {
    if (e.button !== 0 || !sliderRef.current) return;
    const onHandle = e.target?.getAttribute?.("data-role") === "playhead-handle";
    const t = scale.invert(localX(e));
    sliderRef.current.setPointerCapture?.(e.pointerId);
    sliderRef.current.focus({ preventScroll: true });
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const s = useTimeStore.getState();
    if (s.playing) s.pause();
    if (e.shiftKey && !onHandle) {
      dragRef.current = { kind: "bracket", t0: t };
      setLiveBracket({ a: t, b: t, live: true });
      return;
    }
    dragRef.current = { kind: "scrub", moved: false };
    if (!onHandle) s.scrubTo(t);
    else s.scrubTo(s.scrubT);
    setHover(null);
  };

  const onPointerMove = (e) => {
    const x = localX(e);
    const d = dragRef.current;
    if (!d) {
      if (e.pointerType !== "touch") updateHover(x);
      return;
    }
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const t = scale.invert(x);
      if (d.kind === "bracket") setLiveBracket({ a: Math.min(d.t0, t), b: Math.max(d.t0, t), live: true });
      else {
        d.moved = true;
        useTimeStore.getState().scrubTo(t);
      }
    });
  };

  const finishDrag = (e, cancelled = false) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (moveFrame.current) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
    }
    if (!d) return;
    if (d.kind === "bracket") {
      setLiveBracket(null);
      if (cancelled) return;
      const pair = compareFromDrag(d.t0, scale.invert(localX(e)), timeline.years);
      if (pair) {
        useTimeStore.getState().setCompare({ kind: "y", a: pair.a, b: pair.b });
        useViewStore.getState().setVariable?.("delta");
        announce(`Compare ${pair.a} versus ${pair.b}, showing the difference B minus A`);
      }
      return;
    }
    const s = useTimeStore.getState();
    const target = snapTarget(s.scrubT, timeline.years, { snap: !(e?.shiftKey ?? false) && s.snap !== false });
    if (target !== null) settleTo(scale.clampT(target), level, rafRef);
  };

  const hoverYear = hover?.info?.frame?.year ?? null;
  const tip = hover ? hoverLines(hover.info, { timeline, ncr, mode, ssp, scenarios }) : null;
  const compare = liveBracket ?? (compareState?.kind === "y" && finite(compareState.a) && finite(compareState.b) ? { a: Math.min(compareState.a, compareState.b), b: Math.max(compareState.a, compareState.b) } : null);
  const nowX = finite(timeline.now) && timeline.now >= scale.first && timeline.now <= scale.last ? scale.x(timeline.now) : null;
  const sparkTop = layout.spark[0];
  const trackY = layout.track[0];
  const trackH = layout.track[1];
  const hasProjections = timeline.projYears.length > 0;

  return (
    <div className={cn("glass hud flex flex-col rounded-panel", className)} data-variant={variant} data-testid="time-ribbon">
      <div className="flex min-h-0" style={{ height: layout.height }}>
        {/* ---- controls column ---- */}
        <div className="flex shrink-0 flex-col justify-between border-r border-hairline px-2 py-2" style={{ width: layout.controls }}>
          <PlaybackControls showLoop={variant === "full"} />
          {showModeControls && (
            <div className="flex flex-col gap-1.5">
              <DiurnalSwitch available={available} reasons={reasons} nightTier={nightTier} compact layoutId={`${prefix}-mode`} />
              <ScenarioPicker options={scenarios} now={timeline.now} projYears={timeline.projYears} compact />
            </div>
          )}
        </div>

        {/* ---- graphic area ---- */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={areaRef} className="relative min-w-0">
            <div
              ref={sliderRef}
              role="slider"
              tabIndex={0}
              aria-label="Time ribbon: year of the map"
              aria-valuemin={timeline.first}
              aria-valuemax={timeline.last}
              aria-orientation="horizontal"
              aria-describedby={`${prefix}-help`}
              onKeyDown={(e) => handleSliderKey(e, timeline)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => finishDrag(e)}
              onPointerCancel={(e) => finishDrag(e, true)}
              onPointerLeave={() => !dragRef.current && setHover(null)}
              className="focus-ring relative touch-none select-none rounded-md outline-none"
              style={{ height: layout.svgH, cursor: "pointer" }}
            >
              <svg width={svgWidth} height={layout.svgH} className="block overflow-visible" aria-hidden="true">
                <RibbonSparkline
                  scale={scale}
                  top={sparkTop}
                  height={layout.spark[1]}
                  ncr={ncr}
                  ticks={ticks}
                  ssp={ssp}
                  scenarios={scenarios}
                  now={timeline.now}
                  unfurlSeq={crossingSeq}
                  level={level}
                  showLabels={showLabels}
                  compact={variant === "compact"}
                />
                <RibbonTrack
                  prefix={prefix}
                  ticks={ticks}
                  segments={segments}
                  scale={scale}
                  trackY={trackY}
                  trackH={trackH}
                  labelY={layout.label}
                  now={timeline.now}
                  nowTop={sparkTop}
                  currentYear={finite(year) ? year : null}
                  hoverYear={hoverYear}
                  loadingYear={buffering ? bufferingYear : null}
                  labelStride={labelStride}
                  compare={compare}
                  compact={variant === "compact"}
                />
                {nowX !== null && variant === "full" && (
                  <text
                    x={nowX > scale.x1 - 240 ? nowX - 4 : nowX + 4}
                    y={sparkTop + 8}
                    textAnchor={nowX > scale.x1 - 240 ? "end" : "start"}
                    style={{ font: "500 11px var(--font-mono)", fill: "var(--ink-faint)", letterSpacing: "0.08em" }}
                  >
                    {`NOW · ${timeline.now}${hasProjections ? " · OBSERVED | PROJECTED" : ""}`}
                  </text>
                )}
                {nowX !== null && level === "full" && crossingSeq > 0 && (
                  <motion.line key={crossingSeq} x1={nowX} x2={nowX} y1={sparkTop} y2={trackY + trackH} stroke="var(--signal)" initial={{ strokeWidth: 3, opacity: 1 }} animate={{ strokeWidth: 1, opacity: 0 }} transition={{ duration: 0.6 }} />
                )}
                {showStripes && <WarmingStripes cells={stripes.cells} maxAbs={stripes.maxAbs} y={layout.stripes[0]} height={layout.stripes[1]} referenceLabel={stripes.reference.label} sspLabel={fmtSsp(ssp)} />}
                {hover && <Playhead ref={ghostRef} ghost top={sparkTop} bottom={trackY + trackH} handleY={trackY} />}
                <Playhead ref={playheadRef} top={sparkTop} bottom={trackY + trackH + 2} handleY={trackY} buffering={buffering} interpolated={interpolated} onPointerDown={undefined} />
              </svg>
            </div>
            {tip && (
              <div
                role="presentation"
                className="glass-strong pointer-events-none absolute z-overlay max-w-[22rem] -translate-x-1/2 rounded-md px-2.5 py-1.5"
                style={{ left: Math.min(Math.max(hover.x, 120), svgWidth - 120), bottom: layout.svgH - trackY + 6 }}
              >
                <p className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-ink-strong">
                  {tip.tier && <TierShape tier={normalizeTier(tip.tier)} size={10} />}
                  {tip.title}
                </p>
                <p className="font-mono text-[11px] leading-snug text-ink-muted">{tip.body}</p>
              </div>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 px-1 pb-1">
            <TierLegend ticks={ticks} />
            <div className="flex shrink-0 items-center gap-2">
              {showStripes && stripes.reference.label && <span className="hidden font-mono text-[11px] text-ink-faint lg:inline">stripes: Δ vs {stripes.reference.label}</span>}
              {!levelsHarmonised && (
                <span className="hidden font-mono text-[11px] text-ink-faint lg:inline" title="Warming stripes need levels harmonised across sensors and overpass times">
                  stripes hidden: levels not harmonised
                </span>
              )}
              <button
                type="button"
                aria-expanded={tracksOpen}
                onClick={() => setTracksOpen((v) => !v)}
                className="focus-ring inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted hover:bg-surface-3 hover:text-ink"
              >
                Tracks {tracksOpen ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronUp aria-hidden="true" className="size-3.5" />}
              </button>
            </div>
          </div>
          <p id={`${prefix}-help`} className="sr-only">
            Arrow keys step frames, Shift plus arrows jump to the next evidence tier, up and down move one year, Page Up moves ten years forward and Page Down ten years back, Home and End go to the first and last frame. Drag to scrub; release snaps to the nearest frame. Shift and drag across the track to compare two years.
          </p>
          <TimelineDetailsTable timeline={timeline} ncrByYear={ncrByYear} mode={mode === "night" ? "night" : "day"} ssp={ssp} visuallyHidden />
        </div>
      </div>
      {tracksOpen && <TracksDrawer timeline={timeline} scale={scale} mode={mode} svgWidth={svgWidth} labelWidth={layout.controls} ncrByYear={ncrByYear} ssp={ssp} />}
    </div>
  );
}

export default TimeRibbon;
