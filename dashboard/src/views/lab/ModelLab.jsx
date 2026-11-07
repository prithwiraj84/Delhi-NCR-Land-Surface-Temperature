/**
 * MODEL LAB route (UI_SPEC §3.8): "How good is this model, and where should you not trust it?"
 *
 *   honest skill        pooled block20 + LOEO, Day and Night, random greyed, v1 → v2 metric note
 *   scoreboard          model × scheme (value + fold strip) | error vs distance to training
 *   fold map | residual Moran (v1 panel) | AOA (% inside per frame, DI deciles, mini map)
 *   downscaling 250 m   scale invariance vs bilinear, day demo, by land cover
 *   hindcast            LOEO raw vs recentred, hindcast vs persistence, persistent residual,
 *                       land-model figure of merit, climate sensitivity β
 *   projection method   (SVG diagram) + uncertainty budget | model card | hardware
 * The map stage is hidden behind this route. v1 bundles show their own metrics under v1
 * labels and every v2-only panel explains why it is empty.
 */
import { useMemo, useState } from "react";
import { Cpu, FlaskConical, Radar } from "lucide-react";
import { useData } from "../../state/DataContext.jsx";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useAsset, useModel, useResource, useTimeline } from "../../data/hooks.js";
import { scopeSeries } from "../../data/series.js";
import { modeAvailable, modeUnavailableReason } from "../../data/timeline.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { ScanSkeleton } from "../../components/ui/ScanSkeleton.jsx";
import { HardwareCard } from "../../components/performance/HardwareCard.jsx";
import { MoranPanel } from "../../components/performance/MoranPanel.jsx";
import { hardwareInfo } from "../../components/performance/perfModel.js";
import { Unavailable } from "../../viz/Unavailable.jsx";
import { buildCaveats, caveatsFor } from "../sources/caveats.js";
import { CaveatPip } from "../zones/CaveatPip.jsx";
import { AoaPanel } from "./AoaPanel.jsx";
import { DownscaleValidation } from "./DownscaleValidation.jsx";
import { ErrorDistance } from "./ErrorDistance.jsx";
import { FoldMap } from "./FoldMap.jsx";
import { HindcastPanel } from "./HindcastPanel.jsx";
import { HonestSkill } from "./HonestSkill.jsx";
import { honestSkill, metricsSlice, v1PanelMetrics } from "./labModel.js";
import { ModelCard } from "./ModelCard.jsx";
import { ProjectionMethod } from "./ProjectionMethod.jsx";
import { SkillScoreboard } from "./SkillScoreboard.jsx";
import { UncertaintyBudget } from "./UncertaintyBudget.jsx";

export function ModelLab() {
  const { status, manifest, schema } = useData();
  const tl = useTimeline();
  const timeline = tl.status === "ready" ? tl.data : null;
  const metricsRes = useAsset("metrics");
  const seriesRes = useResource("series");
  const timeMode = useTimeStore((s) => s.mode);
  const [modeChoice, setModeChoice] = useState(null);
  const nightOk = modeAvailable(timeline, "night");
  const mode = (modeChoice ?? (timeMode === "night" ? "night" : "day")) === "night" && nightOk ? "night" : "day";
  const model = useModel(mode);
  const metrics = metricsRes.status === "ready" ? metricsRes.data : null;
  const slice = metricsSlice(metrics, mode);
  const panelMetrics = useMemo(() => v1PanelMetrics(slice, metrics), [slice, metrics]);
  const hardware = useMemo(() => (panelMetrics ? hardwareInfo(panelMetrics) : null), [panelMetrics]);
  const skill = useMemo(() => honestSkill(metrics, mode), [metrics, mode]);
  const caveats = useMemo(() => buildCaveats(manifest, { schema }), [manifest, schema]);
  const ncr = seriesRes.status === "ready" ? scopeSeries(seriesRes.data, "ncr", mode) : null;
  const scenarioIds = timeline?.scenarioIds ?? [];
  const lastYear = timeline?.projYears?.at(-1) ?? 2050;

  if (status === "loading" || metricsRes.status === "loading" || metricsRes.status === "idle") return <ScanSkeleton label="Loading model diagnostics" height={320} className="m-4" />;
  if (status !== "ready" || !manifest) return <Unavailable status={status} reason="The web bundle has not been loaded." className="m-4" />;

  const modeOptions = [
    { value: "day", label: "Day" },
    { value: "night", label: "Night", disabled: !nightOk, reason: modeUnavailableReason(timeline, "night") ?? undefined },
  ];

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-3 px-3 pb-10 pt-4 sm:px-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="micro-label flex items-center gap-1.5">
            <FlaskConical aria-hidden="true" className="size-3.5 text-signal" /> Model Lab
          </p>
          <h1 className="font-display text-2xl font-semibold text-ink-strong">How good is this model, and where should you not trust it?</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CaveatPip caveats={caveatsFor(caveats, ["model"])} label="Model caveats" />
          <Segmented ariaLabel="Mode of the diagnostics" value={mode} onChange={setModeChoice} options={modeOptions} size="sm" layoutId="lab-mode" />
        </div>
      </header>

      {metricsRes.status !== "ready" ? (
        <Unavailable status={metricsRes.status} reason={metricsRes.reason ?? "metrics.json is missing from this bundle."} />
      ) : (
        <HonestSkill metrics={metrics} schema={schema} dataMode={manifest?.data_mode ?? metrics?.data_mode ?? null} />
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <SkillScoreboard slice={slice} mode={mode} />
        <ErrorDistance slice={slice} mode={mode} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <FoldMap slice={slice} mode={mode} />
        <HudFrame
          solid
          className="min-w-0"
          title={
            <span className="inline-flex items-center gap-1.5">
              <Radar aria-hidden="true" className="size-3.5 text-signal" />
              Residual spatial autocorrelation · {mode}
            </span>
          }
        >
          {panelMetrics ? <MoranPanel metrics={panelMetrics} /> : <Unavailable reason="No residual Moran's I exported." />}
        </HudFrame>
        {/* Third panel of a 2-column grid (lg–xl): span the row instead of leaving half of it empty. */}
        <div className="min-w-0 lg:col-span-2 2xl:col-span-1">
          <AoaPanel slice={slice} mode={mode} />
        </div>
      </div>

      <DownscaleValidation metrics={metrics} />
      <HindcastPanel slice={slice} metrics={metrics} mode={mode} />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <ProjectionMethod metrics={metrics} scenarios={timeline?.scenarios ?? []} available={scenarioIds.length > 0} />
          <UncertaintyBudget budget={ncr?.uncertaintyBudget ?? null} ssps={scenarioIds} year={lastYear} scopeLabel="NCR" rho={slice?.aoa?.resid_rho_block20 ?? null} mode={mode} reason={scenarioIds.length ? null : "No projections in this bundle — rerun notebook v2."} />
        </div>
        <div className="min-w-0 space-y-3">
          <ModelCard manifest={manifest} schema={schema} modelRaw={model.status === "ready" ? model.data : null} mode={mode} skill={skill} timeline={timeline} />
          <HudFrame
            solid
            title={
              <span className="inline-flex items-center gap-1.5">
                <Cpu aria-hidden="true" className="size-3.5 text-signal" /> Hardware & timings
              </span>
            }
          >
            {hardware ? <HardwareCard hardware={hardware} timings={panelMetrics?.timings ?? null} /> : <Unavailable reason="No hardware report exported." />}
          </HudFrame>
        </div>
      </div>
    </div>
  );
}

export default ModelLab;
