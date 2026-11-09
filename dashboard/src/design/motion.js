/**
 * Motion system (UI_SPEC_v2 §5): duration/easing tokens for framer-motion, the map engine
 * and CSS, plus the reduced-motion matrix (§5.3) as data.
 *
 * Laws (enforced by review, partly by tests):
 *   1. Data never overshoots - springs are for chrome only; data uses linear / cubic easing.
 *   2. Exits are at most 75 % of the entrance duration (exit 160 <= 0.75 x base 220).
 *   3. Stagger <= 40 ms per item, <= 8 items.
 *   4. During playback only transform, opacity, CSS variables and GPU uniforms animate.
 *   5. Everything pauses on `visibilitychange` hidden.
 *   6. Each element animates at most 2 properties.
 *
 * Zero imports so that workers and the engine can use the tokens.
 */

/** Cubic-bezier control points (CSS order x1, y1, x2, y2). */
export const easing = Object.freeze({
  linear: Object.freeze([0, 0, 1, 1]),
  quick: Object.freeze([0.2, 0.8, 0.2, 1]),
  expoOut: Object.freeze([0.16, 1, 0.3, 1]),
  exit: Object.freeze([0.4, 0, 1, 1]),
  cubicInOut: Object.freeze([0.65, 0, 0.35, 1]),
  sineInOut: Object.freeze([0.37, 0, 0.63, 1]),
  // Strong curves from the emil-design-eng skill: UI enters AND exits ease-out (never ease-in);
  // on-screen movement uses the strong ease-in-out; sheets/drawers use the iOS drawer curve.
  out: Object.freeze([0.23, 1, 0.32, 1]),
  inOut: Object.freeze([0.77, 0, 0.175, 1]),
  drawer: Object.freeze([0.32, 0.72, 0, 1]),
});

/**
 * Duration tokens (ms) with their easing name. `data` has no duration: scrub interpolation is
 * value-linear in t and driven 1:1 by the pointer.
 */
export const motion = Object.freeze({
  instant: Object.freeze({ ms: 80, ease: "linear" }),
  quick: Object.freeze({ ms: 140, ease: "quick" }),
  base: Object.freeze({ ms: 220, ease: "expoOut" }),
  exit: Object.freeze({ ms: 160, ease: "out" }),
  layer: Object.freeze({ ms: 400, ease: "cubicInOut" }),
  epoch: Object.freeze({ ms: 800, ease: "cubicInOut" }),
  elev: Object.freeze({ ms: 550, ease: "cubicInOut" }),
  ticker: Object.freeze({ ms: 500, ease: "expoOut" }),
  terminator: Object.freeze({ ms: 700, ease: "sineInOut" }),
  unfurl: Object.freeze({ ms: 900, ease: "cubicInOut", stagger: 120 }),
  flight: Object.freeze({ ms: 1200, ease: "cubicInOut", curve: 1.4 }),
  cinematic: Object.freeze({ ms: 2400, ease: "cubicInOut" }),
  data: Object.freeze({ ms: 0, ease: "linear" }),
});

/** Springs (framer-motion units). Chrome only - never for data values. */
export const springs = Object.freeze({
  ui: Object.freeze({ type: "spring", stiffness: 420, damping: 34 }),
  soft: Object.freeze({ type: "spring", stiffness: 260, damping: 30 }),
});

/** Stagger limits (law 3). */
export const STAGGER_MS = 40;
export const STAGGER_MAX_ITEMS = 8;

/** CSS `cubic-bezier(...)` string for an easing name. */
export function cssEase(name) {
  const e = easing[name] ?? easing.linear;
  return `cubic-bezier(${e.join(", ")})`;
}

/**
 * framer-motion transition object for a token: `transition("base")` ->
 * `{duration: 0.22, ease: [0.16, 1, 0.3, 1]}`. `scale` multiplies the duration (0 = jump).
 */
export function transition(token, { scale = 1, delay = 0 } = {}) {
  const t = motion[token] ?? motion.base;
  return { duration: (t.ms * scale) / 1000, ease: [...(easing[t.ease] ?? easing.linear)], delay: delay / 1000 };
}

/** Stagger delay (ms) for item `index`, clamped to the law-3 budget. */
export function staggerDelay(index, step = STAGGER_MS) {
  const i = Math.max(0, Math.min(index, STAGGER_MAX_ITEMS - 1));
  return i * Math.min(step, STAGGER_MS);
}

