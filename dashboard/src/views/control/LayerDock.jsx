/**
 * Layer Dock (UI_SPEC_v2 §3.2 "LAYER DOCK 208", §8 `LayerDock`, §12):
 *
 *   ◉ LST  ○ Predicted  ○ Residual (OOF)  ○ SHAP ▸ <driver>  ○ Dominant driver  ○ Zones
 *   ○ What-if Δ  ○ Uncertainty  ○ AOA          VALUE  Absolute | Anomaly | SUHI | Δ
 *
 * One radio group with roving tabindex (one tab stop; arrows move AND select, skipping
 * unavailable items; Home/End). Items that are unavailable for the current frame stay visible
 * with their reason (title + aria-describedby). `L` focuses the dock (the shell looks for
 * `[data-focus-target="layer-dock"]`). Tablet: an icon column with tooltips.
 */
import { useId, useRef } from "react";
import { Activity, Boxes, Crosshair, Flame, FlaskConical, GitCompareArrows, Layers3, ShieldCheck, Sigma, Waves } from "lucide-react";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { domainFor, frameAt } from "../../data/timeline.js";
import { cn } from "../../lib/cn.js";
import { useData } from "../../state/DataContext.jsx";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { announce } from "../../shell/announcer.js";
import { LEVELS_NOT_HARMONISED } from "../timeline/timelineModel.js";
import { LAYER_ITEMS, layerAvailability } from "./layerModel.js";
import { useShapOptions, useTimelineData } from "./useControlData.js";

const ICONS = { lst: Flame, pred: Sigma, resid: Crosshair, shap: Layers3, driver: Activity, zones: Boxes, whatif: FlaskConical, unc: Waves, aoa: ShieldCheck };

