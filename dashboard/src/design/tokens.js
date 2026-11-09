/**
 * Delhi NCR Heat Atlas design tokens: the SINGLE source of truth (UI_SPEC_v2 §4.1).
 *
 * v3 ("dark AI lab", 2026-11): the chrome moved from navy HUD to neutral graphite with a
 * violet -> blue -> cyan brand gradient (brandA/B/C), Geist type and softer, larger radii.
 * Data colours (ramps, SSP, solar/lunar, zones, driver palette, signal) are unchanged: they
 * carry the accessibility and colour-blind guarantees below.
 *
 * Consumers
 *   - tailwind.config.js        -> utility classes (bg-surface-2, text-ink-faint, text-solar …)
 *   - src/design/tokens.css     -> CSS custom properties (generated from `cssVariables()`;
 *                                  `npm run tokens` rewrites it, tokens.test.js fails if it drifts)
 *   - src/lib/colors.js         -> THEME + ramp stops for deck.gl / canvas code
 *   - src/design/ramps.js       -> 256-entry OKLab LUTs and the GPU ramp texture
 *
 * This module is plain data with zero imports so that Node (Tailwind's config loader), Vite,
 * Vitest and Web Workers can all import it.
 *
 * Accessibility contract (asserted by src/design/tokens.test.js, WCAG 2.2 AA):
 *   - every `text` token >= 4.5:1 on every surface it can sit on (the faintest, ink-faint,
 *     is 5.11:1 on surface-3);
 *   - every non-text UI colour (signal, accents, status, control border) >= 3:1;
 *   - Day/Night/SSP series accents are >= 11 OKLab dE (x100) apart under simulated protan and
 *     deutan vision (Machado et al. 2009, severity 1);
 *   - sequential ramps are monotone in OKLab L (they read in greyscale), the diverging Polar
 *     ramp is V-shaped with near-symmetric arms;
 *   - ramp stop 0 >= 1.5:1 against --void (the darkest data colour never vanishes into the
 *     map surround);
 *   - --signal (chrome accent) is >= 8 dE from every Nocturne / Polar stop, so UI state never
 *     reads as data (decision D5 - the on-map reticle is white for the same reason).
 *
 * Deviations from the UI_SPEC table (all forced by the spec's own tests, see tokens.test.js):
 *   - control border #5E6B80 -> #63718A: the spec value is 2.90:1 on surface-3 (inputs), < 3:1.
 *   - Solar/Nocturne/Amplitude/Mist stop 0 lifted in OKLab L (hue and chroma kept) until
 *     >= 1.55:1 on --void: the spec stops measured 1.42 / 1.38 / 1.33 / 1.26.
 *   - Polar cool arm #B8F0FF #3DD6F5 #0F7FA0 -> #CFE3FF #7AA8F5 #2E5FB0 (azure instead of
 *     cyan): the spec stop #3DD6F5 is only 2.9 dE from --signal #45E0FF. The new arm keeps
 *     every one of the 256 LUT entries >= 9.5 dE from signal and makes the two arms
 *     L-symmetric (|dL| <= 0.015 per stop pair instead of 0.096).
 */

/** Surfaces, ink, accents, status, overlays. Hex unless an alpha is part of the token. */
export const color = Object.freeze({
  void: "#05060A",
  bg: "#08090D",
  surface1: "#0E1016", // used at 72 % + blur 12 px + saturate 140 % (glass over the map)
  surface1Alpha: 0.72,
  surface2: "#12141B",
  surface3: "#191C25",
  hairline: "rgba(226, 232, 255, 0.08)",
  hairlineStrong: "rgba(226, 232, 255, 0.16)",
  controlBorder: "#6B7286",
  inkStrong: "#F7F8FB",
  ink: "#E5E8EF",
  inkMuted: "#A7AEBC",
  inkFaint: "#8E95A4",
  signal: "#45E0FF",
  reticle: "#F4F7FB",
  solar: "#FFE27A",
  lunar: "#E0C9FF",
  ssp126: "#4F9DFF",
  ssp245: "#FF9B3D",
  ssp370: "#C98BFF", // optional: only if the pipeline exports ssp370 (not in GEE GDDP-CMIP6)
  ssp585: "#FF4F6D",
  ok: "#3DDC97",
  warn: "#FBBF24",
  crit: "#FF6B6B",
  fog: "rgba(140, 160, 200, 0.10)",
  hatch: "rgba(223, 231, 242, 0.22)",
  /** Brand gradient (chrome only, never data): violet -> blue -> cyan. */
  brandA: "#A78BFA",
  brandB: "#6D8DFF",
  brandC: "#45E0FF",
});

