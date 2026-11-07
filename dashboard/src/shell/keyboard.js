/**
 * Global keyboard map (UI_SPEC_v2 §2.3). Pure: `resolveShortcut(event, context)` turns a
 * KeyboardEvent-like object into an action descriptor `{type, ...}` (or null); the shell's
 * `runAction` (actions.js) executes it against the stores. Keeping resolution pure makes the
 * whole map unit-testable without a DOM.
 *
 * Rules
 *   - Keys are ignored while typing (inputs, textareas, selects, contenteditable) - v1's
 *     `isTypingTarget` - except Escape and Ctrl/⌘ K.
 *   - The ribbon slider owns the arrow/Home/End/PageUp/PageDown keys while it has focus
 *     (role="slider"), so they are not resolved globally then.
 *   - Modifier chords other than Shift (and Ctrl/⌘ K) are left to the browser.
 *   - While a modal surface (palette, shortcut sheet, settings) is open only Escape resolves.
 */

/** True when the event target is a text-entry control (shortcuts must not fire). */
export function isTypingTarget(el) {
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = String(el.type ?? "text").toLowerCase();
    return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file", "image"].includes(type);
  }
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

/** True when the target is a slider that owns the arrow keys (the time ribbon). */
export function isSliderTarget(el) {
  return !!el && typeof el.getAttribute === "function" && el.getAttribute("role") === "slider";
}

const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/**
 * Shortcut table (also rendered by ShortcutSheet). `keys` are display labels; `group` orders
 * the sheet.
 */
export const SHORTCUTS = Object.freeze([
  { group: "Navigate", keys: ["1", "–", "6"], label: "Switch view (Control, Timeline, Drivers, Zones, Model Lab, Sources)" },
  { group: "Navigate", keys: ["Ctrl", "K"], label: "Command palette (districts, years, layers, commands)" },
  { group: "Navigate", keys: ["?"], label: "This shortcut sheet" },
  { group: "Navigate", keys: ["Esc"], label: "Close overlay / unpin cell" },
  { group: "Time", keys: ["Space"], label: "Play / pause" },
  { group: "Time", keys: ["←", "→"], label: "Previous / next frame (also [ and ])" },
  { group: "Time", keys: [",", "."], label: "−1 / +1 year (interpolated)" },
  { group: "Time", keys: ["Shift", "←/→"], label: "Jump to tier boundary (first observed, NOW, 2050)" },
  { group: "Time", keys: ["PgUp", "PgDn"], label: "+10 / −10 years" },
  { group: "Time", keys: ["Home", "End"], label: "1990 / 2050" },
  { group: "Mode", keys: ["D"], label: "Day" },
  { group: "Mode", keys: ["N"], label: "Night" },
  { group: "Mode", keys: ["T"], label: "Toggle Day / Night" },
  { group: "Mode", keys: ["A"], label: "Diurnal range (DTR)" },
  { group: "Mode", keys: ["S"], label: "Cycle SSP scenario" },
  { group: "Map", keys: ["L"], label: "Focus the layer dock" },
  { group: "Map", keys: ["G"], label: "Grid / raster / auto" },
  { group: "Map", keys: ["Z"], label: "Downscale lens (250 m)" },
  { group: "Map", keys: ["C"], label: "Compare (split)" },
  { group: "Map", keys: ["H"], label: "Probe the hottest cell" },
  { group: "Map", keys: ["B"], label: "Briefing (guided tour)" },
  { group: "Settings", keys: ["M"], label: "Cycle motion level (System, Full, Reduced, Off)" },
]);

const LETTER_ACTIONS = Object.freeze({
  d: { type: "mode", mode: "day" },
  n: { type: "mode", mode: "night" },
  t: { type: "toggleDayNight" },
  a: { type: "mode", mode: "dtr" },
  s: { type: "cycleSsp" },
  l: { type: "focusLayerDock" },
  g: { type: "cycleRender" },
  z: { type: "toggleLens" },
  c: { type: "toggleCompare" },
  h: { type: "probeHottest" },
  b: { type: "toggleBriefing" },
  m: { type: "cycleMotion" },
});

/**
 * Resolve a key event to an action.
 * @param {{key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean,
 *          target?: any, repeat?: boolean}} event
 * @param {{routeCount?: number, overlayOpen?: boolean, ready?: boolean}} [context]
 * @returns {null | {type: string, [k: string]: any}}
 */
export function resolveShortcut(event, { routeCount = 6, overlayOpen = false, ready = true } = {}) {
  if (!event || typeof event.key !== "string") return null;
  const { key, shiftKey = false, ctrlKey = false, metaKey = false, altKey = false, target = null } = event;

  if ((ctrlKey || metaKey) && !altKey && key.toLowerCase() === "k") return { type: "openPalette" };
  if (key === "Escape") return { type: "escape" };
  if (overlayOpen || !ready) return null;
  if (ctrlKey || metaKey || altKey) return null;
  if (isTypingTarget(target)) return null;
  if (isSliderTarget(target) && SLIDER_KEYS.has(key)) return null;

  if (key === "?" || (key === "/" && shiftKey)) return { type: "openShortcuts" };

  if (/^[1-9]$/.test(key) && !shiftKey) {
    const index = Number(key) - 1;
    return index < routeCount ? { type: "route", index } : null;
  }

  switch (key) {
    case " ":
    case "Spacebar":
      // Space on a focused button/link activates it natively - don't hijack.
      if (target && ["BUTTON", "A", "SUMMARY"].includes(String(target.tagName ?? "").toUpperCase())) return null;
      return event.repeat ? null : { type: "togglePlay" };
    case "ArrowLeft":
      return shiftKey ? { type: "jumpTier", dir: -1 } : { type: "stepFrame", dir: -1 };
    case "ArrowRight":
      return shiftKey ? { type: "jumpTier", dir: 1 } : { type: "stepFrame", dir: 1 };
    case "[":
      return { type: "stepFrame", dir: -1 };
    case "]":
      return { type: "stepFrame", dir: 1 };
    case ",":
      return { type: "stepYear", delta: -1 };
    case ".":
      return { type: "stepYear", delta: 1 };
    // WAI-ARIA slider convention: Page Up = +10 years, Page Down = −10 years.
    case "PageUp":
      return { type: "stepYear", delta: 10 };
    case "PageDown":
      return { type: "stepYear", delta: -10 };
    case "Home":
      return { type: "setYear", year: 1990 };
    case "End":
      return { type: "setYear", year: 2050 };
    default:
      break;
  }

  if (key.length === 1 && !shiftKey) {
    const action = LETTER_ACTIONS[key.toLowerCase()];
    if (action) return { ...action };
  }
  return null;
}
