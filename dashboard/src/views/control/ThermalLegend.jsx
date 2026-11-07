/**
 * Thermal legend (UI_SPEC_v2 §3.2 LEGEND, §4.2, §8 `ThermalLegend`):
 *
 *   LST · DAY                         fixed 1990–2050
 *   ▕████████████████████████▏        Solar ramp
 *   38 ········ 43 ········ 48 °C
 *   height: °C above NCR mean (cap +6)
 *   VSUP wedge (projected / uncertainty)   ▨ outside AOA
 *
 * Props per spec: `ramp, domain, unit, variable, heightMode, vsup, aoa, domainMode`; states:
 * single, shared-scale, categorical, stretched-warning. The colour domain is FIXED across all
 * frames by default (D4); a per-frame contrast stretch shows a warning chip. Diverging layers
 * label the arms ("cooler" / "warmer") so polarity is never colour-only. The legend
 * cross-fades (400 ms, ticks slide 4 px) when the ramp or domain changes (§5.2 E).
 * `ThermalLegendLive` binds it to the stores and hooks; on mobile it collapses ("legend ▾").
 */
import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { rampGradientCss } from "../../design/ramps.js";
import { driverPalette } from "../../design/tokens.js";
import { useMotionLevel } from "../../design/useMotionLevel.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { ZoneLabelCaveat } from "../../components/zones/ZoneLabelCaveat.jsx";
import { useDomain, useXai } from "../../data/hooks.js";
import { cn } from "../../lib/cn.js";
import { fmt } from "../../lib/format.js";
import { useData } from "../../state/DataContext.jsx";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { engineStore } from "../../engine/engineStore.js";
import { legendFromEngine, legendSpec } from "./layerModel.js";
import { useLiveFrame, useManifestData, useShapOptions } from "./useControlData.js";
import { VsupWedge } from "./VsupWedge.jsx";

const MODE_WORD = { day: "Day", night: "Night", dtr: "DTR" };
const HEIGHT_TEXT = { anom: "height: °C above NCR mean (cap +6)", abs: "height: absolute °C above the scale minimum", flat: null };

function HatchSwatch() {
  return (
    <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-sm border border-hairline-strong" style={{ background: "repeating-linear-gradient(45deg, var(--hatch) 0 1.5px, transparent 1.5px 4px), var(--surface-3)" }} />
  );
}

function ticksFor(domain, signed) {
  if (!domain) return [];
  const [lo, hi] = domain;
  if (signed) return [lo, 0, hi];
  return [lo, (lo + hi) / 2, hi];
}

/**
 * @param {{spec: ReturnType<typeof legendSpec>, mode: string, heightMode?: string, vsup?: boolean,
 *          aoa?: boolean, compact?: boolean, className?: string}} props
 */