/** @param {{compact?: boolean, className?: string}} props */
export function LayerDock({ compact = false, className }) {
  const listId = useId().replace(/:/g, "");
  const refs = useRef([]);
  const timeline = useTimelineData();
  const year = useTimeStore((s) => s.year);
  const mode = useTimeStore((s) => s.mode ?? "day");
  const compareOn = useTimeStore((s) => Boolean(s.compare?.kind));
  const layer = useViewStore((s) => s.layer);
  const shapFeature = useViewStore((s) => s.shapFeature);
  const variable = useViewStore((s) => s.variable);
  const data = useData() ?? {};
  const shapOptions = useShapOptions();
  const scenarioReady = Boolean(data.model);
  const levelsHarmonised = timeline?.harmonised === true;

  const items = LAYER_ITEMS.map((it) => ({ ...it, ...layerAvailability(it.id, { timeline, year, mode, scenarioReady }) }));
  const selectedIndex = Math.max(0, items.findIndex((i) => i.id === layer));

  const select = (it) => {
    if (!it.available) {
      announce(`${it.label} unavailable: ${it.reason}`);
      return;
    }
    useViewStore.getState().setLayer(it.id);
    if (it.id === "shap" && !useViewStore.getState().shapFeature && shapOptions[0]) useViewStore.getState().setShapFeature(shapOptions[0].id);
  };

  const onKeyDown = (e, index) => {
    const n = items.length;
    const move = (dir) => {
      for (let step = 1; step <= n; step += 1) {
        const j = (index + dir * step + n * n) % n;
        if (items[j].available) return j;
      }
      return index;
    };
    let next = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = move(1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = move(-1);
    else if (e.key === "Home") next = items.findIndex((i) => i.available);
    else if (e.key === "End") next = n - 1 - [...items].reverse().findIndex((i) => i.available);
    if (next === null || next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    refs.current[next]?.focus();
    select(items[next]);
  };

  const variables = [
    { value: "abs", label: compact ? "Abs" : "Absolute", title: "Absolute LST (°C), fixed scale across all frames" },
    { value: "anom", label: compact ? "Anom" : "Anomaly", title: "Difference from the frame's NCR mean", disabled: !domainFor(timeline, mode, "anom"), reason: "No anomaly domain in this bundle" },
    { value: "suhi", label: "SUHI", title: "Surface UHI: difference from the rural reference", disabled: !domainFor(timeline, mode, "suhi"), reason: "No surface-UHI domain in this bundle" },
    {
      value: "delta",
      label: "Δ",
      title: "Difference B − A of the compare pair",
      // A frame-to-frame level difference is only meaningful on harmonised levels.
      disabled: !compareOn || !levelsHarmonised,
      reason: !levelsHarmonised ? LEVELS_NOT_HARMONISED : "Turn on compare (C) to map B − A",
    },
  ];
  // The Predicted layer always shows absolute predicted LST (D22 b): the value applies to LST only.
  const variableEnabled = layer === "lst";
  const projectedNow = frameAt(timeline, year)?.kind === "projected";
  const suhiNote = variableEnabled && variable === "suhi" && projectedNow ? "Surface UHI is not exported for projected frames (no projected land-cover reference)." : null;

  return (
    <HudFrame as="nav" aria-label="Map layers" padding={compact ? "none" : "sm"} className={cn("pointer-events-auto", compact ? "w-12 py-1.5" : "w-[208px]", className)} data-focus-target="layer-dock" data-testid="layer-dock">
      {!compact && <h2 className="micro-label mb-1.5 px-1">Layers</h2>}
      <div role="radiogroup" aria-label="Map layer" className={cn("flex flex-col", compact ? "items-center gap-1" : "gap-0.5")}>
        {items.map((it, i) => {
          const Icon = ICONS[it.id] ?? Layers3;
          const selected = it.id === layer;
          const descId = !it.available ? `${listId}-${it.id}-why` : undefined;
          return (
            <div key={it.id} className="min-w-0">
              <button
                ref={(el) => (refs.current[i] = el)}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!it.available || undefined}
                aria-describedby={descId}
                aria-label={compact ? it.label : undefined}
                tabIndex={i === selectedIndex ? 0 : -1}
                title={it.available ? it.hint : it.reason}
                onClick={() => select(it)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={cn(
                  "focus-ring group flex w-full items-center rounded-md text-left text-[13px] transition-colors duration-instant",
                  compact ? "size-9 justify-center" : "h-7 gap-2 px-1.5",
                  selected ? "bg-surface-3 text-ink-strong" : "text-ink-muted hover:bg-surface-3/60 hover:text-ink",
                  !it.available && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                {compact ? (
                  <Icon aria-hidden="true" className={cn("size-4", selected && "text-signal")} strokeWidth={1.5} />
                ) : (
                  <>
                    <span aria-hidden="true" className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border", selected ? "border-signal" : "border-control")}>
                      {selected && <span className="size-1.5 rounded-full bg-signal" />}
                    </span>
                    <span className="truncate">{it.label}</span>
                  </>
                )}
              </button>
              {descId && (
                <span id={descId} className="sr-only">
                  {it.reason}
                </span>
              )}
              {!compact && it.id === "shap" && layer === "shap" && (
                <div className="ml-6 mt-0.5 pr-1">
                  <label htmlFor={`${listId}-shap`} className="sr-only">
                    SHAP driver
                  </label>
                  <select
                    id={`${listId}-shap`}
                    value={shapFeature ?? shapOptions[0]?.id ?? ""}
                    onChange={(e) => useViewStore.getState().setShapFeature(e.target.value)}
                    className="focus-ring h-7 w-full cursor-pointer rounded-md border border-control bg-surface-3 px-1.5 text-[12px] text-ink"
                  >
                    {shapOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!compact && (
        <div className={cn("mt-2 border-t border-hairline pt-2", !variableEnabled && "opacity-50")}>
          <p className="micro-label mb-1 flex items-center gap-1 px-1">
            <GitCompareArrows aria-hidden="true" className="size-3" strokeWidth={1.5} /> Value
          </p>
          <Segmented
            ariaLabel="Value shown by the LST layer"
            layoutId={`${listId}-variable`}
            value={variable}
            size="sm"
            options={variables.map((v) => ({ ...v, disabled: v.disabled || !variableEnabled, reason: !variableEnabled ? "Applies to the LST layer (Predicted is always absolute °C)" : v.reason }))}
            onChange={(v) => {
              useViewStore.getState().setVariable(v);
              announce(`Value: ${variables.find((x) => x.value === v)?.title ?? v}`);
            }}
            className="w-full justify-between"
          />
          {suhiNote && (
            <p role="status" className="mt-1 px-1 text-[11px] leading-snug text-ink-faint">
              {suhiNote}
            </p>
          )}
        </div>
      )}
    </HudFrame>
  );
}

export default LayerDock;