/**
 * Surfaces text/UI can sit on, as opaque hex (surface-1 is pre-composited at 72 % over
 * --void, the darkest thing it can float above). Used by the contrast tests and by
 * `compositeOver` callers that need an opaque equivalent.
 */
export const surfaces = Object.freeze({
  void: color.void,
  bg: color.bg,
  surface1: "#0B0D13", // #0E1016 @ 72 % over #05060A
  surface2: color.surface2,
  surface3: color.surface3,
});

/** Token groups by role, for the contrast tests (and a quick visual inventory). */
export const roles = Object.freeze({
  text: Object.freeze(["inkStrong", "ink", "inkMuted", "inkFaint", "signal", "solar", "lunar", "ok", "warn", "crit"]),
  nonText: Object.freeze([
    "controlBorder",
    "signal",
    "solar",
    "lunar",
    "ssp126",
    "ssp245",
    "ssp370",
    "ssp585",
    "ok",
    "warn",
    "crit",
  ]),
  /** Series accents that can appear together in one chart (ssp370 only when exported). */
  series: Object.freeze(["solar", "lunar", "ssp126", "ssp245", "ssp585"]),
  optionalSeries: Object.freeze(["ssp370"]),
});

/**
 * SSP scenario styling. Colour is never the only cue: every SSP strand carries its own dash
 * pattern and an end label (ssp245 vs ssp585 deutan separation is ~11.9 dE).
 * `dash` is an SVG stroke-dasharray (null = solid); `width` is the stroke width in px.
 */
export const ssp = Object.freeze({
  ssp126: Object.freeze({ id: "ssp126", label: "SSP1-2.6", short: "126", color: color.ssp126, dash: "8 4", width: 1.5 }),
  ssp245: Object.freeze({ id: "ssp245", label: "SSP2-4.5", short: "245", color: color.ssp245, dash: null, width: 1.5 }),
  ssp370: Object.freeze({ id: "ssp370", label: "SSP3-7.0", short: "370", color: color.ssp370, dash: "6 3 1.5 3", width: 1.5 }),
  ssp585: Object.freeze({ id: "ssp585", label: "SSP5-8.5", short: "585", color: color.ssp585, dash: null, width: 2.25 }),
});

/** Day / Night / DTR mode styling: accent + ramp family + icon name (glyphs.jsx). */
export const modes = Object.freeze({
  day: Object.freeze({ id: "day", label: "Day", accent: color.solar, ramp: "solar", icon: "sun" }),
  night: Object.freeze({ id: "night", label: "Night", accent: color.lunar, ramp: "nocturne", icon: "moon" }),
  dtr: Object.freeze({ id: "dtr", label: "DTR", accent: color.lunar, ramp: "amplitude", icon: "amplitude" }),
});

/**
 * Data ramps (low -> high). Interpolated in OKLab and baked into 256-entry LUTs by ramps.js.
 * The GPU texture row order is RAMP_ORDER (row index = position).
 */
export const ramps = Object.freeze({
  /** Day LST: deep indigo -> magenta -> amber -> cream (L 0.33 -> 0.96). */
  solar: Object.freeze(["#302376", "#5B23A8", "#9A2FA8", "#D6457A", "#F5774C", "#FDB54E", "#FFF3C4"]),
  /** Night LST: navy -> teal -> mint -> ice (L 0.32 -> 0.97). */
  nocturne: Object.freeze(["#1C2D66", "#1B4589", "#16709F", "#1C9AA6", "#4CC2A4", "#A2E3B6", "#ECFBE9"]),
  /** Diverging (anomaly, SUHI, delta, SHAP, residual, what-if): azure (cooler) <-> rose (warmer). */
  polar: Object.freeze(["#CFE3FF", "#7AA8F5", "#2E5FB0", "#1E2738", "#B3263E", "#FF6B7D", "#FFD0D6"]),
  /** Diurnal temperature range. */
  amplitude: Object.freeze(["#28304F", "#33407C", "#5B5AA8", "#9A6FBE", "#D68CC0", "#F6B9CF", "#FFF0F4"]),
  /** p95 - p05 spread (uncertainty magnitude). */
  mist: Object.freeze(["#293241", "#8E9AAD", "#EDF1F7"]),
});

