/**
 * Cell inspection overlays (v1 API, restyled for NCR THERMAL/OPS v2 — glass + HUD brackets,
 * ink tokens, micro labels ≥ 11 px, no glow outside the glow budget):
 *   - <CellTooltip>     glass card that follows the pointer (clamped to the map viewport):
 *                       district, zone, observed / predicted / residual LST and a compact
 *                       SHAP waterfall (top 6 drivers + "other").
 *   - <HexTooltip>      readout for an aggregated H3 hexagon.
 *   - <CellDetailPanel> docked side panel for a pinned cell with the FULL waterfall.
 *
 * All values are read by index from the columnar epoch (typed arrays), never mapped
 * into per-cell objects. The v2 Control view uses views/control/inspector/* for the
 * inspector panel; these components keep serving the v1 map (MapContainer) unchanged.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { MapPin, Pin, X } from "lucide-react";
import { fmt, fmtC, fmtDeltaC, fmtInt, fmtPct, fmtSigned, featureLabel } from "../../lib/format.js";
import { rgbToCss } from "../../lib/colors.js";
import { cn } from "../../lib/cn.js";
import { CellWaterfall, WaterfallSumCheck } from "./CellWaterfall.jsx";
import { cellWaterfall, NO_DRIVER } from "./mapMetrics.js";

const TOOLTIP_OFFSET = 16;
const VIEWPORT_MARGIN = 8;
const GLASS = "glass hud rounded-panel text-ink";

/**
 * Position an overlay next to the pointer, flipping to the other side of the pointer
 * when it would overflow the container, and clamping into the container otherwise.
 */
function useClampedPosition(ref, x, y, bounds) {
  const [pos, setPos] = useState({ left: x + TOOLTIP_OFFSET, top: y + TOOLTIP_OFFSET });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = x + TOOLTIP_OFFSET;
    let top = y + TOOLTIP_OFFSET;
    if (left + w > bounds.width - VIEWPORT_MARGIN) left = x - TOOLTIP_OFFSET - w;
    if (top + h > bounds.height - VIEWPORT_MARGIN) top = y - TOOLTIP_OFFSET - h;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, bounds.width - w - VIEWPORT_MARGIN));
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, bounds.height - h - VIEWPORT_MARGIN));
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [ref, x, y, bounds.width, bounds.height]);
  return pos;
}

/** Small coloured zone chip (text in ink; the swatch carries the zone colour). */
export function ZoneChip({ zone }) {
  if (!zone) return <span className="text-[11px] text-ink-faint">no zone</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-2/80 px-2 py-0.5 text-[11px] text-ink">
      <span className="size-2 rounded-sm" style={{ background: rgbToCss(zone.rgba.slice(0, 3)) }} aria-hidden="true" />
      {Number.isInteger(zone.id) && <span className="tnum font-mono text-ink-faint">{zone.id}</span>}
      {zone.label}
    </span>
  );
}

/** Value-first readout row (value strong, label secondary). */
function Readout({ label, value, emphasis = false, numeric = true }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label truncate">{label}</dt>
      <dd
        className={cn(
          "truncate",
          numeric ? "font-mono tabular-nums" : "font-sans font-medium",
          emphasis ? "text-[15px] text-ink-strong" : "text-[13px] text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** Value of the active layer for one cell, formatted for the readout. */
function activeLayerReadout(metric, index, featureNames, manifest) {
  if (!metric?.values || !metric.available) return null;
  const v = metric.values[index];
  switch (metric.layer) {
    case "shap":
      return { label: metric.title, value: fmtDeltaC(v, 2) };
    case "scenario":
      return { label: "Scenario Δ", value: Number.isFinite(v) ? fmtDeltaC(v, 2) : "outside region" };
    case "driver":
      return {
        label: "Dominant driver",
        value: v === NO_DRIVER ? "—" : featureLabel(manifest, featureNames[v]),
      };
    default:
      return null;
  }
}

/** Header + readouts shared by the tooltip and the docked panel. */
function CellFacts({ epoch, index, district, zone, activeReadout }) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-display text-sm font-semibold text-ink-strong">{district?.name ?? "Unknown district"}</p>
          <p className="font-mono text-[11px] text-ink-faint">
            cell {epoch.cell_id?.[index] ?? index} · {fmt(epoch.lat[index], 3)}°N {fmt(epoch.lon[index], 3)}°E
          </p>
        </div>
        <ZoneChip zone={zone} />
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <Readout label="Observed" value={fmtC(epoch.lst_obs?.[index], 2)} emphasis />
        <Readout label="Predicted" value={fmtC(epoch.lst_pred?.[index], 2)} />
        <Readout label="OOF resid." value={fmtDeltaC(epoch.resid_oof?.[index], 2)} />
      </dl>
      {activeReadout ? (
        <p className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-hairline pt-1.5 text-[11px]">
          <span className="truncate text-ink-muted">{activeReadout.label}</span>
          <span className="font-mono text-ink">{activeReadout.value}</span>
        </p>
      ) : null}
    </>
  );
}

/** Shared lookup of district / zone meta for a cell index. */
function useCellContext({ epoch, index, districtsById, zoneById }) {
  return useMemo(() => {
    const d = epoch.district?.[index];
    const z = epoch.zone?.[index];
    return { district: districtsById.get(d) ?? null, zone: z >= 0 ? zoneById.get(z) ?? null : null };
  }, [epoch, index, districtsById, zoneById]);
}

/**
 * Pointer-following cell tooltip.
 * @param {{epoch, index, x, y, bounds: {width, height}, manifest, featureNames, metric,
 *          districtsById: Map, zoneById: Map}} props
 */
export function CellTooltip({ epoch, index, x, y, bounds, manifest, featureNames, metric, districtsById, zoneById }) {
  const ref = useRef(null);
  const pos = useClampedPosition(ref, x, y, bounds);
  const { district, zone } = useCellContext({ epoch, index, districtsById, zoneById });
  const waterfall = useMemo(() => cellWaterfall(epoch, index, featureNames), [epoch, index, featureNames]);
  const activeReadout = activeLayerReadout(metric, index, featureNames, manifest);

  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn(GLASS, "pointer-events-none absolute z-30 w-[22rem] p-3")}
      style={{ left: pos.left, top: pos.top }}
    >
      <CellFacts epoch={epoch} index={index} district={district} zone={zone} activeReadout={activeReadout} />
      <div className="mt-2 border-t border-hairline pt-2">
        <p className="micro-label mb-1">SHAP waterfall · °C</p>
        <CellWaterfall waterfall={waterfall} manifest={manifest} topN={6} />
        <WaterfallSumCheck waterfall={waterfall} />
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-muted">
        <Pin className="h-3 w-3" aria-hidden="true" /> Click to pin and see all {featureNames.length} features
      </p>
    </div>
  );
}

