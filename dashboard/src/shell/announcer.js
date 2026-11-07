/**
 * Screen-reader announcements (UI_SPEC_v2 §12 "Live region"). Rendered by LiveAnnouncer.jsx
 * as an `aria-live="polite"` region.
 *
 *   import { announce } from "../shell/announcer.js";
 *   announce("2040, projected under SSP2-4.5, night, NCR mean 31.2 °C");
 *
 * - Debounced 500 ms: a burst of calls (e.g. scrub snapping, mode + SSP changed together)
 *   announces only the last message.
 * - Never during playback: callers pass nothing special - the shell registers a
 *   `isSuppressed` predicate (timeStore.playing) via `setAnnounceSuppressor`.
 * - `{assertive: true}` routes to the assertive region (errors only).
 * - Identical consecutive messages are re-announced by toggling a zero-width suffix, because
 *   screen readers ignore unchanged live-region text.
 */
import { create } from "zustand";

export const ANNOUNCE_DEBOUNCE_MS = 500;

export const useAnnouncerStore = create(() => ({ polite: "", assertive: "", seq: 0 }));

/** Zero-width space appended to repeat an identical message (screen readers skip unchanged text). */
const ZWSP = String.fromCharCode(0x200b);
const ZWSP_TAIL = new RegExp(ZWSP + "$");

let timer = null;
let pending = null;
let suppressor = () => false;

/** Register a predicate that suppresses polite announcements (e.g. while playing). */
export function setAnnounceSuppressor(fn) {
  suppressor = typeof fn === "function" ? fn : () => false;
}

function flush() {
  timer = null;
  if (!pending) return;
  const { message, assertive } = pending;
  pending = null;
  if (!assertive && suppressor()) return;
  const state = useAnnouncerStore.getState();
  const key = assertive ? "assertive" : "polite";
  const same = state[key].replace(ZWSP_TAIL, "") === message;
  useAnnouncerStore.setState({ [key]: same && !state[key].endsWith(ZWSP) ? message + ZWSP : message, seq: state.seq + 1 });
}

/**
 * Queue a message for the live region.
 * @param {string} message
 * @param {{assertive?: boolean, immediate?: boolean}} [options]
 */
export function announce(message, { assertive = false, immediate = false } = {}) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return;
  pending = { message: text, assertive };
  if (timer) clearTimeout(timer);
  if (immediate) flush();
  else timer = setTimeout(flush, ANNOUNCE_DEBOUNCE_MS);
}

/** Drop any queued announcement (used on unmount and in tests). */
export function cancelAnnouncements() {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
}
