"use client";
/**
 * Before / after comparison of two real LST rasters (e.g. 1990 vs 2025). The "after" image is
 * clipped with clip-path: inset(0 0 0 X%) and the divider follows the pointer 1:1 (pointer
 * capture, no easing while dragging: the gestures skill's "track the finger" rule). Keyboard
 * and screen readers use the visually hidden range input that drives the same value; a click
 * on the track jumps there with a short 160 ms ease-out so the jump is legible.
 */
import { useCallback, useRef, useState } from "react";

export function CompareSlider({ before, after, beforeLabel, afterLabel, alt, width = 960, height = 1043, caption }) {
  const frameRef = useRef(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [animate, setAnimate] = useState(false);

  const fromEvent = useCallback((e) => {
    const r = frameRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
  }, []);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setAnimate(true); // the first jump to the pointer is eased, the drag is not
    setPos(fromEvent(e));
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    setAnimate(false);
    setPos(fromEvent(e));
  };
  const end = (e) => {
    setDragging(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const t = animate ? "160ms var(--ease-out)" : "0ms";
  return (
    <figure className="m-0">
      <div
        ref={frameRef}
        className="relative cursor-ew-resize touch-pan-y select-none overflow-hidden rounded-[20px] border border-hairline bg-void"
        style={{ aspectRatio: `${width} / ${height}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <img src={before} alt="" width={width} height={height} loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-contain" />
        <img
          src={after}
          alt=""
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 size-full object-contain"
          style={{ clipPath: `inset(0 0 0 ${pos}%)`, transition: `clip-path ${t}` }}
        />
        {/* divider + handle */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%`, transition: `left ${t}` }}>
          <div className="absolute inset-y-0 -left-px w-0.5 bg-white/85 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
          <div className="absolute top-1/2 -ml-[18px] -mt-[18px] grid size-9 place-items-center rounded-full border border-white/70 bg-[#0A0B10]/80 text-white backdrop-blur-md">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 4 2 8l4 4M10 4l4 4-4 4" />
            </svg>
          </div>
        </div>
        <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-[#0A0B10]/75 px-3 py-1 text-[13px] font-semibold text-white backdrop-blur-md">{beforeLabel}</span>
        <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-[#0A0B10]/75 px-3 py-1 text-[13px] font-semibold text-white backdrop-blur-md">{afterLabel}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(pos)}
          onChange={(e) => {
            setAnimate(true);
            setPos(Number(e.target.value));
          }}
          aria-label={`Compare ${beforeLabel} and ${afterLabel}: share of the map showing ${beforeLabel}`}
          aria-valuetext={`${Math.round(pos)}% ${beforeLabel}`}
          className="peer absolute inset-0 size-full cursor-ew-resize opacity-0"
          style={{ pointerEvents: "none" }}
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[20px] ring-2 ring-signal ring-offset-0 opacity-0 peer-focus-visible:opacity-100" />
      </div>
      <span className="sr-only">{alt}</span>
      {caption && <figcaption className="mt-3 text-[13px] leading-relaxed text-ink-faint">{caption}</figcaption>}
    </figure>
  );
}
