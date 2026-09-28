/**
 * Tailwind theme for the thermal digital twin.
 * Colour tokens mirror `src/lib/colors.js` (THEME) and the CSS variables in `src/index.css`;
 * keep the three in sync when changing a hue.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#090d16",
          deep: "#05080f",
          raised: "#0f1624",
        },
        panel: {
          DEFAULT: "#1e293b",
          border: "rgba(148, 163, 184, 0.16)",
          hover: "#243247",
        },
        ink: {
          DEFAULT: "#e2e8f0",
          strong: "#f8fafc",
          muted: "#94a3b8",
          // >= 4.5:1 (WCAG AA small text) on bg and every panel surface up to #1e293b.
          faint: "#8a97ab",
        },
        cyan: { DEFAULT: "#22d3ee", soft: "#67e8f9", deep: "#0e7490" },
        violet: { DEFAULT: "#a78bfa", soft: "#c4b5fd", deep: "#6d28d9" },
        emerald: { DEFAULT: "#34d399", soft: "#6ee7b7", deep: "#047857" },
        rose: { DEFAULT: "#fb7185", soft: "#fda4af", deep: "#be123c" },
        amber: { DEFAULT: "#fbbf24", soft: "#fcd34d", deep: "#b45309" },
      },
      fontFamily: {
        display: ['"Space Grotesk"', "Inter", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        "glow-cyan": "0 0 0 1px rgba(34,211,238,0.35), 0 0 18px -2px rgba(34,211,238,0.45)",
        "glow-violet": "0 0 0 1px rgba(167,139,250,0.35), 0 0 18px -2px rgba(167,139,250,0.45)",
        "glow-emerald": "0 0 0 1px rgba(52,211,153,0.35), 0 0 18px -2px rgba(52,211,153,0.45)",
        "glow-rose": "0 0 0 1px rgba(251,113,133,0.35), 0 0 18px -2px rgba(251,113,133,0.45)",
        "glow-amber": "0 0 0 1px rgba(251,191,36,0.4), 0 0 18px -2px rgba(251,191,36,0.45)",
        glass: "0 8px 32px -8px rgba(2, 6, 23, 0.65), inset 0 1px 0 rgba(255,255,255,0.04)",
      },
      keyframes: {
        "glow-pulse": {
          "0%, 100%": { opacity: "0.55", filter: "drop-shadow(0 0 2px currentColor)" },
          "50%": { opacity: "1", filter: "drop-shadow(0 0 8px currentColor)" },
        },
        "grid-drift": {
          "0%": { backgroundPosition: "0 0, 0 0" },
          "100%": { backgroundPosition: "48px 48px, 48px 48px" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "glow-pulse": "glow-pulse 2.8s ease-in-out infinite",
        "grid-drift": "grid-drift 24s linear infinite",
        shimmer: "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
};
