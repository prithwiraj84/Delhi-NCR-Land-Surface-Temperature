/**
 * Playback scheduler (UI_SPEC_v2 §5.2 B, §5.2 C, §5.3).
 *
 * The time store only records `playing`, `speed` and `loop`; this module turns that into
 * motion of the playhead:
 *
 *   Full motion   tween 800 ms (cubicInOut, the `epoch` token) + hold 800 ms per frame;
 *                 0.5× / 2× scale both phases (≈ 21 s for 13 frames at 1×).
 *   Reduced       no tween, 2.5 s per frame.
 *   Off           no tween, 3 s per frame ("step buttons only": no in-between positions).
 *   Never faster than 0.8 s per frame (nothing flashes above 3 Hz, WCAG 2.3.1), and playback
 *   never autostarts (WCAG 2.2.2) — only an explicit `play()` starts it.
 *
 * During a tween the scheduler writes the playhead with `scrubTo(t)`; the committed `year`
 * changes only when a frame is reached (`setYear(frame)`), so React re-renders once per frame
 * while the map engine reads `scrubT` every animation frame.
 *
 * Buffering: before tweening to the next frame the scheduler asks `isFrameReady(year, mode,
 * ssp)`. If the frame's data is not loaded it waits in the `buffering` phase (the playhead
 * pulses, the map keeps the current frame — it never blanks), calls `prefetch` once and
 * resumes when the data arrives.
 *
 * NOW crossing (§5.2 C): reaching the first frame after `now` adds an extra 400 ms hold, once
 * per pass. At the last frame playback stops; with `loop` on it waits 1.2 s (the map fades)
 * and restarts from the first frame.
 *
 * The scheduler is a plain object driven by `tick(nowMs)`, so tests run it with a fake clock;
 * `startPlaybackLoop` wires it to requestAnimationFrame and the store subscription.
 */

import { create } from "zustand";
import { easing, MOTION_MATRIX } from "../design/motion.js";

export const NOW_EXTRA_HOLD_MS = 400;
export const LOOP_FADE_MS = 1200;
/** Fastest allowed frame period (tween + hold), ms. */
export const MIN_FRAME_PERIOD_MS = 800;

