/**
 * Element size via ResizeObserver (charts render at their container's width; height is set
 * by the chart so the axis band is always inside the box — no nested scroll).
 */
import { useEffect, useState } from "react";

/**
 * @param {React.RefObject<HTMLElement>} ref
 * @param {{width?: number, height?: number}} [fallback] size before the first measurement
 *   (also used in jsdom/tests where layout is 0)
 * @returns {{width: number, height: number}}
 */
export function useSize(ref, fallback = { width: 640, height: 240 }) {
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setSize((prev) => (Math.abs(prev.width - r.width) > 0.5 || Math.abs(prev.height - r.height) > 0.5 ? { width: r.width, height: r.height } : prev));
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