/** Tooltip for an aggregated H3 hexagon. */
export function HexTooltip({ hex, x, y, bounds, metric, resolution }) {
  const ref = useRef(null);
  const pos = useClampedPosition(ref, x, y, bounds);
  const categorical = metric.kind === "categorical";
  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn(GLASS, "pointer-events-none absolute z-30 w-60 p-3")}
      style={{ left: pos.left, top: pos.top }}
    >
      <p className="font-display text-sm font-semibold text-ink-strong">H3 hexagon · res {resolution}</p>
      <p className="truncate font-mono text-[11px] text-ink-faint">{hex.hex}</p>
      <dl className="mt-2 grid grid-cols-2 gap-2">
        {categorical ? (
          <>
            <Readout label="Most common" value={hex.label ?? "—"} emphasis numeric={false} />
            <Readout label="Share of hex" value={fmtPct(hex.share)} />
          </>
        ) : (
          <Readout
            label={`Mean ${metric.title}`}
            value={metric.kind === "diverging" ? fmtDeltaC(hex.value, 2) : fmtC(hex.value, 2)}
            emphasis
          />
        )}
        <Readout label="Cells" value={fmtInt(hex.count)} />
      </dl>
    </div>
  );
}

/**
 * Docked panel for the pinned cell: facts + full waterfall (every feature).
 * Escape closes it. `className` is merged last (e.g. a full-width panel on phones).
 */
export function CellDetailPanel({ epoch, index, manifest, featureNames, metric, districtsById, zoneById, onClose, className }) {
  const { district, zone } = useCellContext({ epoch, index, districtsById, zoneById });
  const waterfall = useMemo(() => cellWaterfall(epoch, index, featureNames), [epoch, index, featureNames]);
  const activeReadout = activeLayerReadout(metric, index, featureNames, manifest);
  const closeRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [index]);

  const cooling = waterfall.contributions.filter((c) => c.shap < 0).reduce((s, c) => s + c.shap, 0);
  const warming = waterfall.contributions.filter((c) => c.shap > 0).reduce((s, c) => s + c.shap, 0);

  return (
    <motion.aside
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      className={cn(GLASS, "pointer-events-auto flex max-h-full w-[25rem] flex-col overflow-hidden", className)}
      aria-label="Pinned cell details"
    >
      <header className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <span className="micro-label flex items-center gap-1.5 text-ink-muted">
          <MapPin className="h-3.5 w-3.5" aria-hidden="true" /> Pinned cell · {epoch.year}
        </span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="focus-ring rounded-md p-1 text-ink-muted transition-colors duration-instant hover:bg-surface-3 hover:text-ink-strong"
          aria-label="Close pinned cell panel"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        <CellFacts epoch={epoch} index={index} district={district} zone={zone} activeReadout={activeReadout} />
        <dl className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-surface-2/70 p-2">
          <Readout label="Base E[f(x)]" value={fmtC(waterfall.base, 2)} />
          <Readout label="Σ cooling" value={fmtSigned(cooling, 2)} />
          <Readout label="Σ warming" value={fmtSigned(warming, 2)} />
        </dl>
        <p className="micro-label mb-1 mt-3">
          Full SHAP waterfall · all {featureNames.length} features · °C
        </p>
        <CellWaterfall waterfall={waterfall} manifest={manifest} topN={null} animated />
        <WaterfallSumCheck waterfall={waterfall} />
        <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
          TreeSHAP splits the model&apos;s prediction for this grid cell into additive per-feature
          contributions around the base value. Azure bars cool the cell, rose bars warm it; each row also
          prints its signed value.
        </p>
      </div>
    </motion.aside>
  );
}
