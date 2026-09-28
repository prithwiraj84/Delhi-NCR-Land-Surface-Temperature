/**
 * Small, dependency-light chart toolkit shared by the Model Performance and Governance
 * Zoning views (both are owned together; the zoning view imports from here).
 *
 * The charts in these views are hand-built SVG on top of d3-scale rather than Recharts so
 * that every mark follows the dataviz mark spec exactly: <= 24 px bars with a 4 px rounded
 * data-end that stays square at the (possibly negative) baseline, 2 px surface gaps,
 * ringed markers, hairline solid grids, and nearest-point hover for dense scatters.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { THEME } from "../../lib/colors.js";

/**
 * useLayoutEffect on the client (measure before paint, no flash of the fallback width),
 * useEffect during server rendering / tests where layout effects only emit warnings.
 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Visual tokens for SVG chart chrome (grid, axes, labels, surface ring). */
export const CHART = Object.freeze({
  grid: "rgba(148, 163, 184, 0.12)",
  baseline: THEME.axis,
  axisText: THEME.inkMuted,
  faintText: THEME.inkFaint,
  strongText: THEME.inkStrong,
  surface: "#111a2a",
  whisker: "#cbd5e1",
  deemphasis: THEME.inkFaint,
  fontMono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSans: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  maxBar: 24,
  radius: 4,
  hitRadius: 24,
});

/**
 * Track the rendered width of an element with a ResizeObserver so SVG charts can lay out
 * in real pixels (keeps markers round and text unscaled, unlike a stretched viewBox).
 * @param {React.RefObject<HTMLElement>} ref element that is always mounted
 * @param {number} fallback width used before the first measurement (SSR / tests)
 */
export function useElementWidth(ref, fallback = 640) {
  const [width, setWidth] = useState(fallback);
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (Number.isFinite(w) && w > 0) setWidth(Math.floor(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * SVG path for a vertical bar anchored at `yBase` and ending at `yValue` (pixels). The
 * data-end gets `r` px rounded corners, the baseline end stays square - for negative
 * values the rounding moves to the bottom so the bar still "grows" from zero.
 */
export function verticalBarPath(x, width, yBase, yValue, r = CHART.radius) {
  const h = Math.abs(yBase - yValue);
  if (h < 0.5 || width <= 0) return "";
  const rr = Math.min(r, width / 2, h);
  const right = x + width;
  if (yValue <= yBase) {
    return [
      `M${x},${yBase}`,
      `L${x},${yValue + rr}`,
      `Q${x},${yValue} ${x + rr},${yValue}`,
      `L${right - rr},${yValue}`,
      `Q${right},${yValue} ${right},${yValue + rr}`,
      `L${right},${yBase}`,
      "Z",
    ].join(" ");
  }
  return [
    `M${x},${yBase}`,
    `L${x},${yValue - rr}`,
    `Q${x},${yValue} ${x + rr},${yValue}`,
    `L${right - rr},${yValue}`,
    `Q${right},${yValue} ${right},${yValue - rr}`,
    `L${right},${yBase}`,
    "Z",
  ].join(" ");
}

/**
 * SVG path for a horizontal bar anchored at `xBase` and ending at `xValue`; rounded at the
 * data-end only (left end for negative values).
 */
export function horizontalBarPath(y, height, xBase, xValue, r = CHART.radius) {
  const w = Math.abs(xValue - xBase);
  if (w < 0.5 || height <= 0) return "";
  const rr = Math.min(r, height / 2, w);
  const bottom = y + height;
  if (xValue >= xBase) {
    return [
      `M${xBase},${y}`,
      `L${xValue - rr},${y}`,
      `Q${xValue},${y} ${xValue},${y + rr}`,
      `L${xValue},${bottom - rr}`,
      `Q${xValue},${bottom} ${xValue - rr},${bottom}`,
      `L${xBase},${bottom}`,
      "Z",
    ].join(" ");
  }
  return [
    `M${xBase},${y}`,
    `L${xValue + rr},${y}`,
    `Q${xValue},${y} ${xValue},${y + rr}`,
    `L${xValue},${bottom - rr}`,
    `Q${xValue},${bottom} ${xValue + rr},${bottom}`,
    `L${xBase},${bottom}`,
    "Z",
  ].join(" ");
}

/** Index of the point nearest to (px, py) within `maxDist` pixels, else -1 (linear scan). */
export function nearestPointIndex(points, px, py, maxDist = CHART.hitRadius) {
  let best = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i].px - px;
    const dy = points[i].py - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/** Pointer position relative to an element's top-left corner. */
export function localPointer(event, element) {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * Grouped-band layout: one band per category (model) split into equal slots per series
 * (scheme). Bars are capped at CHART.maxBar px and keep a 2 px surface gap between slots.
 * @returns {{outer: import("d3-scale").ScaleBand<string>, slotWidth: number, barWidth: number,
 *            center: (category: string, seriesIndex: number) => number}}
 */
export function groupedBandLayout(categories, seriesCount, innerWidth) {
  const outer = scaleBand().domain(categories).range([0, Math.max(1, innerWidth)]).paddingInner(0.24).paddingOuter(0.12);
  const slots = Math.max(1, seriesCount);
  const slotWidth = outer.bandwidth() / slots;
  const barWidth = Math.max(2, Math.min(CHART.maxBar, slotWidth - 2));
  const center = (category, seriesIndex) => (outer(category) ?? 0) + slotWidth * (seriesIndex + 0.5);
  return { outer, slotWidth, barWidth, center };
}

/** Linear y scale over [lo, hi] extended to include 0 and "niced" for clean ticks. */
export function zeroBasedLinear(values, range) {
  const finite = values.filter((v) => Number.isFinite(v));
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  return scaleLinear()
    .domain(lo === hi ? [lo, lo + 1] : [lo, hi])
    .nice(5)
    .range(range);
}

/** Precision-aware tick formatter for a linear scale (typographic minus sign). */
export function tickFormatter(scale, count = 5) {
  const format = scale.tickFormat(count);
  return (v) => format(v).replace("-", "−");
}
