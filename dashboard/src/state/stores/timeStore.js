/**
 * timeStore (UI_SPEC §7): the time playhead, display mode, scenario and compare state.
 *
 * Shape (binding): { year, scrubT, playing, speed, loop, snap, mode, ssp,
 *                    bracket: {iA, iB, mix, yA, yB}, compare: {kind, a, b, splitPx} }
 * plus the timeline frame list it was configured with (`years`, `now`, …) and `dragging`.
 *
 * Semantics
 * - `scrubT` (float, years) is the playhead the map engine reads every frame through
 *   `useTimeStore.getState()` / `subscribe` — React components should not subscribe to it.
 * - `year` is the committed year: it follows `scrubT` except while dragging (it keeps the
 *   pre-drag value so React does not re-render on every pointer move); `release()` commits it.
 *   It is an integer unless set programmatically to a fraction.
 * - `bracket` = the two frames around `scrubT` and `mix` = (scrubT − yA)/(yB − yA). Exactly on a
 *   frame: iA === iB and mix 0. The object identity changes only when its values change.
 * - `ssp` is the manifest scenario id ("ssp245"); the URL uses the short form ("245").
 * - Playback scheduling (tween/hold timing, reduced motion) lives in `time/playback.js` (E4); the
 *   store only records `playing`, `speed` and `loop`.
 */

import { create } from "zustand";
import { bracketAt, DISPLAY_MODES, nearestFrameIndex, normalizeSspId, tierBoundaries } from "../../data/timeline.js";

/** Snap radius on release (UI_SPEC §3.3: "nearest frame within 2.5 years"). */
export const SNAP_RADIUS_YEARS = 2.5;
export const SPEEDS = Object.freeze([0.5, 1, 2]);
export const COMPARE_KINDS = Object.freeze(["y", "s", "m"]);
const DEFAULT_SSP = "ssp245";
const EPS = 1e-6;

const OFF_COMPARE = Object.freeze({ kind: null, a: null, b: null, splitPx: null });

function initialTimeState() {
  return {
    years: [],
    now: null,
    first: null,
    last: null,
    modeIds: ["day", "night"],
    dtrAvailable: true,
    scenarioIds: [],
    timeline: null,
    year: null,
    scrubT: null,
    dragging: false,
    playing: false,
    speed: 1,
    loop: false,
    snap: true,
    mode: "day",
    ssp: DEFAULT_SSP,
    bracket: null,
    compare: OFF_COMPARE,
  };
}

const sameBracket = (a, b) => Boolean(a) && Boolean(b) && a.iA === b.iA && a.iB === b.iB && Math.abs(a.mix - b.mix) < 1e-9;

