/**
 * Ribbon playhead (UI_SPEC_v2 §3.3, §4.5): a 2 px signal line with a diamond handle and the
 * playhead glow (one of the three glow-budget items). Its x position is written imperatively
 * by the ribbon (`transform` on the returned group) from timeStore.scrubT, so scrubbing never
 * re-renders React (§6.5). The 32 px transparent hit area is the drag handle (§12).
 *
 * `buffering` (next frame not loaded) pulses the handle (2.8 s, well under 3 Hz); the ghost
 * variant is the hover position (no glow, dashed, 40 % ink).
 */
import { forwardRef } from "react";
import { PLAYHEAD_HIT_PX } from "./ribbonScale.js";

/**
 * @param {{top:number, bottom:number, handleY:number, buffering?: boolean, ghost?: boolean,
 *          interpolated?: boolean, onPointerDown?: Function}} props
 */
export const Playhead = forwardRef(function Playhead({ top, bottom, handleY, buffering = false, ghost = false, interpolated = false, onPointerDown }, ref) {
  if (ghost) {
    return (
      <g ref={ref} aria-hidden="true" style={{ pointerEvents: "none" }}>
        <line x1={0} x2={0} y1={top} y2={bottom} stroke="var(--ink)" strokeOpacity={0.4} strokeWidth={1} strokeDasharray="3 3" />
      </g>
    );
  }
  const s = 6;
  return (
    <g ref={ref} aria-hidden="true" data-testid="ribbon-playhead">
      <line x1={0} x2={0} y1={top} y2={bottom} stroke="var(--signal)" strokeWidth={2} style={{ filter: "drop-shadow(0 0 6px rgba(69, 224, 255, 0.55))" }} />
      <path
        d={`M0 ${handleY - s}L${s} ${handleY}L0 ${handleY + s}L${-s} ${handleY}Z`}
        fill={interpolated ? "var(--void)" : "var(--signal)"}
        stroke="var(--signal)"
        strokeWidth={1.5}
        className={buffering ? "animate-live-pulse" : undefined}
      />
      {/* Generous transparent hit area: the drag handle. */}
      <rect
        x={-PLAYHEAD_HIT_PX / 2}
        y={top}
        width={PLAYHEAD_HIT_PX}
        height={bottom - top}
        fill="transparent"
        style={{ cursor: "ew-resize", touchAction: "none" }}
        data-role="playhead-handle"
        onPointerDown={onPointerDown}
      />
    </g>
  );
});
