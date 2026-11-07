/**
 * Shell action executor shared by the global keyboard map and the command palette.
 *
 * Actions mutate E2's zustand stores through the frozen §7 actions where they exist
 * (setYear, play, pause, step, jumpTier, setMode, cycleSsp, setCompare) and through
 * `setStoreField` (dedicated setter if present, `setState` otherwise) for view fields.
 * Actions that belong to another stream's component are delivered as DOM CustomEvents on
 * `window` (SHELL_EVENTS) so the shell never imports those components:
 *   ncr:probe-hottest   H key / palette "Probe hottest cell"  -> map engine / inspector (E3/E4)
 *   ncr:fly-to          palette district/cell selection {detail: {districtId?, cellIndex?, bounds?}}
 *   ncr:export-png      palette "Export view PNG"             -> stage (E3)
 *   ncr:focus-layer-dock L key when no [data-focus-target="layer-dock"] element exists yet
 */
import { MOTION_PREF_LABELS, nextMotionPref } from "../design/motion.js";
import { ROUTES } from "./routes.js";
import { callAction, setStoreField } from "./deps.js";

export const SHELL_EVENTS = Object.freeze({
  probeHottest: "ncr:probe-hottest",
  flyTo: "ncr:fly-to",
  exportPng: "ncr:export-png",
  focusLayerDock: "ncr:focus-layer-dock",
});

const clampYear = (y) => Math.max(1990, Math.min(2050, y));
const RENDER_CYCLE = Object.freeze(["grid", "raster", "auto"]);

function emit(win, name, detail) {
  if (!win || typeof win.dispatchEvent !== "function" || typeof win.CustomEvent !== "function") return;
  win.dispatchEvent(new win.CustomEvent(name, { detail }));
}

/** Focus the first focusable element inside `[data-focus-target=name]`; true on success. */
export function focusTarget(doc, name) {
  const root = doc?.querySelector?.(`[data-focus-target="${name}"]`);
  if (!root) return false;
  const focusable = root.matches?.("button, [href], input, select, [tabindex]")
    ? root
    : root.querySelector?.('[aria-checked="true"], [aria-pressed="true"], button, [href], input, select, [tabindex]:not([tabindex="-1"])');
  (focusable ?? root).focus?.();
  return true;
}

/**
 * After a route change, bring an in-view anchor (e.g. "caveats", "caveat-terra") into view:
 * the target view is a lazy chunk, so retry for up to ~2 s; the anchor is also appended to
 * the hash (`#/sources?...#caveats`) so the link is shareable, and announced to listeners
 * as `ncr:anchor`.
 */
export function scrollToAnchor(win, anchor, { attempts = 20, intervalMs = 100 } = {}) {
  if (!win?.document) return;
  let left = attempts;
  const tick = () => {
    const el = win.document.getElementById(anchor);
    if (el) {
      el.scrollIntoView?.({ block: "start" });
      if (typeof el.focus === "function" && el.tabIndex >= 0) el.focus({ preventScroll: true });
      try {
        const base = win.location.hash.split("#").slice(0, 2).join("#");
        // Keep history.state (urlSync's {ncrUrlSync: 1} marker): a later Back onto this entry
        // must still be recognised as an app entry and restore its params.
        win.history.replaceState(win.history.state, "", `${base}#${anchor}`);
      } catch {
        // history writes can be blocked in sandboxed frames; scrolling already happened
      }
      emit(win, "ncr:anchor", { id: anchor });
      return;
    }
    left -= 1;
    if (left > 0) win.setTimeout(tick, intervalMs);
  };
  win.setTimeout(tick, intervalMs);
}

/**
 * Execute an action descriptor.
 * @param {{type: string}} action from keyboard.resolveShortcut or the palette
 * @param {object} ctx
 * @param {{time, view, selection}} ctx.stores
 * @param {{day?: boolean, night?: boolean, dtr?: boolean}} [ctx.availableModes]
 * @param {number[]} [ctx.years] frame years (first frame = compare default A)
 * @param {(msg: string) => void} [ctx.announce]
 * @param {(t: object) => void} [ctx.toast]
 * @param {{openPalette?: Function, openShortcuts?: Function, closeOverlay?: () => boolean}} [ctx.ui]
 * @param {Window} [ctx.win]
 * @returns {boolean} whether the action was handled
 */
