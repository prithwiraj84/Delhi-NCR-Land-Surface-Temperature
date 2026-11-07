/**
 * Dependence BRUSH → map mask (UI_SPEC §3.6 "BRUSH x-range → map mask (cells dim 25 %)").
 * Two range thumbs over the driver's robust value range (p2–p98 of the current frame's
 * cells); every cell whose value lies inside is kept, the docked map dims the others. The
 * mask is written to `selectionStore.brushMask` (Uint8Array in canonical cell order, so it
 * stays valid across years and modes), debounced, and cleared when the brush is turned off
 * or the Drivers route unmounts. Fully keyboard operable (native range inputs).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Paintbrush } from "lucide-react";
import { useSelectionStore } from "../../state/stores/selectionStore.js";
import { Button } from "../../components/ui/Button.jsx";
import { fmtFeatureValue, fmtPct } from "../../lib/format.js";
import { announce } from "../../shell/announcer.js";
import { brushMask, robustRange } from "./driversModel.js";

const DEBOUNCE_MS = 120;

/**
 * @param {{values: Float32Array|null, meta: object|null, feature: string|null, year: number|null}} props
 */
export function DependenceBrush({ values, meta, feature, year }) {
  const range = useMemo(() => robustRange(values), [values]);
  const [on, setOn] = useState(false);
  const [sel, setSel] = useState(null);
  const [count, setCount] = useState(0);
  const timer = useRef(null);
  const label = meta?.label ?? feature ?? "driver";

  // Reset the window when the driver or frame changes.
  useEffect(() => {
    setSel(range ? [range[0] + (range[1] - range[0]) * 0.6, range[1]] : null);
  }, [range, feature]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!on || !sel || !values) {
      useSelectionStore.getState().setBrushMask?.(null);
      setCount(0);
      return undefined;
    }
    timer.current = setTimeout(() => {
      const { mask, count: c } = brushMask(values, sel);
      useSelectionStore.getState().setBrushMask?.(mask);
      setCount(c);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [on, sel, values]);

  useEffect(() => () => useSelectionStore.getState().setBrushMask?.(null), []);

  if (!range || !values) {
    return <p className="text-[11px] text-ink-faint">Brushing needs the {label} values of an explained frame.</p>;
  }
  const step = (range[1] - range[0]) / 200;
  const [lo, hi] = sel ?? range;
  const fmtV = (v) => fmtFeatureValue(meta, v);
  const finite = values.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0);

  return (
    <div className="space-y-2 rounded-md border border-hairline bg-surface-3/30 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="micro-label">Brush {label} → map</span>
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant={on ? "primary" : "secondary"}
            aria-pressed={on}
            onClick={() => {
              setOn(!on);
              announce(on ? "Map brushing off" : `Map brushing on: ${label} between ${fmtV(lo)} and ${fmtV(hi)}`);
            }}
          >
            <Paintbrush aria-hidden="true" />
            {on ? "Brushing" : "Brush map"}
          </Button>
          {on && (
            <Button size="xs" variant="ghost" onClick={() => setOn(false)} aria-label="Clear the map brush">
              <Eraser aria-hidden="true" />
              Clear
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <label className="flex flex-col gap-0.5 text-[11px] text-ink-muted">
          From {fmtV(lo)}
          <input type="range" min={range[0]} max={range[1]} step={step} value={lo} disabled={!on} onChange={(e) => setSel([Math.min(Number(e.target.value), hi), hi])} className="accent-[var(--signal)]" />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-ink-muted">
          To {fmtV(hi)}
          <input type="range" min={range[0]} max={range[1]} step={step} value={hi} disabled={!on} onChange={(e) => setSel([lo, Math.max(Number(e.target.value), lo)])} className="accent-[var(--signal)]" />
        </label>
      </div>
      <p className="text-[11px] text-ink-faint" aria-live="polite">
        {on ? `${count.toLocaleString("en-US")} of ${finite.toLocaleString("en-US")} cells (${fmtPct(finite ? count / finite : 0, 0)}) in ${year ?? "this frame"} stay lit; the rest dim to 25 % on the map.` : "Turn on to highlight the cells in a value range on the docked map."}
      </p>
    </div>
  );
}

export default DependenceBrush;