/** Zustand initializer (exported so tests can build isolated vanilla stores). */
export function timeStoreInitializer(set, get) {
  const clampT = (t) => {
    const { first, last } = get();
    if (!Number.isFinite(Number(t))) return null;
    if (first === null || last === null) return Number(t);
    return Math.min(last, Math.max(first, Number(t)));
  };

  /** Patch with a new playhead, recomputing the bracket (identity kept when unchanged). */
  const atTime = (t, extra = {}) => {
    const { years, bracket } = get();
    const next = years.length ? bracketAt(years, t) : null;
    return { scrubT: t, bracket: sameBracket(next, bracket) ? bracket : next, ...extra };
  };

  const modeAllowed = (mode) => {
    const { modeIds, dtrAvailable, timeline } = get();
    if (!DISPLAY_MODES.includes(mode)) return false;
    if (!timeline) return true;
    return mode === "dtr" ? dtrAvailable : modeIds.includes(mode);
  };

  return {
    ...initialTimeState(),

    /**
     * Adopt a normalised timeline (data/timeline.js). Keeps the current year/mode/ssp when they are
     * still valid, else falls back to NOW / the first available mode / ssp245 (or the first SSP).
     * `initial` (e.g. parsed from the URL) wins when valid.
     */
    configure(timeline, initial = {}) {
      if (!timeline?.years?.length) return;
      const state = get();
      const years = timeline.years.slice();
      const scenarioIds = timeline.scenarioIds.slice();
      set({
        timeline,
        years,
        now: timeline.now,
        first: years[0],
        last: years[years.length - 1],
        modeIds: timeline.modeIds.slice(),
        dtrAvailable: Boolean(timeline.dtrAvailable),
        scenarioIds,
      });
      const wantMode = initial.mode ?? state.mode;
      const mode = modeAllowed(wantMode) ? wantMode : timeline.modeIds[0] ?? "day";
      const wantSsp = normalizeSspId(initial.ssp ?? state.ssp);
      const ssp = scenarioIds.includes(wantSsp) ? wantSsp : scenarioIds.includes(DEFAULT_SSP) ? DEFAULT_SSP : scenarioIds[0] ?? null;
      const wantYear = Number.isFinite(Number(initial.year)) ? Number(initial.year) : Number.isFinite(state.year) ? state.year : timeline.now;
      const year = clampT(wantYear);
      set(atTime(year, { year, mode, ssp, dragging: false, playing: false, compare: initial.compare ?? state.compare }));
    },

    /** Commit a year (tick click, URL, keyboard). `{snap: true}` snaps to the nearest frame. */
    setYear(y, { snap = false } = {}) {
      let t = clampT(y);
      if (t === null) return;
      if (snap) {
        const { years } = get();
        const i = nearestFrameIndex(years, t);
        if (i >= 0) t = years[i];
      }
      set(atTime(t, { year: t, dragging: false }));
    },

    /** Continuous scrub (pointer drag): moves the playhead only; `year` waits for release(). */
    scrubTo(t) {
      const x = clampT(t);
      if (x === null) return;
      set(atTime(x, { dragging: true }));
    },

    /**
     * End a drag. With snapping on (and not overridden, e.g. Shift held) the playhead moves to the
     * nearest frame within SNAP_RADIUS_YEARS; otherwise it settles on the nearest whole year.
     */
    release({ snap } = {}) {
      const { scrubT, years } = get();
      if (scrubT === null) return;
      const useSnap = snap ?? get().snap;
      let target = Math.round(scrubT);
      if (useSnap && years.length) {
        const i = nearestFrameIndex(years, scrubT);
        if (i >= 0 && Math.abs(years[i] - scrubT) <= SNAP_RADIUS_YEARS) target = years[i];
      }
      target = clampT(target);
      set(atTime(target, { year: target, dragging: false }));
    },

    /** Start playback (restarts from the first frame when parked at the end). */
    play() {
      const { years, scrubT, last } = get();
      if (!years.length) return;
      if (scrubT === null || scrubT >= last - EPS) set(atTime(years[0], { year: years[0], playing: true, dragging: false }));
      else set({ playing: true, dragging: false });
    },

    pause() {
      if (get().playing) set({ playing: false });
    },

    togglePlay() {
      if (get().playing) get().pause();
      else get().play();
    },

    /** Previous / next frame relative to the playhead (between frames: to the bracket edge). */
    step(dir = 1) {
      const { years, scrubT } = get();
      if (!years.length) return;
      const t = scrubT ?? years[0];
      const target = dir > 0 ? years.find((y) => y > t + EPS) : [...years].reverse().find((y) => y < t - EPS);
      if (target === undefined) return;
      set(atTime(target, { year: target, dragging: false }));
    },

    /** ±n whole years (interpolated positions allowed; keys `, .` and PgUp/PgDn). */
    nudge(deltaYears) {
      const { scrubT, now } = get();
      const base = Math.round(scrubT ?? now ?? 0);
      const t = clampT(base + Number(deltaYears || 0));
      if (t === null) return;
      set(atTime(t, { year: t, dragging: false }));
    },

    /** Jump to the previous / next tier boundary (first frame, tier changes, NOW, last frame). */
    jumpTier(dir = 1) {
      const { timeline, scrubT, mode } = get();
      if (!timeline) return;
      const bounds = tierBoundaries(timeline, mode === "dtr" ? "day" : mode);
      const t = scrubT ?? timeline.now;
      const target = dir > 0 ? bounds.find((y) => y > t + EPS) : [...bounds].reverse().find((y) => y < t - EPS);
      if (target === undefined) return;
      set(atTime(target, { year: target, dragging: false }));
    },

    /** Switch display mode ("day" | "night" | "dtr"); returns false when unavailable. */
    setMode(mode) {
      if (!modeAllowed(mode)) return false;
      if (get().mode !== mode) set({ mode });
      return true;
    },

    /** `T`: day ↔ night (from DTR goes to day). */
    toggleDayNight() {
      const next = get().mode === "day" ? "night" : "day";
      return get().setMode(next);
    },

    /** Select a scenario by id ("ssp245" or "245"); returns false when not in the manifest. */
    setSsp(ssp) {
      const id = normalizeSspId(ssp);
      const { scenarioIds, timeline } = get();
      if (timeline && !scenarioIds.includes(id)) return false;
      if (get().ssp !== id) set({ ssp: id });
      return true;
    },

    /** `S`: cycle through the manifest scenarios. */
    cycleSsp(dir = 1) {
      const { scenarioIds, ssp } = get();
      if (!scenarioIds.length) return;
      const i = scenarioIds.indexOf(ssp);
      const next = scenarioIds[(((i < 0 ? 0 : i + (dir < 0 ? -1 : 1)) % scenarioIds.length) + scenarioIds.length) % scenarioIds.length];
      set({ ssp: next });
    },

    /**
     * Compare state: `null`/`false` turns it off; otherwise `{kind: "y"|"s"|"m", a, b, splitPx}`
     * (partial patches merge into the current compare). Invalid kinds are rejected.
     */
    setCompare(compare) {
      if (!compare) {
        set({ compare: OFF_COMPARE });
        return true;
      }
      const merged = { ...get().compare, ...compare };
      if (!COMPARE_KINDS.includes(merged.kind)) return false;
      if (merged.kind === "s") {
        merged.a = merged.a !== null && merged.a !== undefined ? normalizeSspId(merged.a) : merged.a;
        merged.b = merged.b !== null && merged.b !== undefined ? normalizeSspId(merged.b) : merged.b;
      }
      if (merged.kind === "y") {
        merged.a = merged.a === null || merged.a === undefined ? null : clampT(merged.a);
        merged.b = merged.b === null || merged.b === undefined ? null : clampT(merged.b);
      }
      merged.splitPx = merged.splitPx === null || merged.splitPx === undefined || !Number.isFinite(Number(merged.splitPx)) ? null : Number(merged.splitPx);
      set({ compare: Object.freeze(merged) });
      return true;
    },

    setSpeed(speed) {
      const s = Number(speed);
      if (SPEEDS.includes(s)) set({ speed: s });
    },
    setLoop: (loop) => set({ loop: Boolean(loop) }),
    setSnap: (snap) => set({ snap: Boolean(snap) }),
    /** Back to the unconfigured initial state (tests, bundle switch). */
    reset: () => set(initialTimeState()),
  };
}

/** The app-wide time store (hook + `getState`/`subscribe`/`setState`). */
export const useTimeStore = create(timeStoreInitializer);

/** True while the playhead sits between two frames (readouts must show "≈" and the bracket). */
export const selectInterpolated = (s) => Boolean(s.bracket) && s.bracket.iA !== s.bracket.iB && s.bracket.mix > 0;

/** Exact frame year under the playhead, or null when interpolated. */
export const selectExactYear = (s) => (s.bracket && !selectInterpolated(s) ? s.bracket.yA : null);
