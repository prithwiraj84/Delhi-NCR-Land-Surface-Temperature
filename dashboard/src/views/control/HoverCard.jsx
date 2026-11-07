/**
 * Hover card (UI_SPEC_v2 §3.2, §3.10, principle 4): a small glass readout that follows the
 * pointer over the map for the hovered 1 km cell (`selectionStore.hoverIndex`, set by the
 * engine's ≤ 30 Hz picking).
 *
 *   Gurugram · cell #48211
 *   p95 48.3 °C ○ Projected · Day 2050       (the value AS DISPLAYED, labelled by quantity)
 *   ≈38.6 °C · 2025 ↔ 2030 (interpolated)    (between frames: never presented as data)
 *   250 m 40.1 °C                            (raster / lens on: the 250 m pixel under the pointer)
 *   left 1990 · Day 38.0 °C · B − A +2.3 °C  (compare on: the side under the pointer and B − A)
 *
 * The number is read from the map engine (`MapEngine.readCell` / `readRaster`), so the card
 * always shows exactly what is drawn — layer, variable, quantile, interpolation mix, held frame,
 * VSUP and AOA — and refreshes when the engine content or legend changes. The quantity label
 * ("p95", "anomaly", "spread", "Δ vs 1990", "what-if Δ") says what the number is.
 *
 * Hidden while scrubbing or playing (picking is off then) and when the pointer leaves the
 * stage. It is `aria-hidden`: the same facts are reachable by keyboard through the inspector
 * (H / district select + arrow-key cell walking) and DescribeMap.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { TierShape } from "../../design/glyphs.jsx";
import { normalizeTier, TIER_META } from "../../design/tiers.js";
import { useCells } from "../../data/hooks.js";
import { frameTierInfo } from "../../data/timeline.js";
import { engineStore } from "../../engine/engineStore.js";
import { getMapEngine } from "../../engine/MapEngine.js";
import { fmt, fmtSigned } from "../../lib/format.js";
import { useSelectionStore } from "../../state/stores/selectionStore.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { hoverQuantity } from "./controlModel.js";
import { useDistrictMeta, useLiveFrame, useShapOptions } from "./useControlData.js";

const OFFSET = 16;
const MARGIN = 8;
const MODE_WORD = { day: "Day", night: "Night", dtr: "DTR" };

/** Pointer position relative to `container` while it is over the map stage. */
function useStagePointer(containerRef) {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    let frame = 0;
    let last = null;
    const onMove = (e) => {
      const over = e.target?.closest?.("[data-stage]");
      last = over ? { x: e.clientX, y: e.clientY } : null;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = containerRef.current?.getBoundingClientRect();
        setPos(last && rect ? { x: last.x - rect.left, y: last.y - rect.top, w: rect.width, h: rect.height } : null);
      });
    };
    const onLeave = () => setPos(null);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef]);
  return pos;
}

/** "p95 48.3 °C" / "anomaly +2.3 °C" / "Zone 3 · Heat Extreme Core" of an engine readout. */
function valueText(r, q, { approx = false } = {}) {
  if (!r) return null;
  if (r.kind === "categorical") return r.category?.label ?? "no data";
  if (!Number.isFinite(r.value)) return "—";
  const num = q.signed ? fmtSigned(r.value, q.signed && Math.abs(r.value) < 1 ? 2 : 1) : fmt(r.value, 1);
  return `${q.prefix ? `${q.prefix} ` : ""}${approx ? "≈" : ""}${num} ${r.unit ?? "°C"}`;
}

