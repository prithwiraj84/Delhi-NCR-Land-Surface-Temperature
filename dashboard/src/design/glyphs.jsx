/**
 * Custom inline SVG glyphs (UI_SPEC_v2 §4.4). lucide-react covers general icons; these are
 * the instrument-specific marks. All glyphs are decorative by default (aria-hidden) - the
 * caller supplies the accessible name (label text or aria-label on the control).
 * `currentColor` everywhere, 16 px default, 1.5 stroke to match lucide.
 */
import { useId } from "react";
import { normalizeTier } from "./tiers.js";

const base = (size, rest) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": rest["aria-label"] ? undefined : true,
  role: rest["aria-label"] ? "img" : undefined,
  focusable: "false",
  ...rest,
});

/** Brand mark ◈: a diamond with a centred core (registration target). */
export function BrandGlyph({ size = 16, ...rest }) {
  return (
    <svg {...base(size, rest)}>
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" />
      <path d="M8 5.5 10.5 8 8 10.5 5.5 8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Satellite swath band (boot acquisition, sensor tracks). */
export function SwathGlyph({ size = 16, ...rest }) {
  return (
    <svg {...base(size, rest)}>
      <path d="M2 12 10 2M6 14l8-10" />
      <path d="M3.5 13 11.5 3" strokeDasharray="1.5 2" opacity="0.7" />
    </svg>
  );
}

/** Downscale lens: circle with a fine inner grid. */
export function LensGlyph({ size = 16, ...rest }) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5 8h6M8 5v6M5.8 5.8h4.4v4.4H5.8Z" strokeWidth="0.9" opacity="0.8" />
    </svg>
  );
}

/** Split compare: frame with a vertical divider and handles. */
export function SplitCompareGlyph({ size = 16, ...rest }) {
  return (
    <svg {...base(size, rest)}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M8 1v14" />
      <path d="m5.5 8-1.5 0M10.5 8H12" opacity="0.7" />
    </svg>
  );
}

/** Day/Night terminator: half-lit disc with a curved front. */
export function TerminatorGlyph({ size = 16, ...rest }) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a4 6 0 0 0 0 12" fill="currentColor" stroke="none" opacity="0.85" />
    </svg>
  );
}

/** Registration corner (HUD bracket) - `corner` = "tl" | "tr" | "bl" | "br". */
export function RegistrationCorner({ size = 8, corner = "tl", ...rest }) {
  const rot = { tl: 0, tr: 90, br: 180, bl: 270 }[corner] ?? 0;
  return (
    <svg {...base(size, rest)} viewBox="0 0 8 8" strokeWidth="1">
      <path d="M0.5 7.5V0.5H7.5" transform={`rotate(${rot} 4 4)`} />
    </svg>
  );
}

/**
 * SSP strand: a short line in the scenario's dash pattern (legend swatch). `dash` is an SVG
 * stroke-dasharray or null for solid; `weight` the stroke width.
 */
export function SspStrand({ width = 22, height = 8, color = "currentColor", dash = null, weight = 1.5, ...rest }) {
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" {...rest}>
      <path
        d={`M1 ${height - 2} L${width * 0.45} ${height / 2} L${width - 1} 2`}
        fill="none"
        stroke={color}
        strokeWidth={weight}
        strokeDasharray={dash ?? undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Sun <-> Moon crescent morph. `night` toggles; the occluding disc slides in over 220 ms
 * (CSS transition on transform, so reduced/off motion levels collapse it to a jump).
 */
export function SunMoonGlyph({ size = 16, night = false, ...rest }) {
  const maskId = `sm-${useId().replace(/:/g, "")}`;
  return (
    <svg {...base(size, rest)}>
      <mask id={maskId}>
        <rect width="16" height="16" fill="#fff" />
        <circle
          cx="13"
          cy="4"
          r="5"
          fill="#000"
          style={{
            transform: night ? "translate(0,0)" : "translate(6px,-6px)",
            transition: "transform var(--motion-base, 220ms) var(--ease-expo-out, ease-out)",
          }}
        />
      </mask>
      <circle cx="8" cy="8" r={night ? 5.5 : 3.25} fill="currentColor" stroke="none" mask={`url(#${maskId})`} />
      <g style={{ opacity: night ? 0 : 1, transition: "opacity var(--motion-quick, 140ms) linear" }}>
        <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3" />
      </g>
    </svg>
  );
}

/**
 * Tier glyph drawn as SVG (text glyphs U+25xx are not in the self-hosted font subsets, so a
 * shape is drawn instead of relying on a fallback font). Encodes the tier by SHAPE + FILL,
 * never by hue: filled disc, half-filled (top) disc, half-filled (left) disc, hollow diamond,
 * hollow disc, hatched square.
 */
export function TierShape({ tier, size = 12, ...rest }) {
  const id = normalizeTier(tier);
  const p = { ...base(size, rest), viewBox: "0 0 12 12", strokeWidth: 1.25 };
  switch (id) {
    case "observed":
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="4.5" fill="currentColor" />
        </svg>
      );
    case "observed-sparse":
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M1.5 6a4.5 4.5 0 0 1 9 0Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "reconstructed":
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 1.5a4.5 4.5 0 0 0 0 9Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "modelled":
      return (
        <svg {...p}>
          <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" />
        </svg>
      );
    case "projected":
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="4.5" strokeDasharray="2.2 1.4" />
        </svg>
      );
    case "simulated-demo":
      return (
        <svg {...p}>
          <rect x="1.75" y="1.75" width="8.5" height="8.5" rx="1" />
          <path d="M2 7 7 2M5 10l5-5" strokeWidth="1" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <path d="M3 6h6" />
        </svg>
      );
  }
}
