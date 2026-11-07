/**
 * Effective motion level for components ("full" | "reduced" | "off"), UI_SPEC_v2 §5.3.
 *
 * The shell resolves the user's preference (viewStore.motionPref + prefers-reduced-motion) and
 * writes it to `<html data-motion="...">`. Components read it here instead of importing the
 * stores, so UI primitives, charts and workers stay decoupled from state. Before the shell
 * has written the attribute (tests, isolated stories) the OS preference decides.
 */
import { useSyncExternalStore } from "react";
import { MOTION_LEVELS, motionMatrix, resolveMotionLevel } from "./motion.js";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function systemPrefersReduced() {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches;
  } catch {
    return false;
  }
}

/** Current effective level (non-React callers: engine, playback scheduler). */
export function getMotionLevel() {
  const attr = typeof document !== "undefined" ? document.documentElement?.dataset?.motion : undefined;
  if (MOTION_LEVELS.includes(attr)) return attr;
  return resolveMotionLevel("system", systemPrefersReduced());
}

function subscribe(onChange) {
  if (typeof document === "undefined") return () => {};
  const observer = typeof MutationObserver === "function" ? new MutationObserver(onChange) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  let mql = null;
  try {
    mql = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_QUERY) : null;
    mql?.addEventListener?.("change", onChange);
  } catch {
    mql = null;
  }
  return () => {
    observer?.disconnect();
    mql?.removeEventListener?.("change", onChange);
  };
}

/** React hook: effective motion level, re-rendering when it changes. */
export function useMotionLevel() {
  return useSyncExternalStore(subscribe, getMotionLevel, () => "full");
}

/** React hook: the reduced-motion matrix row for the current level. */
export function useMotionMatrix() {
  return motionMatrix(useMotionLevel());
}