export function runAction(action, ctx) {
  if (!action) return false;
  const { stores, availableModes = { day: true, night: true, dtr: true }, years = [], announce = () => {}, toast = () => {}, ui = {} } = ctx;
  const win = ctx.win ?? (typeof window !== "undefined" ? window : null);
  const { time, view, selection } = stores;
  const t = time.getState();

  switch (action.type) {
    case "route": {
      const route = ROUTES[action.index] ?? ROUTES.find((r) => r.id === action.route);
      if (!route) return false;
      setStoreField(view, "route", route.id);
      if (action.anchor) scrollToAnchor(win, action.anchor);
      return true;
    }
    case "togglePlay":
      if (t.playing) callAction(time, "pause") || time.setState({ playing: false });
      else callAction(time, "play") || time.setState({ playing: true });
      return true;
    case "stepFrame":
      return callAction(time, "step", action.dir);
    case "jumpTier":
      return callAction(time, "jumpTier", action.dir);
    case "stepYear":
    case "setYear": {
      const base = Number.isFinite(t.year) ? t.year : 2025;
      const year = clampYear(action.type === "setYear" ? action.year : Math.round(base) + action.delta);
      if (!callAction(time, "setYear", year)) time.setState({ year, scrubT: year });
      return true;
    }
    case "mode": {
      if (availableModes[action.mode] === false) {
        const label = action.mode === "dtr" ? "Diurnal range" : action.mode === "night" ? "Night" : "Day";
        const message = `${label} is unavailable in this bundle (rerun notebook v2 for night and projections).`;
        toast({ id: `mode-unavailable-${action.mode}`, title: `${label} unavailable`, body: message, tone: "warn" });
        announce(message);
        return true;
      }
      if (!callAction(time, "setMode", action.mode)) time.setState({ mode: action.mode });
      return true;
    }
    case "toggleDayNight": {
      const next = t.mode === "night" ? "day" : "night";
      return runAction({ type: "mode", mode: next }, ctx);
    }
    case "cycleSsp":
      if (!callAction(time, "cycleSsp")) return false;
      return true;
    case "cycleRender": {
      const v = view.getState();
      const i = RENDER_CYCLE.indexOf(v.renderMode);
      const next = RENDER_CYCLE[(i + 1) % RENDER_CYCLE.length];
      setStoreField(view, "renderMode", next);
      announce(`Render mode ${next === "auto" ? "automatic" : next === "grid" ? "grid 1 km" : "raster 250 m"}`);
      return true;
    }
    case "toggleLens":
      setStoreField(view, "lens", !view.getState().lens);
      return true;
    case "toggleCompare": {
      // The store keeps an "off" compare object ({kind: null}); only a kind means "on".
      if (t.compare?.kind) {
        callAction(time, "setCompare", null) || time.setState({ compare: null });
        announce("Compare off");
      } else {
        const first = years.length ? Math.min(...years) : 1990;
        const last = years.length ? Math.max(...years) : 2050;
        const compare = { kind: "y", a: first, b: last };
        callAction(time, "setCompare", compare) || time.setState({ compare });
        if (view.getState().route !== "control") setStoreField(view, "route", "control");
        announce(`Compare ${first} versus ${last}`);
      }
      return true;
    }
    case "compareModes": {
      const compare = { kind: "m", a: "day", b: "night" };
      callAction(time, "setCompare", compare) || time.setState({ compare });
      setStoreField(view, "route", "control");
      return true;
    }
    case "compareYears": {
      const compare = { kind: "y", a: action.a, b: action.b };
      callAction(time, "setCompare", compare) || time.setState({ compare });
      setStoreField(view, "route", "control");
      return true;
    }
    case "focusLayerDock": {
      if (view.getState().route !== "control") setStoreField(view, "route", "control");
      const doc = win?.document;
      const tryFocus = () => focusTarget(doc, "layer-dock") || emit(win, SHELL_EVENTS.focusLayerDock);
      if (win?.requestAnimationFrame) win.requestAnimationFrame(tryFocus);
      else tryFocus();
      return true;
    }
    case "probeHottest":
      if (view.getState().route !== "control") setStoreField(view, "route", "control");
      emit(win, SHELL_EVENTS.probeHottest, {});
      return true;
    case "toggleBriefing": {
      const b = view.getState().briefing ?? { active: false, step: 0 };
      if (b.active) {
        callAction(view, "stopBriefing") || view.setState({ briefing: { active: false, step: 0 } });
      } else {
        setStoreField(view, "route", "control");
        callAction(view, "startBriefing", 0) || view.setState({ briefing: { active: true, step: 0 } });
      }
      return true;
    }
    case "cycleMotion": {
      const next = nextMotionPref(view.getState().motionPref ?? "system");
      setStoreField(view, "motionPref", next);
      announce(`Motion: ${MOTION_PREF_LABELS[next]}`);
      return true;
    }
    case "setMotion":
      setStoreField(view, "motionPref", action.value);
      announce(`Motion: ${MOTION_PREF_LABELS[action.value] ?? action.value}`);
      return true;
    case "setPerfTier":
      setStoreField(view, "perfTier", action.value);
      return true;
    case "setLayer":
      setStoreField(view, "layer", action.layer);
      if (action.shapFeature) setStoreField(view, "shapFeature", action.shapFeature);
      if (view.getState().route !== "control" && view.getState().route !== "drivers") setStoreField(view, "route", "control");
      return true;
    case "selectDistrict":
      setStoreField(selection, "districtId", action.districtId);
      emit(win, SHELL_EVENTS.flyTo, { districtId: action.districtId });
      return true;
    case "selectCell":
      setStoreField(selection, "pinnedIndex", action.cellIndex);
      emit(win, SHELL_EVENTS.flyTo, { cellIndex: action.cellIndex });
      return true;
    case "goToFrame": {
      if (Number.isFinite(action.year)) runAction({ type: "setYear", year: action.year }, ctx);
      if (action.mode) runAction({ type: "mode", mode: action.mode }, ctx);
      if (action.ssp) callAction(time, "setSsp", action.ssp) || time.setState({ ssp: action.ssp });
      return true;
    }
    case "exportPng":
      emit(win, SHELL_EVENTS.exportPng, {});
      return true;
    case "openPalette":
      ui.openPalette?.();
      return true;
    case "openShortcuts":
      ui.openShortcuts?.();
      return true;
    case "escape": {
      if (ui.closeOverlay?.()) return true;
      const s = selection.getState();
      if (s.pinnedIndex !== null && s.pinnedIndex !== undefined) {
        setStoreField(selection, "pinnedIndex", null);
        announce("Cell unpinned");
        return true;
      }
      if (view.getState().briefing?.active) {
        callAction(view, "stopBriefing") || view.setState({ briefing: { active: false, step: 0 } });
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}
