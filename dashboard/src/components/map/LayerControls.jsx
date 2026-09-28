/**
 * Floating glass control panel (top-left of the twin).
 *
 * Sections: layer switcher (radio group with icons; arrow keys move the selection),
 * SHAP feature picker (SHAP layer only), render settings (extrusion, opacity, H3
 * aggregation + resolution, boundaries, labels) and camera actions (reset, 2-D/3-D,
 * fly to district). Every control is keyboard reachable with a visible focus ring.
 */
import { useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Box,
  BrainCircuit,
  ChevronDown,
  Crown,
  Diff,
  FlaskConical,
  Hexagon,
  RotateCcw,
  Shapes,
  Sigma,
  Square,
  Thermometer,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { fmt } from "../../lib/format.js";
import { Select } from "../ui/Select.jsx";
import { Slider } from "../ui/Slider.jsx";
import { Switch } from "../ui/Switch.jsx";
import { LAYER_DEFS, PICK_MODES } from "./mapMetrics.js";
import { H3_RESOLUTIONS } from "./useH3Aggregation.js";

const LAYER_ICONS = {
  lst_obs: Thermometer,
  lst_pred: BrainCircuit,
  resid_oof: Diff,
  shap: Sigma,
  driver: Crown,
  zones: Shapes,
  scenario: FlaskConical,
};

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan focus-visible:ring-offset-1 focus-visible:ring-offset-bg";

function SectionLabel({ children }) {
  return <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-faint">{children}</p>;
}

/** Radio group of map layers with roving focus (Up/Down/Left/Right, Home/End). */
function LayerSwitcher({ layer, onLayerChange }) {
  const refs = useRef([]);
  const activeIndex = Math.max(
    LAYER_DEFS.findIndex((d) => d.id === layer),
    0,
  );

  const onKeyDown = (event) => {
    const last = LAYER_DEFS.length - 1;
    const moves = {
      ArrowDown: activeIndex === last ? 0 : activeIndex + 1,
      ArrowRight: activeIndex === last ? 0 : activeIndex + 1,
      ArrowUp: activeIndex === 0 ? last : activeIndex - 1,
      ArrowLeft: activeIndex === 0 ? last : activeIndex - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onLayerChange(LAYER_DEFS[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label="Map layer" className="grid grid-cols-1 gap-1" onKeyDown={onKeyDown}>
      {LAYER_DEFS.map((def, i) => {
        const Icon = LAYER_ICONS[def.id];
        const active = i === activeIndex;
        return (
          <button
            key={def.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={def.hint}
            onClick={() => onLayerChange(def.id)}
            className={cn(
              "group relative flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition",
              active ? "text-ink-strong" : "text-ink-muted hover:bg-white/5 hover:text-ink",
              FOCUS,
            )}
          >
            {active ? (
              <motion.span
                layoutId="twin-layer-active"
                className="absolute inset-0 rounded-lg border border-cyan/40 bg-cyan/10 shadow-glow-cyan"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                aria-hidden="true"
              />
            ) : null}
            <Icon className={cn("relative h-3.5 w-3.5 shrink-0", active ? "text-cyan" : "text-ink-faint")} aria-hidden="true" />
            <span className="relative truncate">{def.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Text label + Radix switch (role="switch"), with optional inline extras. */
function ToggleRow({ label, checked, onChange, disabled = false, children }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <label htmlFor={id} className={cn("cursor-pointer text-xs", disabled ? "text-ink-faint" : "text-ink")}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        {children}
        <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
      </div>
    </div>
  );
}

/** Labelled Radix slider with a live value readout. */
function RangeRow({ label, value, min, max, step, onChange, format, disabled = false }) {
  return (
    <div className={cn("py-0.5", disabled && "opacity-50")}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-ink">{label}</span>
        <span className="font-mono tabular-nums text-ink-muted">{format(value)}</span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={onChange}
        thumbLabel={label}
        className="mt-0.5"
      />
    </div>
  );
}

/** Two-option segmented control for the H3 resolution. */
function ResolutionPicker({ value, onChange, disabled }) {
  return (
    <div role="radiogroup" aria-label="H3 resolution" className="flex rounded-md border border-panel-border bg-bg/70 p-0.5">
      {H3_RESOLUTIONS.map((res) => (
        <button
          key={res}
          type="button"
          role="radio"
          aria-checked={value === res}
          disabled={disabled}
          onClick={() => onChange(res)}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] transition disabled:opacity-40",
            value === res ? "bg-cyan/20 text-cyan" : "text-ink-muted hover:text-ink",
            FOCUS,
          )}
        >
          r{res}
        </button>
      ))}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.layer                         active map layer id
 * @param {(id: string) => void} props.onLayerChange
 * @param {string[]} props.featureNames
 * @param {string} props.shapFeature
 * @param {(name: string) => void} props.onShapFeatureChange
 * @param {(name: string) => string} props.labelOf
 * @param {object} props.settings                      {is3D, elevationScale, opacity, h3Enabled, h3Resolution, showBoundaries, showLabels}
 * @param {(patch: object) => void} props.onSettingsChange
 * @param {"idle"|"indexing"|"ready"|"error"} props.h3Status
 * @param {Array<{id: number, name: string}>} props.districtOptions
 * @param {string} props.flyTarget                     selected district id ("" = none)
 * @param {(id: string) => void} props.onFlyToDistrict
 * @param {() => void} props.onResetView
 * @param {() => void} props.onToggle3D
 * @param {(mode: "hottest"|"coolest"|"max_shap") => void} [props.onInspectCell]  keyboard cell pinning
 * @param {boolean} [props.open]                        controlled expanded state (uncontrolled when omitted)
 * @param {(open: boolean) => void} [props.onOpenChange]
 * @param {string} [props.className]                   extra classes (e.g. a narrower width on phones)
 */
export default function LayerControls({
  layer,
  onLayerChange,
  featureNames,
  shapFeature,
  onShapFeatureChange,
  labelOf,
  settings,
  onSettingsChange,
  h3Status,
  districtOptions,
  flyTarget,
  onFlyToDistrict,
  onResetView,
  onToggle3D,
  onInspectCell,
  open: openProp,
  onOpenChange,
  className,
}) {
  const [openState, setOpenState] = useState(true);
  const controlled = typeof openProp === "boolean";
  const open = controlled ? openProp : openState;
  const setOpen = (updater) => {
    const next = typeof updater === "function" ? updater(open) : updater;
    if (!controlled) setOpenState(next);
    onOpenChange?.(next);
  };
  const featureOptions = featureNames.map((name) => ({ value: name, label: labelOf(name) }));
  const districtSelectOptions = [
    { value: "", label: "Choose a district…" },
    ...[...districtOptions]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ value: String(d.id), label: d.name })),
  ];

  return (
    <motion.section
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "pointer-events-auto flex min-h-0 w-64 flex-col overflow-hidden rounded-xl border border-panel-border bg-panel/70 shadow-glass backdrop-blur-md",
        className,
      )}
      aria-label="Map controls"
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-display text-sm font-semibold text-ink-strong">Thermal Digital Twin</p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-soft">Delhi NCR · XAI</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse map controls" : "Expand map controls"}
          className={cn("rounded-md p-1 text-ink-muted transition hover:bg-white/5 hover:text-ink-strong", FOCUS)}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")} aria-hidden="true" />
        </button>
      </header>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="min-h-0 overflow-y-auto"
          >
            <div className="space-y-3 p-3">
              <div>
                <SectionLabel>Layer</SectionLabel>
                <LayerSwitcher layer={layer} onLayerChange={onLayerChange} />
                {layer === "shap" ? (
                  <Select
                    className="mt-2"
                    size="sm"
                    label="SHAP feature"
                    value={shapFeature ?? ""}
                    options={featureOptions}
                    onValueChange={onShapFeatureChange}
                  />
                ) : null}
              </div>

              <div>
                <SectionLabel>Render</SectionLabel>
                <RangeRow
                  label="Extrusion"
                  value={settings.elevationScale}
                  min={0.1}
                  max={3}
                  step={0.1}
                  format={(v) => `${fmt(v, 1)}×`}
                  onChange={(v) => onSettingsChange({ elevationScale: v })}
                  disabled={!settings.is3D}
                />
                <RangeRow
                  label="Opacity"
                  value={settings.opacity}
                  min={0.2}
                  max={1}
                  step={0.02}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onSettingsChange({ opacity: v })}
                />
                <div className="mt-1 space-y-0.5">
                  <ToggleRow
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        <Hexagon className="h-3.5 w-3.5 text-violet" aria-hidden="true" />
                        H3 hexagons
                        {h3Status === "indexing" ? <span className="text-[10px] text-ink-faint">indexing…</span> : null}
                      </span>
                    }
                    checked={settings.h3Enabled}
                    onChange={(v) => onSettingsChange({ h3Enabled: v })}
                  >
                    <ResolutionPicker
                      value={settings.h3Resolution}
                      onChange={(res) => onSettingsChange({ h3Resolution: res })}
                      disabled={!settings.h3Enabled}
                    />
                  </ToggleRow>
                  <ToggleRow
                    label="District boundaries"
                    checked={settings.showBoundaries}
                    onChange={(v) => onSettingsChange({ showBoundaries: v })}
                  />
                  <ToggleRow
                    label="District labels"
                    checked={settings.showLabels}
                    onChange={(v) => onSettingsChange({ showLabels: v })}
                  />
                </div>
              </div>

              <div>
                <SectionLabel>Camera</SectionLabel>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={onResetView}
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded-lg border border-panel-border bg-bg/60 px-2 py-1.5 text-xs text-ink transition hover:border-cyan/40 hover:text-ink-strong",
                      FOCUS,
                    )}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset view
                  </button>
                  <button
                    type="button"
                    onClick={onToggle3D}
                    aria-pressed={settings.is3D}
                    aria-label="3-D extrusion"
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition",
                      settings.is3D
                        ? "border-cyan/40 bg-cyan/10 text-cyan hover:bg-cyan/20"
                        : "border-panel-border bg-bg/60 text-ink hover:border-cyan/40",
                      FOCUS,
                    )}
                  >
                    {settings.is3D ? (
                      <Box className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Square className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {settings.is3D ? "3-D" : "2-D"}
                  </button>
                </div>
                <Select
                  className="mt-2"
                  size="sm"
                  label="Fly to district"
                  value={flyTarget}
                  options={districtSelectOptions}
                  onValueChange={onFlyToDistrict}
                />
              </div>

              {onInspectCell ? (
                <div>
                  <SectionLabel>Inspect a cell</SectionLabel>
                  <p className="mb-1.5 text-[11px] leading-snug text-ink-muted">
                    Pin a cell without the pointer
                    {flyTarget ? " in the chosen district" : " anywhere in the NCR (choose a district above to narrow it)"}.
                  </p>
                  <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Pin a cell by keyboard">
                    {PICK_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onInspectCell(m.id)}
                        className={cn(
                          "rounded-lg border border-panel-border bg-bg/60 px-1.5 py-1.5 text-[11px] leading-tight text-ink transition hover:border-cyan/40 hover:text-ink-strong",
                          FOCUS,
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}