/** @param {{containerRef: React.RefObject<HTMLElement>}} props */
export function HoverCard({ containerRef }) {
  const ref = useRef(null);
  const pos = useStagePointer(containerRef);
  const index = useSelectionStore((s) => s.hoverIndex);
  const live = useLiveFrame({ withStats: false });
  const { mode, ssp, timeline } = live;
  const year = useTimeStore((s) => s.year);
  // Re-read the engine when what it draws changes (content, legend, raster, compare, status).
  const legend = useStore(engineStore, (s) => s.legend);
  const raster = useStore(engineStore, (s) => s.raster);
  const lens = useStore(engineStore, (s) => s.lens);
  const compare = useStore(engineStore, (s) => s.compare);
  const hover = useStore(engineStore, (s) => s.hover);
  useStore(engineStore, (s) => s.status);
  const cells = useCells();
  const districts = useDistrictMeta();
  const shapOptions = useShapOptions();
  const active = Number.isInteger(index) && pos && !live.moving;
  const [place, setPlace] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let left = pos.x + OFFSET;
    let top = pos.y + OFFSET;
    if (left + w > pos.w - MARGIN) left = pos.x - OFFSET - w;
    if (top + h > pos.h - MARGIN) top = pos.y - OFFSET - h;
    left = Math.max(MARGIN, Math.min(left, pos.w - w - MARGIN));
    top = Math.max(MARGIN, Math.min(top, pos.h - h - MARGIN));
    setPlace((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [active, pos]);

  if (!active || !timeline) return null;
  const engine = getMapEngine();
  const c = cells.status === "ready" ? cells.data : null;
  const district = c ? districts.get(Number(c.district[index])) : null;
  const cellId = c ? c.cell_id[index] : index;
  const featureLabel = legend?.layer === "shap" ? shapOptions.find((o) => o.id === engine?.current?.desc?.shapFeature)?.label ?? null : null;
  const opts = { featureLabel, firstYear: timeline.first };

  // Compare: the side under the pointer and B − A, as drawn.
  const cmp = compare?.on ? engine?.readCompare?.(index, hover?.x ?? null) ?? null : null;
  // Raster / lens: the 250 m pixel under the pointer (the value the raster draws).
  const fine = !cmp && (raster?.visible || (lens?.on && lens?.available)) && Number.isFinite(hover?.lon) ? engine?.readRaster?.(hover.lon, hover.lat) ?? null : null;
  const r = cmp ? (cmp.under === "right" ? cmp.right : cmp.left) : engine?.readCell?.(index) ?? null;
  const q = hoverQuantity(r, opts);
  const interpolated = Boolean(r?.interpolated);
  const yearOf = r?.kind === "categorical" ? r.year : r && !interpolated ? (r.mix >= 0.5 ? r.yB : r.yA) : null;
  const info = frameTierInfo(timeline, interpolated ? live.t : yearOf ?? year, r?.mode ?? mode, r?.ssp ?? ssp);
  const tierId = normalizeTier(r?.tier ?? info?.tier);
  const sideLabel = cmp ? cmp.labels?.[cmp.under === "right" ? 1 : 0] ?? (cmp.under === "right" ? "B" : "A") : null;
  const fineQ = fine ? hoverQuantity({ layer: "lst", variable: fine.variable, q: "p50", mode: r?.mode ?? mode }, opts) : null;

  return (
    <div ref={ref} aria-hidden="true" className="glass-strong pointer-events-none absolute z-overlay w-64 rounded-md px-2.5 py-2" style={{ left: place.left, top: place.top }} data-testid="hover-card">
      <p className="truncate text-[13px] font-medium text-ink-strong">
        {district?.name ?? "Cell"} <span className="font-mono text-[11px] text-ink-faint">#{cellId}</span>
      </p>
      {sideLabel && <p className="font-mono text-[11px] text-ink-muted">{`${cmp.under === "right" ? "right" : "left"} · ${sideLabel}`}</p>}
      <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
        <span className={interpolated ? "tnum font-mono text-[15px] font-semibold italic text-ink" : "tnum font-mono text-[15px] font-semibold text-ink-strong"} data-testid="hover-value">
          {r ? valueText(r, q, { approx: interpolated }) : "—"}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
          {!interpolated && tierId && <TierShape tier={tierId} size={9} />}
          {interpolated
            ? `${r.yA} ↔ ${r.yB} (interpolated)`
            : `${tierId ? TIER_META[tierId].label : "no data"} · ${MODE_WORD[r?.mode ?? mode] ?? "Day"} ${yearOf ?? year}${r?.held ? " (held)" : ""}`}
        </span>
      </p>
      {r?.outsideAoa && <p className="mt-0.5 text-[11px] text-warn">outside the area of applicability</p>}
      {fine && Number.isFinite(fine.value) && (
        <p className="tnum mt-0.5 font-mono text-[12px] text-ink" data-testid="hover-raster">
          250 m {fineQ?.prefix ? `${fineQ.prefix} ` : ""}
          {fine.interpolated ? "≈" : ""}
          {fineQ?.signed ? fmtSigned(fine.value, 1) : fmt(fine.value, 1)} °C
          <span className="text-ink-muted">{fine.downscaled ? " · downscaled" : " · observed"}</span>
        </p>
      )}
      {cmp && Number.isFinite(cmp.diff) && (
        <p className="tnum mt-0.5 font-mono text-[12px] text-ink">
          {fmtSigned(cmp.diff, 1)} °C here <span className="text-ink-muted">(B − A)</span>
        </p>
      )}
      <p className="mt-1 text-[11px] text-ink-faint">click to pin · H for the hottest cell</p>
    </div>
  );
}

export default HoverCard;
