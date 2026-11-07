/**
 * Shared React hooks of the time stream (E4).
 *
 *   useScrubYear()          throttled playhead (10 Hz while scrubbing/playing, UI_SPEC §5.2 J):
 *                           readouts follow the scrub without a React commit per pointer move
 *   usePlaybackHost()       mounts the app-wide playback loop (singleton, time/playback.js)
 *   useNowCrossingWatcher() fires the NOW-crossing choreography (toast + useNowCrossing seq)
 *   useElementWidth(ref)    ResizeObserver width
 *   useViewport()           "mobile" (< 640) | "tablet" (< 1280) | "desktop" + width
 */

import { useEffect, useRef, useState } from "react";
import { getMotionLevel } from "../design/useMotionLevel.js";
import { useBundleStoreApi } from "../data/hooks.js";
import { seriesForYear } from "../data/timeline.js";
import { useTimeStore } from "../state/stores/timeStore.js";
import { showToast } from "../shell/toasts.js";
import { crossingDetector, NOW_TOAST, NOW_TOAST_DELAY_MS, useNowCrossing } from "./nowCrossing.js";
import { startPlaybackLoop } from "./playback.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Playhead state for readouts: `{t, exact, bracket, dragging, playing}`. Updates immediately
 * on committed changes and at most `hz` times per second while the playhead moves.
 */
export function useScrubYear({ hz = 10 } = {}) {
  const read = () => {
    const s = useTimeStore.getState();
    return { t: s.scrubT, bracket: s.bracket, dragging: Boolean(s.dragging), playing: Boolean(s.playing) };
  };
  const [value, setValue] = useState(read);
  useEffect(() => {
    let timer = null;
    let lastEmit = 0;
    const period = 1000 / Math.max(1, hz);
    const emit = () => {
      timer = null;
      lastEmit = Date.now();
      setValue((prev) => {
        const next = read();
        return prev.t === next.t && prev.bracket === next.bracket && prev.dragging === next.dragging && prev.playing === next.playing ? prev : next;
      });
    };
    const unsub = useTimeStore.subscribe((s, prev) => {
      if (s.scrubT === prev.scrubT && s.dragging === prev.dragging && s.playing === prev.playing && s.bracket === prev.bracket) return;
      const moving = s.dragging || s.playing;
      if (!moving) {
        if (timer) clearTimeout(timer);
        emit();
        return;
      }
      if (timer) return;
      const wait = Math.max(0, period - (Date.now() - lastEmit));
      timer = setTimeout(emit, wait);
    });
    emit();
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [hz]);
  const exact = Boolean(value.bracket) && (value.bracket.iA === value.bracket.iB || value.bracket.mix === 0);
  return { ...value, exact };
}

/**
 * Mount the playback scheduler (one loop app-wide however many hosts mount). Frames are
 * "ready" when their value cube has settled (ready / unavailable / error — an unavailable
 * cube must not stall playback forever); `prefetch` asks the BundleStore for it.
 */
export function usePlaybackHost() {
  const api = useBundleStoreApi();
  useEffect(() => {
    const cubeKey = (year, mode, ssp) => {
      const tl = api.getState().timeline;
      if (!tl) return null;
      const series = seriesForYear(tl, year, ssp);
      return series ? `cube:${mode}:${series}` : null;
    };
    return startPlaybackLoop({
      store: useTimeStore,
      getLevel: getMotionLevel,
      isFrameReady: (year, mode, ssp) => {
        const key = cubeKey(year, mode, ssp);
        if (!key) return true;
        const status = api.getState().resources?.[key]?.status;
        return status === "ready" || status === "unavailable" || status === "error";
      },
      prefetch: (year, mode, ssp) => {
        const key = cubeKey(year, mode, ssp);
        if (!key) return;
        const ensure = api.getState().ensure;
        if (typeof ensure === "function") Promise.resolve(ensure(key)).catch(() => {});
      },
    });
  }, [api]);
}

/** Watch the playhead for NOW crossings (mount once, in MissionControl). */
export function useNowCrossingWatcher() {
  useEffect(() => {
    let detector = crossingDetector(useTimeStore.getState().now);
    let detectorNow = useTimeStore.getState().now;
    let toastTimer = null;
    detector.update(useTimeStore.getState().scrubT);
    const unsub = useTimeStore.subscribe((s) => {
      if (s.now !== detectorNow) {
        detectorNow = s.now;
        detector = crossingDetector(s.now);
      }
      const event = detector.update(s.scrubT);
      if (event === "enter") {
        useNowCrossing.getState().bump(s.scrubT);
        const delay = getMotionLevel() === "full" ? NOW_TOAST_DELAY_MS : 0;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => showToast(NOW_TOAST), delay);
      } else if (event === "exit") {
        useNowCrossing.getState().leave();
      }
    });
    return () => {
      unsub();
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, []);
}

/** Width of an element (ResizeObserver; 0 before layout). */
export function useElementWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Breakpoints of UI_SPEC §3.12–3.13 (mobile < 640 ≤ tablet < 1280 ≤ desktop). */
export function viewportClass(width) {
  if (!finite(width)) return "desktop";
  if (width < 640) return "mobile";
  if (width < 1280) return "tablet";
  return "desktop";
}

/** Window-width class, updated on resize. */
export function useViewport() {
  const get = () => (typeof window !== "undefined" ? window.innerWidth : 1440);
  const [width, setWidth] = useState(get);
  useEffect(() => {
    const onResize = () => setWidth(get());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { width, kind: viewportClass(width) };
}

/** requestAnimationFrame-batched callback (pointer moves → one store write per frame). */
export function useRafCallback(fn) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const frame = useRef(0);
  const args = useRef(null);
  useEffect(() => () => frame.current && cancelAnimationFrame(frame.current), []);
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = (...a) => {
      args.current = a;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        fnRef.current(...args.current);
      });
    };
  }
  return ref.current;
}