/** CSS custom properties mirrored into tokens.css (`--motion-<token>`, `--ease-<name>`). */
export function motionCssVariables() {
  const out = [];
  for (const [name, t] of Object.entries(motion)) {
    if (name === "data") continue;
    out.push([`--motion-${name}`, `${t.ms}ms`]);
  }
  for (const name of Object.keys(easing)) out.push([`--ease-${name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`, cssEase(name)]);
  return out;
}

// ---------------------------------------------------------------------------------------
// Motion levels and the reduced-motion matrix (§5.3)
// ---------------------------------------------------------------------------------------

/** User preference values (viewStore.motionPref). "system" follows prefers-reduced-motion. */
export const MOTION_PREFS = Object.freeze(["system", "full", "reduced", "off"]);

/** Effective levels after resolving "system". */
export const MOTION_LEVELS = Object.freeze(["full", "reduced", "off"]);

export const MOTION_PREF_LABELS = Object.freeze({
  system: "System",
  full: "Full",
  reduced: "Reduced",
  off: "Off",
});

/** localStorage key for the motion preference (read/written inside try/catch). */
export const MOTION_STORAGE_KEY = "ncr-thermal-ops:motion"; // same key as state/stores/viewStore.js

/**
 * Resolve the effective motion level.
 * @param {string} pref one of MOTION_PREFS (unknown values behave like "system")
 * @param {boolean} systemReduced `prefers-reduced-motion: reduce` matches
 * @returns {"full"|"reduced"|"off"}
 */
export function resolveMotionLevel(pref, systemReduced) {
  if (pref === "full" || pref === "reduced" || pref === "off") return pref;
  return systemReduced ? "reduced" : "full";
}

/** Next preference in the `M` key cycle: System -> Full -> Reduced -> Off -> System. */
export function nextMotionPref(pref) {
  const i = MOTION_PREFS.indexOf(pref);
  return MOTION_PREFS[(i < 0 ? 0 : i + 1) % MOTION_PREFS.length];
}

/**
 * The reduced-motion matrix as numbers each consumer reads instead of re-deriving the rules.
 * Durations are ms; 0 means "jump" (no animation).
 */
export const MOTION_MATRIX = Object.freeze({
  full: Object.freeze({
    boot: motion.cinematic.ms,
    bootSkipped: false,
    flight: motion.flight.ms,
    flightKind: "fly",
    scrubTween: true,
    playTween: motion.epoch.ms,
    playHold: motion.epoch.ms,
    terminator: motion.terminator.ms,
    terminatorKind: "sweep",
    tickers: true,
    nowCrossing: "full",
    panels: "stagger",
    panelMs: motion.base.ms,
    ripple: "radial",
    rippleMs: 800,
    ambient: true,
  }),
  reduced: Object.freeze({
    boot: 0,
    bootSkipped: true,
    flight: 150,
    flightKind: "fade",
    scrubTween: true,
    playTween: 0,
    playHold: 2500,
    terminator: 150,
    terminatorKind: "fade",
    tickers: false,
    nowCrossing: "fog-jump",
    panels: "opacity",
    panelMs: 120,
    ripple: "fade",
    rippleMs: 200,
    ambient: false,
  }),
  off: Object.freeze({
    boot: 0,
    bootSkipped: true,
    flight: 0,
    flightKind: "jump",
    scrubTween: false,
    playTween: 0,
    playHold: 3000,
    terminator: 0,
    terminatorKind: "jump",
    tickers: false,
    nowCrossing: "toast",
    panels: "none",
    panelMs: 0,
    ripple: "jump",
    rippleMs: 0,
    ambient: false,
  }),
});

/** Matrix row for an effective level (defaults to "full"). */
export function motionMatrix(level) {
  return MOTION_MATRIX[level] ?? MOTION_MATRIX.full;
}

/**
 * Panel enter/exit variants for framer-motion, by level (§5.2 I: rise 8 px + blur 4 -> 0 in
 * 220 ms; exit fades and lifts 4 px in 160 ms). Two animated properties max (law 6) - blur is
 * applied through `filter`, counted with opacity as the "appearance" pair, y is transform.
 */
export function panelVariants(level) {
  if (level === "off") {
    return { initial: false, animate: { opacity: 1 }, exit: { opacity: 1, transition: { duration: 0 } } };
  }
  if (level === "reduced") {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: { duration: 0.12 } },
      exit: { opacity: 0, transition: { duration: 0.09 } },
    };
  }
  return {
    initial: { opacity: 0, y: 8, filter: "blur(4px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: transition("base") },
    exit: { opacity: 0, y: -4, filter: "blur(0px)", transition: transition("exit") },
  };
}