const EPS = 1e-6;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Cubic-bezier evaluator (x -> y) for the epoch easing, solved by Newton + bisection. */
export function cubicBezier([x1, y1, x2, y2]) {
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dbx = (t) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const d = dbx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (bx(t) - x) / d;
    }
    if (t < 0 || t > 1 || Math.abs(bx(t) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 30; i += 1) {
        if (bx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return by(t);
  };
}

const epochEase = cubicBezier(easing.cubicInOut);

/**
 * Tween and hold durations (ms) for a motion level and speed (0.5 | 1 | 2).
 * @returns {{tweenMs:number, holdMs:number, periodMs:number}}
 */
export function playbackTiming(level = "full", speed = 1) {
  const row = MOTION_MATRIX[level] ?? MOTION_MATRIX.full;
  const s = finite(speed) && speed > 0 ? speed : 1;
  let tweenMs = row.playTween / s;
  let holdMs = row.playHold / s;
  const period = tweenMs + holdMs;
  if (period < MIN_FRAME_PERIOD_MS) {
    const k = MIN_FRAME_PERIOD_MS / period;
    tweenMs *= k;
    holdMs *= k;
  }
  return { tweenMs, holdMs, periodMs: tweenMs + holdMs };
}

/**
 * UI-facing playback status (PlaybackControls, Playhead pulse, inspector "► playing").
 * `stopAt` lets the Briefing play a bounded segment (e.g. first frame → NOW).
 */
export const usePlaybackStatus = create((set) => ({
  phase: "idle", // idle | tween | hold | buffering | loop-fade
  buffering: false,
  bufferingYear: null,
  nextYear: null,
  stopAt: null,
  setStopAt: (year) => set({ stopAt: finite(year) ? year : null }),
}));

/**
 * Create a scheduler bound to a zustand time store.
 * @param {object} opts
 * @param {object} opts.store zustand store with the §7 timeStore shape and actions
 * @param {() => "full"|"reduced"|"off"} [opts.getLevel] effective motion level
 * @param {(year:number, mode:string, ssp:string) => boolean} [opts.isFrameReady]
 * @param {(year:number, mode:string, ssp:string) => void} [opts.prefetch]
 * @param {(event:{type:string, year?:number}) => void} [opts.onEvent]
 * @param {object} [opts.status] status store (defaults to usePlaybackStatus)
 */
export function createPlaybackScheduler({ store, getLevel = () => "full", isFrameReady = () => true, prefetch = () => {}, onEvent = () => {}, status = usePlaybackStatus }) {
  /** Internal phase record; null when not running. */
  let run = null;
  let crossedThisPass = false;

  const setStatus = (patch) => {
    const cur = status.getState();
    const changed = Object.keys(patch).some((k) => cur[k] !== patch[k]);
    if (changed) status.setState(patch);
  };

  const state = () => store.getState();
  const yearsOf = () => state().years ?? [];
  const lastYear = () => {
    const ys = yearsOf();
    return ys[ys.length - 1];
  };
  const isFrame = (t) => yearsOf().some((y) => Math.abs(y - t) < EPS);
  const nextFrameAfter = (t) => yearsOf().find((y) => y > t + EPS);

  function enter(phase, nowMs, extra = {}) {
    run = { phase, start: nowMs, ...extra };
    setStatus({
      phase,
      buffering: phase === "buffering",
      bufferingYear: phase === "buffering" ? extra.to ?? null : null,
      nextYear: extra.to ?? null,
    });
  }

  function stopRun() {
    run = null;
    setStatus({ phase: "idle", buffering: false, bufferingYear: null, nextYear: null });
  }

  /** Commit a frame and decide the hold that follows it. */
  function arrive(year, nowMs) {
    state().setYear(year);
    onEvent({ type: "frame", year });
    const s = state();
    const { holdMs } = playbackTiming(getLevel(), s.speed);
    const now = s.now;
    let hold = holdMs;
    // NOW crossing: the first frame strictly after NOW, once per pass.
    if (finite(now) && year > now && !crossedThisPass) {
      const firstAfterNow = yearsOf().find((y) => y > now + EPS);
      if (year === firstAfterNow) {
        crossedThisPass = true;
        hold += NOW_EXTRA_HOLD_MS;
        onEvent({ type: "cross-now", year });
      }
    }
    if (finite(now) && year <= now) crossedThisPass = false;
    const stopAt = status.getState().stopAt;
    if (finite(stopAt) && year >= stopAt - EPS) {
      finish("stop-at", year);
      return;
    }
    if (year >= lastYear() - EPS) {
      if (s.loop) enter("loop-fade", nowMs, { holdUntil: nowMs + hold + LOOP_FADE_MS });
      else finish("end", year);
      return;
    }
    enter("hold", nowMs, { holdUntil: nowMs + hold, at: year });
  }

  function finish(type, year) {
    stopRun();
    status.setState({ stopAt: null });
    onEvent({ type, year });
    if (state().playing) state().pause();
  }

  /** Begin moving from time t toward the next frame (or buffer first). */
  function advanceFrom(t, nowMs) {
    const s = state();
    const to = nextFrameAfter(t);
    if (to === undefined) {
      if (s.loop) enter("loop-fade", nowMs, { holdUntil: nowMs + LOOP_FADE_MS });
      else finish("end", t);
      return;
    }
    if (!isFrameReady(to, s.mode, s.ssp)) {
      if (!run || run.phase !== "buffering" || run.to !== to) {
        prefetch(to, s.mode, s.ssp);
        onEvent({ type: "buffering", year: to });
        enter("buffering", nowMs, { from: t, to });
      }
      return;
    }
    if (run?.phase === "buffering") onEvent({ type: "buffered", year: to });
    const { tweenMs } = playbackTiming(getLevel(), s.speed);
    if (tweenMs <= 0) {
      arrive(to, nowMs);
      return;
    }
    // A start between frames tweens only the remaining fraction of the gap.
    const prev = [...yearsOf()].reverse().find((y) => y <= t + EPS) ?? t;
    const gap = to - prev || 1;
    const duration = tweenMs * Math.min(1, Math.max(0.05, (to - t) / gap));
    enter("tween", nowMs, { from: t, to, duration });
  }

  /**
   * Advance the state machine to `nowMs`. Returns true while running (keep ticking).
   * @param {number} nowMs monotonic time
   */
  function tick(nowMs) {
    const s = state();
    if (!s.playing || !yearsOf().length) {
      if (run) {
        // Paused externally mid-tween: settle on the nearest frame (never leave the map
        // parked between frames because of a pause).
        if (run.phase === "tween") {
          const t = s.scrubT;
          const target = [run.from, run.to].reduce((best, y) => (Math.abs(y - t) < Math.abs(best - t) ? y : best), run.to);
          const nearest = isFrame(target) ? target : run.to;
          s.setYear(nearest);
        }
        stopRun();
      }
      return false;
    }
    if (!run) {
      crossedThisPass = finite(s.now) && finite(s.scrubT) && s.scrubT > s.now;
      onEvent({ type: "start", year: s.scrubT });
      advanceFrom(s.scrubT ?? yearsOf()[0], nowMs);
      return Boolean(run) || state().playing;
    }
    switch (run.phase) {
      case "tween": {
        // An external jump (keyboard step, tick click) during playback restarts from there.
        if (run.expected !== undefined && Math.abs(s.scrubT - run.expected) > 1e-3) {
          advanceFrom(s.scrubT, nowMs);
          break;
        }
        const p = Math.min(1, (nowMs - run.start) / run.duration);
        if (p >= 1) {
          arrive(run.to, nowMs);
          break;
        }
        const t = run.from + (run.to - run.from) * epochEase(p);
        run.expected = t;
        s.scrubTo(t);
        break;
      }
      case "hold":
        if (Math.abs((s.scrubT ?? run.at) - run.at) > 1e-3) {
          advanceFrom(s.scrubT, nowMs);
          break;
        }
        if (nowMs >= run.holdUntil) advanceFrom(run.at, nowMs);
        break;
      case "buffering":
        if (isFrameReady(run.to, s.mode, s.ssp)) advanceFrom(run.from, nowMs);
        break;
      case "loop-fade":
        if (nowMs >= run.holdUntil) {
          const first = yearsOf()[0];
          crossedThisPass = false;
          onEvent({ type: "loop", year: first });
          s.setYear(first);
          const { holdMs } = playbackTiming(getLevel(), s.speed);
          enter("hold", nowMs, { holdUntil: nowMs + holdMs, at: first });
        }
        break;
      default:
        break;
    }
    return state().playing;
  }

  return {
    tick,
    /** Current internal phase (tests). */
    get phase() {
      return run?.phase ?? "idle";
    },
    reset() {
      stopRun();
      crossedThisPass = false;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Browser loop (singleton: several components may mount the host, one loop runs)
// ---------------------------------------------------------------------------------------

let active = null;

/**
 * Start (or join) the app-wide playback loop. Returns a release function; the loop stops when
 * the last user releases it.
 * @param {Parameters<typeof createPlaybackScheduler>[0]} options
 */
export function startPlaybackLoop(options) {
  if (active) {
    active.refs += 1;
    active.options = options;
    return () => releaseLoop();
  }
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(() => fn(Date.now()), 16);
  const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const holder = { refs: 1, options, frame: 0, unsub: null };
  // Option functions are read through the holder so a re-mount with fresh closures wins.
  const scheduler = createPlaybackScheduler({
    store: options.store,
    getLevel: () => holder.options.getLevel?.() ?? "full",
    isFrameReady: (...a) => holder.options.isFrameReady?.(...a) ?? true,
    prefetch: (...a) => holder.options.prefetch?.(...a),
    onEvent: (e) => holder.options.onEvent?.(e),
    status: options.status ?? usePlaybackStatus,
  });
  const loop = () => {
    holder.frame = 0;
    const keep = scheduler.tick(clock());
    if (keep) holder.frame = raf(loop);
  };
  const kick = () => {
    if (!holder.frame) holder.frame = raf(loop);
  };
  holder.unsub = options.store.subscribe((s, prev) => {
    if (s.playing !== prev?.playing) {
      if (s.playing) kick();
      else scheduler.tick(clock()); // settle immediately on pause
    }
  });
  if (options.store.getState().playing) kick();
  holder.scheduler = scheduler;
  holder.stop = () => {
    holder.unsub?.();
    if (holder.frame) caf(holder.frame);
    holder.frame = 0;
    scheduler.reset();
  };
  active = holder;
  return () => releaseLoop();
}

function releaseLoop() {
  if (!active) return;
  active.refs -= 1;
  if (active.refs <= 0) {
    active.stop();
    active = null;
  }
}
