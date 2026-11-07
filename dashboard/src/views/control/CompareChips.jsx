/**
 * Compare chips (UI_SPEC_v2 §3.10): the two sides of the split and the presets.
 *
 *   [◒ 1990 · Day ▾]  ⟷  [○ 2050 · SSP2-4.5 p50 · Day ▾]      Years │ Scenarios │ Day|Night   ✕
 *
 * Kinds (timeStore.compare.kind): "y" years A|B (default first frame → last frame), "s" SSP A|B
 * at a projected year (default 2050 SSP1-2.6 | SSP5-8.5), "m" Day|Night at the current year.
 * Every side shows its manifest tier glyph. On mobile the split is replaced by the Δ layer with
 * an A / B / B − A toggle (A: divider at the right edge, B: at the left edge, Δ: v=delta).
 */
import { useId } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { TierGlyph } from "../../components/ui/TierGlyph.jsx";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { frameTierInfo } from "../../data/timeline.js";
import { cn } from "../../lib/cn.js";
import { fmtSsp } from "../../lib/format.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { announce } from "../../shell/announcer.js";
import { compareSideLabel, compareSides } from "./controlModel.js";
import { useTimelineData } from "./useControlData.js";

const SELECT = "focus-ring h-7 cursor-pointer rounded-md border border-control bg-surface-3 px-1.5 font-mono text-[12px] text-ink";

function SideSelect({ side, kind, value, timeline, onChange }) {
  const id = useId();
  const label = `Compare side ${side}`;
  if (kind === "y") {
    return (
      <>
        <label htmlFor={id} className="sr-only">
          {label} year
        </label>
        <select id={id} className={SELECT} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
          {timeline.years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </>
    );
  }
  if (kind === "s") {
    return (
      <>
        <label htmlFor={id} className="sr-only">
          {label} scenario
        </label>
        <select id={id} className={SELECT} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {timeline.scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label ?? fmtSsp(s.id)}
            </option>
          ))}
        </select>
      </>
    );
  }
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label} mode
      </label>
      <select id={id} className={SELECT} value={value ?? "day"} onChange={(e) => onChange(e.target.value)}>
        {timeline.modeIds.map((m) => (
          <option key={m} value={m}>
            {m === "night" ? "Night" : "Day"}
          </option>
        ))}
      </select>
    </>
  );
}

/** Apply a preset (also used by the palette / Briefing through the same store calls). */
function applyPreset(kind, timeline, year) {
  const t = useTimeStore.getState();
  if (kind === "y") t.setCompare({ kind: "y", a: timeline.first, b: timeline.last });
  else if (kind === "s") {
    const ids = timeline.scenarioIds;
    t.setCompare({ kind: "s", a: ids.includes("ssp126") ? "ssp126" : ids[0], b: ids.includes("ssp585") ? "ssp585" : ids[ids.length - 1] });
    if (!(Number.isFinite(year) && year > timeline.now)) t.setYear(timeline.projYears[timeline.projYears.length - 1] ?? timeline.last);
  } else t.setCompare({ kind: "m", a: "day", b: "night" });
}

/** @param {{mobile?: boolean, stageWidth?: number, className?: string}} props */
export function CompareChips({ mobile = false, stageWidth = 0, className }) {
  const timeline = useTimelineData();
  const compare = useTimeStore((s) => s.compare);
  const year = useTimeStore((s) => s.year);
  const mode = useTimeStore((s) => s.mode ?? "day");
  const ssp = useTimeStore((s) => s.ssp);
  const variable = useViewStore((s) => s.variable);
  if (!timeline || !compare?.kind) return null;
  const sides = compareSides(compare, { year, mode, ssp, timeline });
  const scenarios = timeline.scenarios;
  const presets = [
    { value: "y", label: "Years", title: "Year A | B (first frame → last frame)" },
    { value: "s", label: "Scenarios", title: "SSP A | B at a projected year", disabled: timeline.scenarioIds.length < 2, reason: "Needs two scenarios in the bundle" },
    { value: "m", label: "Day | Night", title: "Day vs night at the same year", disabled: !(timeline.modeIds.includes("day") && timeline.modeIds.includes("night")), reason: "Needs day and night in the bundle" },
  ];
  const side = (key) => {
    const s = sides[key];
    const info = frameTierInfo(timeline, s.year, s.mode, s.ssp);
    const value = key === "A" ? compare.a : compare.b;
    const text = compareSideLabel(compare.kind, value, { year: s.year, mode: s.mode, scenarios });
    return (
      <div className="flex min-w-0 items-center gap-1.5" data-side={key}>
        <span className="font-mono text-[11px] font-semibold text-signal">{key}</span>
        <TierGlyph tier={info?.tier} variant="glyph" />
        <SideSelect side={key} kind={compare.kind} value={value} timeline={timeline} onChange={(v) => useTimeStore.getState().setCompare(key === "A" ? { a: v } : { b: v })} />
        <span className="hidden truncate text-[12px] text-ink-muted xl:inline">{text}</span>
      </div>
    );
  };
  const close = () => {
    useTimeStore.getState().setCompare(null);
    if (useViewStore.getState().variable === "delta") useViewStore.getState().setVariable(timeline.harmonised ? "abs" : "anom");
    announce("Compare off");
  };
  return (
    <HudFrame as="section" aria-label="Compare" padding="sm" active className={cn("pointer-events-auto", className)} data-testid="compare-chips">
      <div className="flex flex-wrap items-center gap-2">
        {side("A")}
        <ArrowLeftRight aria-hidden="true" className="size-3.5 text-ink-faint" />
        {side("B")}
        {mobile ? (
          <Segmented
            ariaLabel="Compare view"
            layoutId="compare-mobile"
            size="touch"
            value={variable === "delta" ? "d" : (compare.splitPx ?? 0) >= stageWidth - 1 ? "a" : "b"}
            onChange={(v) => {
              if (v === "d") useViewStore.getState().setVariable("delta");
              else {
                if (useViewStore.getState().variable === "delta") useViewStore.getState().setVariable(timeline.harmonised ? "abs" : "anom");
                useTimeStore.getState().setCompare({ splitPx: v === "a" ? stageWidth : 0 });
              }
            }}
            options={[
              { value: "a", label: "A" },
              { value: "b", label: "B" },
              { value: "d", label: "B − A" },
            ]}
          />
        ) : (
          <Segmented ariaLabel="Compare preset" layoutId="compare-preset" size="sm" value={compare.kind} options={presets} onChange={(k) => applyPreset(k, timeline, year)} />
        )}
        <button type="button" aria-label="Close compare" onClick={close} className="focus-ring grid size-7 place-items-center rounded-md text-ink-muted hover:bg-surface-3 hover:text-ink">
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </HudFrame>
  );
}

export default CompareChips;