export function ThermalLegend({ spec, mode, heightMode = "anom", vsup = false, aoa = false, compact = false, className }) {
  const level = useMotionLevel();
  const [open, setOpen] = useState(!compact);
  const animate = level === "full";
  const key = spec.kind === "continuous" ? `${spec.ramp}|${spec.domain?.join(",")}` : `${spec.kind}|${spec.title}`;
  const dp = spec.domain && Math.abs(spec.domain[1] - spec.domain[0]) < 4 ? 1 : 0;
  const heightText = spec.kind === "continuous" ? HEIGHT_TEXT[heightMode] ?? null : null;

  return (
    <HudFrame as="section" aria-label="Map legend" padding="sm" className={cn("pointer-events-auto", compact ? "w-auto" : "w-[244px]", className)} data-testid="thermal-legend" data-state={spec.kind === "unavailable" ? "unavailable" : spec.stretched ? "stretched-warning" : spec.kind === "categorical" ? "categorical" : spec.shared ? "shared-scale" : "single"}>
      {/* Wraps instead of truncating: long titles ("Anomaly vs frame mean · Day") keep their full
          text and the scale note drops to its own right-aligned line. */}
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <h2 className="micro-label min-w-0">
          {spec.title}
          {spec.kind === "continuous" ? ` · ${MODE_WORD[mode] ?? mode}` : ""}
        </h2>
        {compact ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="focus-ring inline-flex h-6 items-center gap-0.5 rounded px-1 font-mono text-[11px] text-ink-muted">
            legend {open ? <ChevronUp aria-hidden="true" className="size-3" /> : <ChevronDown aria-hidden="true" className="size-3" />}
          </button>
        ) : (
          spec.kind === "continuous" &&
          (spec.stretched ? (
            <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-warn/60 px-1.5 font-mono text-[11px] text-warn" title="Colours are stretched to this frame only: do not compare colours across years">
              <AlertTriangle aria-hidden="true" className="size-3" /> stretched
            </span>
          ) : spec.fixed ? (
            <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-faint" title="One colour scale for every frame, so colour changes are real changes">
              {spec.shared ? "shared day+night" : "fixed all frames"}
            </span>
          ) : null)
        )}
      </header>
      {open && (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={key} initial={animate ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={animate ? { opacity: 0, transition: { duration: 0.16 } } : { opacity: 1 }} transition={{ duration: animate ? 0.4 : 0 }} className="mt-1.5">
            {spec.kind === "continuous" && spec.domain && (
              <>
                <div aria-hidden="true" className="h-2.5 w-full rounded-sm border border-hairline" style={{ background: rampGradientCss(spec.ramp) }} />
                <motion.div initial={animate ? { x: 4 } : false} animate={{ x: 0 }} transition={{ duration: animate ? 0.4 : 0 }} className="tnum mt-1 flex justify-between font-mono text-[11px] text-ink-muted">
                  {ticksFor(spec.domain, spec.signed).map((t, i) => (
                    <span key={i}>{spec.signed && t > 0 ? `+${fmt(t, dp)}` : fmt(t, dp)}</span>
                  ))}
                </motion.div>
                <p className="mt-0.5 flex justify-between text-[11px] text-ink-faint">
                  {spec.signed ? (
                    <>
                      <span>cooler</span>
                      <span>{spec.unit}</span>
                      <span>warmer</span>
                    </>
                  ) : (
                    <>
                      <span>cooler</span>
                      <span>{spec.unit}</span>
                      <span>hotter</span>
                    </>
                  )}
                </p>
                <p className="sr-only">{`Colour scale ${fmt(spec.domain[0], 1)} to ${fmt(spec.domain[1], 1)} ${spec.unit}${spec.stretched ? ", contrast-stretched to this frame" : spec.fixed ? ", fixed across all frames" : ""}.`}</p>
              </>
            )}
            {spec.kind === "categorical" && (
              <ul className="scrollbar-thin max-h-40 space-y-0.5 overflow-y-auto pr-1">
                {(spec.entries ?? []).map((e, i) => (
                  <li key={e.id ?? i} className="flex items-center gap-1.5 text-[12px] text-ink">
                    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: e.color }} />
                    <span className="tnum font-mono text-[11px] text-ink-faint">{e.id}</span>
                    <span className="truncate">{e.label}</span>
                    {e.caveat && <ZoneLabelCaveat caveat={e.caveat} name={e.label} />}
                  </li>
                ))}
              </ul>
            )}
            {spec.kind === "aoa" && (
              <p className="flex items-center gap-1.5 text-[12px] text-ink">
                <HatchSwatch /> outside the area of applicability
              </p>
            )}
            {spec.kind === "unavailable" && <p className="sr-only">No colour scale: nothing is drawn for this layer at this frame.</p>}
            {spec.note && (
              <p role={spec.kind === "unavailable" ? "status" : undefined} className={cn("mt-1 text-[11px] leading-snug", spec.kind === "unavailable" ? "text-ink-muted" : "text-ink-faint")}>
                {spec.note}
              </p>
            )}
            {heightText && <p className="mt-1 font-mono text-[11px] text-ink-muted">{heightText}</p>}
            {vsup && spec.kind === "continuous" && spec.ramp && <VsupWedge ramp={spec.ramp} className="mt-1.5" />}
            {aoa && spec.kind !== "aoa" && spec.kind !== "unavailable" && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
                <HatchSwatch /> outside AOA (hatched)
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </HudFrame>
  );
}

/** Legend bound to the view state. */
export function ThermalLegendLive({ compact = false, className }) {
  const layer = useViewStore((s) => s.layer);
  const variable = useViewStore((s) => s.variable);
  const domainMode = useViewStore((s) => s.domainMode);
  const heightMode = useViewStore((s) => s.heightMode);
  const shapFeature = useViewStore((s) => s.shapFeature);
  const mode = useTimeStore((s) => s.mode ?? "day");
  const year = useTimeStore((s) => s.year);
  const { timeline, info } = useLiveFrame({ withStats: false });
  const manifest = useManifestData();
  const shapOptions = useShapOptions();
  const domain = useDomain(mode, variable);
  const needsXai = layer === "resid" || layer === "shap";
  const xai = useXai(needsXai ? year : null, mode);
  const data = useData() ?? {};
  // The channel the engine actually drew (D22 a); memoised categories keep this stable per frame.
  const engineLegend = useStore(engineStore, (s) => s.legend);
  const baseSpec = useMemo(
    () =>
      legendSpec({
        layer,
        variable,
        mode,
        domainMode,
        domain: domain.status === "ready" ? domain.data : null,
        timeline,
        xai: xai.status === "ready" ? xai.data : null,
        shapFeature,
        featureLabel: shapOptions.find((o) => o.id === shapFeature)?.label ?? null,
        scenarioResult: data.scenarioResult ?? null,
        manifest,
        groups: shapOptions.map((o, i) => ({ id: i, label: o.label, color: driverPalette[i % driverPalette.length] })),
      }),
    [layer, variable, mode, domainMode, domain, timeline, xai, shapFeature, shapOptions, data.scenarioResult, manifest],
  );
  const spec = useMemo(() => legendFromEngine(baseSpec, engineLegend, { layer, mode, variable }), [baseSpec, engineLegend, layer, mode, variable]);
  const projected = info?.tier === "projected" || info?.kind === "projected";
  return <ThermalLegend spec={spec} mode={mode} heightMode={heightMode} vsup={projected || layer === "unc"} aoa={timeline?.schema !== "v1" && (layer === "aoa" || projected)} compact={compact} className={className} />;
}

export default ThermalLegendLive;
