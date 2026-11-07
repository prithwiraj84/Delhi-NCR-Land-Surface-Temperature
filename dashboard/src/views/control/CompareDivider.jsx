/**
 * Compare divider (UI_SPEC_v2 §3.10, §5.2 G, §6.2 split): a DOM element with
 * `role="separator"` over the persistent map. The engine draws compare side A left of the
 * divider and side B right of it (ScreenSplitExtension: screen-space discard on two layer
 * instances, so it works at any pitch and bearing).
 *
 * Contract with the engine (E3): `timeStore.compare.splitPx` = divider position in CSS pixels
 * from the LEFT edge of the stage (null = centre). Multiply by devicePixelRatio for
 * gl_FragCoord comparisons.
 *
 * Keyboard: ←/→ move 2 % (Shift: 10 %), Home/End 5 % / 95 %. Pointer drag is 1:1. The divider
 * enters from the right (base timing) and only in Full motion.
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { GripVertical } from "lucide-react";
import { transition } from "../../design/motion.js";
import { useMotionLevel } from "../../design/useMotionLevel.js";
import { useTimeStore } from "../../state/stores/timeStore.js";

const clampPct = (p) => Math.min(0.98, Math.max(0.02, p));

/** @param {{labelA?: string, labelB?: string}} props */
export function CompareDivider({ labelA = "A", labelB = "B" }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  const splitPx = useTimeStore((s) => s.compare?.splitPx ?? null);
  const level = useMotionLevel();
  const drag = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const x = splitPx ?? width / 2;
  const pct = width > 0 ? x / width : 0.5;
  const setPct = (p) => {
    if (width <= 0) return;
    useTimeStore.getState().setCompare({ splitPx: Math.round(clampPct(p) * width) });
  };

  const onKeyDown = (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let next = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = pct - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = pct + step;
    else if (e.key === "Home") next = 0.05;
    else if (e.key === "End") next = 0.95;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPct(next);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { left: wrapRef.current?.getBoundingClientRect().left ?? 0 };
  };
  const onPointerMove = (e) => {
    if (!drag.current || width <= 0) return;
    setPct((e.clientX - drag.current.left) / width);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0" data-testid="compare-divider">
      <motion.div
        initial={level === "full" ? { x: 80, opacity: 0 } : false}
        animate={{ x: 0, opacity: 1 }}
        transition={transition("base")}
        className="absolute inset-y-0"
        style={{ left: x }}
      >
        <div aria-hidden="true" className="absolute inset-y-0 -left-px w-0.5 bg-reticle shadow-[0_0_0_2px_var(--void)]" />
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={`Compare divider: ${labelA} on the left, ${labelB} on the right`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct * 100)}
          aria-valuetext={`${Math.round(pct * 100)} % of the map shows ${labelA}`}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="focus-ring pointer-events-auto absolute top-1/2 grid h-12 w-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none place-items-center rounded-md border border-hairline-strong bg-surface-2 text-ink"
        >
          <GripVertical aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </div>
      </motion.div>
    </div>
  );
}

export default CompareDivider;