/** Ramp kind: sequential ramps must be monotone in L; diverging ramps V-shaped about the midpoint. */
export const rampKind = Object.freeze({
  solar: "sequential",
  nocturne: "sequential",
  polar: "diverging",
  amplitude: "sequential",
  mist: "sequential",
});

/** GPU LUT texture row order (256 x 6 RGBA; row 5 is the categorical driver palette). */
export const RAMP_ORDER = Object.freeze(["solar", "nocturne", "polar", "amplitude", "mist"]);

/** Governance zones 0..3 (fallback when manifest.zones carries no colours; v1 palette per UI_SPEC §4.2). */
export const zoneColors = Object.freeze(["#34D399", "#22D3EE", "#A78BFA", "#FB7185"]);

/**
 * Zone pairs that are NOT separable under protan/deutan simulation (dE < 6): zone 0 "Ecological
 * Cool Base" green vs zone 3 "Heat Extreme Core" rose (dE 4.6). Every zone encoding must
 * therefore carry the zone name/number (legend, tooltip, card header) - never colour alone.
 */
export const zoneCvdWeakPairs = Object.freeze([Object.freeze([0, 3])]);

/**
 * Categorical driver palette (17 slots, v1 order: the order IS the colour-blind-safety
 * mechanism - every adjacent pair clears the CVD gates). Features beyond 17 are grouped
 * into the six families below for the "dominant driver" layer.
 */
export const driverPalette = Object.freeze([
  "#EC4899",
  "#FACC15",
  "#14B8A6",
  "#F59E0B",
  "#38BDF8",
  "#EA580C",
  "#A78BFA",
  "#EF4444",
  "#22D3EE",
  "#E11D48",
  "#4F46E5",
  "#34D399",
  "#3B82F6",
  "#A3E635",
  "#C084FC",
  "#16A34A",
  "#E879F9",
]);

/** Driver families (UI_SPEC §4.2) -> palette slot used when features are grouped. */
export const driverFamilies = Object.freeze({
  spectral: 13,
  terrain: 3,
  urban: 0,
  population: 1,
  landcover: 15,
  meteorology: 4,
});

