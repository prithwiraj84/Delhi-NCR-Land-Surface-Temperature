/**
 * Shell side effects, mounted once by AppShell:
 *
 *   useRootAttributes   <html data-motion data-perf-tier data-playing data-mode data-route>
 *                       (CSS + useMotionLevel read these; --mode-accent follows data-mode)
 *   useMotionPersistence viewStore.motionPref <-> localStorage (try/catch; private windows)
 *   usePauseWhenHidden  pauses playback on visibilitychange hidden (motion law 5)
 *   useUrlSyncEffect    starts state/urlSync.js against the stores
 *   useGlobalShortcuts  the §2.3 keyboard map (keyboard.js -> actions.js)
 *
 * Store subscriptions use zustand `subscribe` (no React re-render on every scrub tick).
 */
import { useEffect, useRef } from "react";
import { MOTION_PREFS, MOTION_STORAGE_KEY, resolveMotionLevel } from "../design/motion.js";
import { startUrlSync } from "../state/urlSync.js";
import { runAction } from "./actions.js";
import { announce, setAnnounceSuppressor } from "./announcer.js";
import { useSelectionStore, useTimeStore, useViewStore } from "./deps.js";
import { resolveShortcut } from "./keyboard.js";
import { ROUTES } from "./routes.js";
import { showToast } from "./toasts.js";
import { useShellUi } from "./uiStore.js";

export const STORES = Object.freeze({ time: useTimeStore, view: useViewStore, selection: useSelectionStore });

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function systemReduced() {
  try {
    return window.matchMedia?.(REDUCED_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** Write the root data-* attributes from the stores (no React re-render on store changes). */
export function useRootAttributes() {
  useEffect(() => {
    const root = document.documentElement;
    const writeView = (v) => {
      root.dataset.motion = resolveMotionLevel(v.motionPref, systemReduced());
      root.dataset.perfTier = String(Number.isInteger(v.perfTier) ? Math.max(0, Math.min(3, v.perfTier)) : 0);
      root.dataset.route = v.route ?? "control";
    };
    const writeTime = (t) => {
      root.dataset.playing = t.playing ? "true" : "false";
      root.dataset.mode = t.mode ?? "day";
    };
    writeView(useViewStore.getState());
    writeTime(useTimeStore.getState());
    const offView = useViewStore.subscribe(writeView);
    const offTime = useTimeStore.subscribe((t, prev) => {
      if (!prev || t.playing !== prev.playing || t.mode !== prev.mode) writeTime(t);
    });
    let mql = null;
    const onSystem = () => writeView(useViewStore.getState());
    try {
      mql = window.matchMedia?.(REDUCED_QUERY) ?? null;
      mql?.addEventListener?.("change", onSystem);
    } catch {
      mql = null;
    }
    return () => {
      offView();
      offTime();
      mql?.removeEventListener?.("change", onSystem);
    };
  }, []);
}

/**
 * Restore the motion preference from localStorage once, then persist changes - only when the
 * view store does not persist it itself (E2's viewStore reads/writes the same key inside
 * `setMotionPref`; the shell's fallback store does not).
 */
export function useMotionPersistence() {
  useEffect(() => {
    if (typeof useViewStore.getState().setMotionPref === "function") return undefined;
    try {
      const stored = window.localStorage?.getItem(MOTION_STORAGE_KEY);
      const current = useViewStore.getState().motionPref;
      if (stored && MOTION_PREFS.includes(stored) && stored !== current && (current === undefined || current === "system")) {
        const setter = useViewStore.getState().setMotionPref;
        if (typeof setter === "function") setter(stored);
        else useViewStore.setState({ motionPref: stored });
      }
    } catch {
      // storage blocked: keep the in-memory default
    }
    return useViewStore.subscribe((v, prev) => {
      if (prev && v.motionPref === prev.motionPref) return;
      try {
        window.localStorage?.setItem(MOTION_STORAGE_KEY, v.motionPref ?? "system");
      } catch {
        // storage blocked: the preference lasts for this page view only
      }
    });
  }, []);
}

/** Pause playback when the tab is hidden; route announcements are suppressed while playing. */
export function usePauseWhenHidden() {
  useEffect(() => {
    setAnnounceSuppressor(() => Boolean(useTimeStore.getState().playing));
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      const t = useTimeStore.getState();
      if (!t.playing) return;
      if (typeof t.pause === "function") t.pause();
      else useTimeStore.setState({ playing: false });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      setAnnounceSuppressor(null);
    };
  }, []);
}

/** Start URL <-> store sync; `availableSsps` restricts `s` to the manifest's scenarios. */
export function useUrlSyncEffect(availableSsps) {
  const sspRef = useRef(availableSsps);
  sspRef.current = availableSsps;
  useEffect(() => startUrlSync(STORES, { getAvailableSsps: () => (sspRef.current?.length ? sspRef.current : null) }), []);
}

/**
 * Global keyboard map. `meta` = bundle metadata (available modes, years); `ready` = bundle
 * loaded (time/mode keys do nothing before that, but Ctrl+K / ? / Esc still work).
 */
export function useGlobalShortcuts({ meta, ready }) {
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      const ui = useShellUi.getState();
      const action = resolveShortcut(event, {
        routeCount: ROUTES.length,
        overlayOpen: Boolean(ui.overlay),
        ready: readyRef.current,
      });
      if (!action) return;
      if (action.type === "escape" && !ui.overlay) {
        // Let focused widgets (menus, popovers) handle Escape first; unpin only from the page.
        const tag = String(event.target?.tagName ?? "");
        if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      }
      const handled = runAction(action, {
        stores: STORES,
        availableModes: metaRef.current?.availableModes,
        years: metaRef.current?.years ?? [],
        announce,
        toast: showToast,
        ui: {
          openPalette: () => useShellUi.getState().toggle("palette"),
          openShortcuts: () => useShellUi.getState().open("shortcuts"),
          closeOverlay: () => useShellUi.getState().close(),
        },
      });
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
