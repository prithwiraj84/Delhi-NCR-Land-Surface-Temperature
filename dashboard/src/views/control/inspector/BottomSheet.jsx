/**
 * Mobile bottom sheet (UI_SPEC_v2 §3.13): the inspector on phones, with three snap heights —
 * peek 96 px · half 50 vh · full. Drag the handle (1:1, then a spring-soft snap to the nearest
 * height; a jump under Reduced/Off motion), or use the keyboard on the handle: Enter/Space
 * cycles, ↑/↓ step. The handle is a 44 px target. Non-modal: the map stays usable above it.
 */
import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { springs } from "../../../design/motion.js";
import { useMotionLevel } from "../../../design/useMotionLevel.js";
import { cn } from "../../../lib/cn.js";

export const SHEET_PEEK = 96;
const SNAPS = ["peek", "half", "full"];

function snapHeight(snap, vh) {
  if (snap === "full") return Math.max(SHEET_PEEK, vh - 120);
  if (snap === "half") return Math.max(SHEET_PEEK, Math.round(vh * 0.5));
  return SHEET_PEEK;
}

/** @param {{title: React.ReactNode, children: React.ReactNode, className?: string, label?: string}} props */
export function BottomSheet({ title, children, className, label = "Inspector" }) {
  const level = useMotionLevel();
  const [snap, setSnap] = useState("peek");
  const [dragH, setDragH] = useState(null);
  const drag = useRef(null);
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const height = dragH ?? snapHeight(snap, vh);

  const settle = (h) => {
    const best = SNAPS.reduce((b, s) => (Math.abs(snapHeight(s, vh) - h) < Math.abs(snapHeight(b, vh) - h) ? s : b), "peek");
    setSnap(best);
    setDragH(null);
  };
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, h: height, moved: false };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dy = drag.current.y - e.clientY;
    if (Math.abs(dy) > 4) drag.current.moved = true;
    setDragH(Math.min(snapHeight("full", vh), Math.max(SHEET_PEEK, drag.current.h + dy)));
  };
  const suppressClick = useRef(false);
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      setDragH(null); // a tap: the click handler cycles the height
      return;
    }
    suppressClick.current = true; // a drag ends with a click event: do not also cycle
    settle(dragH ?? d.h);
  };
  /** Click / Enter / Space on the handle cycles peek → half → full. */
  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setSnap((s) => SNAPS[(SNAPS.indexOf(s) + 1) % SNAPS.length]);
  };
  const onKeyDown = (e) => {
    const i = SNAPS.indexOf(snap);
    if (e.key === "ArrowUp") setSnap(SNAPS[Math.min(2, i + 1)]);
    else if (e.key === "ArrowDown") setSnap(SNAPS[Math.max(0, i - 1)]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <motion.section
      aria-label={label}
      className={cn("glass-strong pointer-events-auto absolute inset-x-0 bottom-0 z-overlay flex flex-col overflow-hidden rounded-t-panel border-t border-hairline", className)}
      animate={{ height }}
      initial={false}
      transition={dragH !== null || level !== "full" ? { duration: 0 } : springs.soft}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      data-snap={snap}
      data-testid="bottom-sheet"
    >
      <button
        type="button"
        aria-label={`${label}: ${snap === "peek" ? "peek" : snap === "half" ? "half height" : "full height"}. Activate to resize; arrow keys up and down.`}
        aria-expanded={snap !== "peek"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className="focus-ring flex h-11 w-full shrink-0 touch-none flex-col items-center justify-center gap-1"
      >
        <span aria-hidden="true" className="h-1 w-10 rounded-full bg-ink-faint" />
      </button>
      <div className="px-4 pb-1">{title}</div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
    </motion.section>
  );
}

export default BottomSheet;