/** Font stacks (self-hosted Geist variable fonts from @fontsource-variable, see app/layout.jsx). */
export const font = Object.freeze({
  display: Object.freeze(['"Geist Variable"', "Geist", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"]),
  sans: Object.freeze(['"Geist Variable"', "Geist", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"]),
  mono: Object.freeze(['"Geist Mono Variable"', '"Geist Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]),
});

/** Type scale (px / line-height) for the roles of UI_SPEC §4.3. */
export const type = Object.freeze({
  hero: Object.freeze({ size: 80, line: 1, tracking: "-0.04em", weight: 700 }),
  h1: Object.freeze({ size: 24, line: 1.25, weight: 600 }),
  h2: Object.freeze({ size: 16, line: 1.35, weight: 600 }),
  briefing: Object.freeze({ size: 32, line: 36 / 32, weight: 600 }),
  body: Object.freeze({ size: 14, line: 21 / 14, weight: 400 }),
  label: Object.freeze({ size: 13, line: 1.3, weight: 500 }),
  value: Object.freeze({ size: 17, line: 1.2, weight: 600 }),
  micro: Object.freeze({ size: 12, line: 1.3, tracking: "0.01em", weight: 500 }), // never < 11 px; sentence case in v3
  axis: Object.freeze({ size: 11, line: 1.2, weight: 400 }),
});

/** Radii, layout metrics (px). */
export const radius = Object.freeze({ sm: 8, md: 10, panel: 16, pill: 999 });
export const layout = Object.freeze({
  commandBar: 52,
  telemetry: 44,
  navRail: 64,
  mobileTabBar: 56,
  ribbon: 128,
  ribbonTablet: 104,
  ribbonTape: 72,
  inspector: 360,
  layerDock: 208,
  gutter: 16,
  /** Breakpoints: mobile < 640 <= tablet < 1280 <= desktop. */
  tablet: 640,
  desktop: 1280,
});

/** Shadows. Glow budget = 3 (playhead, selection reticle, one alert): only `glowSignal` and `glowAlert` glow. */
export const shadow = Object.freeze({
  panel: "0 0 0 1px rgba(0, 0, 0, 0.35), 0 12px 32px -16px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
  glowSignal: "0 0 12px rgba(69, 224, 255, 0.55)",
  glowAlert: "0 0 12px rgba(255, 107, 107, 0.45)",
  /** Hairline rings that replace v1's shadow-glow-* (kept as class names, no glow). */
  ringSignal: "0 0 0 1px rgba(69, 224, 255, 0.38)",
  ringLunar: "0 0 0 1px rgba(224, 201, 255, 0.36)",
  ringOk: "0 0 0 1px rgba(61, 220, 151, 0.36)",
  ringCrit: "0 0 0 1px rgba(255, 107, 107, 0.38)",
  ringWarn: "0 0 0 1px rgba(251, 191, 36, 0.4)",
});

/**
 * v1 colour names kept as Tailwind aliases so the reused v1 components (components/shap,
 * zones, performance, map) render inside the v2 palette without edits. New code uses the
 * v2 names (surface-*, hairline, signal, solar, lunar, ok/warn/crit).
 */
export const legacy = Object.freeze({
  bg: Object.freeze({ DEFAULT: color.bg, deep: color.void, raised: color.surface2 }),
  panel: Object.freeze({ DEFAULT: color.surface3, border: color.hairline, hover: "#202431" }),
  cyan: Object.freeze({ DEFAULT: color.signal, soft: "#8BEBFF", deep: "#0E7490" }),
  violet: Object.freeze({ DEFAULT: "#A78BFA", soft: "#C4B5FD", deep: "#6D28D9" }),
  emerald: Object.freeze({ DEFAULT: color.ok, soft: "#7FE9BC", deep: "#047857" }),
  rose: Object.freeze({ DEFAULT: "#FB7185", soft: "#FDA4AF", deep: "#BE123C" }),
  amber: Object.freeze({ DEFAULT: color.warn, soft: "#FCD34D", deep: "#B45309" }),
});

/**
 * Kebab-case CSS variable name for a camelCase token key, matching the UI_SPEC names:
 * "surface1" -> "--surface-1", "inkFaint" -> "--ink-faint", "ssp245" -> "--ssp245".
 */
export function cssVarName(key) {
  return `--${key
    .replace(/^surface(\d)/, "surface-$1")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()}`;
}

/**
 * Flat list of [cssVariableName, value] pairs written to tokens.css. Motion tokens are added
 * by motion.js (`motionCssVariables`) so this module stays dependency-free.
 */
export function cssVariables() {
  const out = [];
  for (const [key, value] of Object.entries(color)) {
    if (key === "surface1Alpha") continue;
    out.push([cssVarName(key), value]);
  }
  out.push(["--surface-1-alpha", String(color.surface1Alpha)]);
  out.push(["--surface-1-glass", "rgba(14, 16, 22, 0.72)"]);
  out.push(["--surface-2-solid", "rgba(18, 20, 27, 0.96)"]);
  out.push(["--brand-gradient", `linear-gradient(120deg, ${color.brandA} 0%, ${color.brandB} 48%, ${color.brandC} 100%)`]);
  out.push(["--mode-accent", color.solar]);
  for (const [name, stops] of Object.entries(ramps)) {
    out.push([`--ramp-${name}`, `linear-gradient(90deg, ${stops.map((c, i) => `${c} ${((i / (stops.length - 1)) * 100).toFixed(1)}%`).join(", ")})`]);
  }
  zoneColors.forEach((c, i) => out.push([`--zone-${i}`, c]));
  out.push(["--font-display", font.display.join(", ")]);
  out.push(["--font-sans", font.sans.join(", ")]);
  out.push(["--font-mono", font.mono.join(", ")]);
  for (const [key, px] of Object.entries(layout)) out.push([cssVarName(`layout${key[0].toUpperCase()}${key.slice(1)}`), `${px}px`]);
  for (const [key, px] of Object.entries(radius)) out.push([`--radius-${key}`, `${px}px`]);
  for (const [key, value] of Object.entries(shadow)) out.push([cssVarName(`shadow${key[0].toUpperCase()}${key.slice(1)}`), value]);
  return out;
}

export default Object.freeze({
  color,
  surfaces,
  roles,
  ssp,
  modes,
  ramps,
  rampKind,
  RAMP_ORDER,
  zoneColors,
  zoneCvdWeakPairs,
  driverPalette,
  driverFamilies,
  font,
  type,
  radius,
  layout,
  shadow,
  legacy,
});
