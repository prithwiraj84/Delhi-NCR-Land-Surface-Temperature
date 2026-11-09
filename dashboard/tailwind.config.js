/**
 * Tailwind theme for the Delhi NCR Heat Atlas (v3 dark AI lab chrome).
 *
 * Every value comes from src/design/tokens.js (the single source of truth, UI_SPEC_v2 §4.1);
 * nothing here is a literal colour. v2 code uses the v2 names (bg-surface-2, border-hairline,
 * text-ink-faint, text-signal, text-solar, text-ssp245, text-ok …). The v1 names (bg-panel,
 * border-panel-border, text-cyan, shadow-glow-* …) stay as aliases so the reused v1
 * components render inside the v2 palette unchanged; `shadow-glow-*` are now glow-free
 * hairline rings (glow budget = 3, §4.5).
 * @type {import('tailwindcss').Config}
 */
import tokens from "./src/design/tokens.js";
import { easing, motion } from "./src/design/motion.js";

const { color: c, legacy, font, shadow, radius, zoneColors } = tokens;

const ms = (token) => `${motion[token].ms}ms`;
const bezier = (name) => `cubic-bezier(${easing[name].join(", ")})`;

export default {
  content: ["./app/**/*.{js,jsx}", "./src/**/*.{js,jsx}", "./lib/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        void: c.void,
        bg: { ...legacy.bg, DEFAULT: c.bg },
        surface: { 1: c.surface1, 2: c.surface2, 3: c.surface3 },
        hairline: { DEFAULT: c.hairline, strong: c.hairlineStrong },
        control: c.controlBorder,
        ink: { DEFAULT: c.ink, strong: c.inkStrong, muted: c.inkMuted, faint: c.inkFaint },
        signal: c.signal,
        reticle: c.reticle,
        solar: c.solar,
        lunar: c.lunar,
        ssp126: c.ssp126,
        ssp245: c.ssp245,
        ssp370: c.ssp370,
        ssp585: c.ssp585,
        ok: c.ok,
        warn: c.warn,
        crit: c.crit,
        fog: c.fog,
        hatch: c.hatch,
        brand: { a: c.brandA, b: c.brandB, c: c.brandC },
        zone: { 0: zoneColors[0], 1: zoneColors[1], 2: zoneColors[2], 3: zoneColors[3] },
        // v1 aliases (see header)
        panel: legacy.panel,
        cyan: legacy.cyan,
        violet: legacy.violet,
        emerald: legacy.emerald,
        rose: legacy.rose,
        amber: legacy.amber,
      },
      fontFamily: {
        display: [...font.display],
        sans: [...font.sans],
        mono: [...font.mono],
      },
      fontSize: {
        micro: ["12px", { lineHeight: "1.3", letterSpacing: "0.01em" }],
        label: ["13px", { lineHeight: "1.3" }],
        body: ["14px", { lineHeight: "21px" }],
      },
      borderRadius: {
        panel: `${radius.panel}px`,
        card: "20px",
      },
      boxShadow: {
        panel: shadow.panel,
        glass: shadow.panel,
        "glow-signal": shadow.glowSignal,
        "glow-alert": shadow.glowAlert,
        "glow-cyan": shadow.ringSignal,
        "glow-violet": shadow.ringLunar,
        "glow-emerald": shadow.ringOk,
        "glow-rose": shadow.ringCrit,
        "glow-amber": shadow.ringWarn,
      },
      transitionDuration: {
        instant: ms("instant"),
        quick: ms("quick"),
        base: ms("base"),
        exit: ms("exit"),
        layer: ms("layer"),
      },
      transitionTimingFunction: {
        quick: bezier("quick"),
        "expo-out": bezier("expoOut"),
        exit: bezier("exit"),
        "cubic-in-out": bezier("cubicInOut"),
        out: bezier("out"),
        "in-out": bezier("inOut"),
        drawer: bezier("drawer"),
      },
      keyframes: {
        "live-pulse": {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        "scan-sweep": {
          "0%": { transform: "translateY(-1px)" },
          "100%": { transform: "translateY(var(--scan-distance, 100%))" },
        },
        "ring-spin": {
          to: { transform: "rotate(360deg)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "live-pulse": "live-pulse 2.8s ease-in-out infinite",
        // v1 name kept: the status-dot pulse is the only ambient motion allowed (§5.2 L).
        "glow-pulse": "live-pulse 2.8s ease-in-out infinite",
        "scan-sweep": "scan-sweep 1.6s linear infinite",
        shimmer: "shimmer 1.6s linear infinite",
      },
      zIndex: {
        stage: "0",
        hud: "10",
        chrome: "30",
        overlay: "50",
        palette: "60",
        toast: "70",
        boot: "80",
      },
    },
  },
  plugins: [],
};
