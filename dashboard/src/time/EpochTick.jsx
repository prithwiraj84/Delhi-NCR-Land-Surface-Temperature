/**
 * One frame tick on the ribbon track (UI_SPEC_v2 §3.3, §8 `EpochTick`).
 *
 * Props: `year, tier, window, available` (+ geometry). States: default, hover, current,
 * unavailable, loading. The tier glyph is the manifest tier of this year × mode (passed in by
 * the ribbon from `frameTicks`), drawn as a shape (filled / half / diamond / dashed ring) so
 * evidence never depends on hue. Ticks are not tab stops: the ribbon slider owns the keys and
 * the pointer hit-testing (UI_SPEC §12 "Ticks are not separate tab stops").
 */
import { memo } from "react";
import { TierShape } from "../design/glyphs.jsx";

/**
 * @param {{x:number, trackY:number, trackH:number, labelY:number, year:number, tier:string|null,
 *          available:boolean, state?: "default"|"hover"|"current"|"loading", labelled?: boolean,
 *          glyphSize?: number}} props
 */
export const EpochTick = memo(function EpochTick({ x, trackY, trackH, labelY, year, tier, available, state = "default", labelled = true, glyphSize = 10 }) {
  const current = state === "current";
  const hover = state === "hover";
  const tone = !available ? "var(--ink-faint)" : current ? "var(--ink-strong)" : hover ? "var(--ink)" : "var(--ink-muted)";
  const cy = trackY + trackH / 2;
  return (
    <g aria-hidden="true" data-year={year} data-state={available ? state : "unavailable"} className={state === "loading" ? "animate-live-pulse" : undefined}>
      <line x1={x} x2={x} y1={trackY} y2={trackY + trackH} stroke={tone} strokeOpacity={available ? 0.55 : 0.35} strokeWidth={1} strokeDasharray={available ? undefined : "2 2"} />
      {available ? (
        <g style={{ color: tone }}>
          {/* Surface ring keeps the glyph legible over the track pattern. */}
          <circle cx={x} cy={cy} r={glyphSize / 2 + 1.5} fill="var(--surface-2)" />
          <TierShape tier={tier} size={glyphSize} x={x - glyphSize / 2} y={cy - glyphSize / 2} />
        </g>
      ) : (
        <path d={`M${x - 3} ${cy}h6`} stroke={tone} strokeWidth={1.25} />
      )}
      {labelled && (
        <text
          x={x}
          y={labelY}
          textAnchor="middle"
          className="tnum"
          style={{ font: `${current ? 600 : 400} 11px var(--font-mono)`, fill: tone, letterSpacing: "0.02em" }}
        >
          {year}
        </text>
      )}
    </g>
  );
});
