/**
 * DRIVERS route (UI_SPEC §3.6): why is it hot here, by day and at night?
 *
 *   frame chip   follows the ribbon; a frame without XAI (projections, missing modes) says
 *                why and offers the nearest explained frame
 *   importance   Global | Frame | Zone (v1 ImportanceChart), view Day | Night | Day − Night Δ
 *   dependence   v1 DependencePanel + the brush that dims the docked map outside a range
 *   thresholds · interactions · importance through time · what-if simulator (v2 engine:
 *                47 features with focal recompute; v1 bundles run the v1 engine)
 *
 * The map stage is docked right (40 %) and stays live; this view fills the left 60 %.
 * All v1 shap components are reused in place, fed through the useData() facade (which
 * presents v2 SHAP groups as v1 "features").
 */
import { useCallback, useMemo, useState } from "react";
import { Crosshair, FlaskConical, Grid3x3, Layers, LineChart, Radar } from "lucide-react";
import { useData } from "../../state/DataContext.jsx";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useAsset, useTimeline } from "../../data/hooks.js";
import { modeAvailable, modeUnavailableReason, tierOf, xaiYears } from "../../data/timeline.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { TierGlyph } from "../../components/ui/TierGlyph.jsx";
import { Button } from "../../components/ui/Button.jsx";
import { InfoTip } from "../../components/ui/InfoTip.jsx";
import { ScanSkeleton } from "../../components/ui/ScanSkeleton.jsx";
import { cn } from "../../lib/cn.js";
import DependencePanel from "../../components/shap/DependencePanel.jsx";
import ImportanceChart from "../../components/shap/ImportanceChart.jsx";
import InteractionMatrix from "../../components/shap/InteractionMatrix.jsx";
import ScenarioSimulator from "../../components/shap/ScenarioSimulator.jsx";
import ThresholdCards from "../../components/shap/ThresholdCards.jsx";
import { buildCurve, featureGroupsFor } from "../../components/shap/shapMath.js";
import { Unavailable } from "../../viz/Unavailable.jsx";
import { DependenceBrush } from "./DependenceBrush.jsx";
import { dependenceKeyResolver, modeSlice, nearestXaiYear, scenarioMetas } from "./driversModel.js";
import { ImportanceDiff } from "./ImportanceDiff.jsx";
import { ImportanceTrend } from "./ImportanceTrend.jsx";

function GroupChips({ vocabulary, groups, onToggle, onAll }) {
  const all = groups.size === vocabulary.length;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter drivers by family">
      <button type="button" onClick={onAll} aria-pressed={all} className={cn("focus-ring rounded-full border px-2.5 py-0.5 text-[11px]", all ? "border-signal/50 bg-signal/10 text-ink-strong" : "border-hairline text-ink-muted hover:text-ink")}>
        All
      </button>
      {vocabulary.map((g) => {
        const on = groups.has(g.id);
        return (
          <button key={g.id} type="button" onClick={() => onToggle(g.id)} aria-pressed={on} className={cn("focus-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]", on ? "border-control bg-surface-3 text-ink" : "border-hairline text-ink-faint hover:text-ink-muted")}>
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", !on && "opacity-35")} style={{ backgroundColor: g.color }} />
            {g.label}
          </button>
        );
      })}
    </div>
  );
}

function Panel({ icon: Icon, title, info, children, className, actions }) {
  return (
    <HudFrame
      solid
      className={cn("min-w-0", className)}
      title={
        <span className="inline-flex items-center gap-1.5">
          {Icon && <Icon aria-hidden="true" className="size-3.5 text-signal" />}
          {title}
        </span>
      }
      actions={
        <>
          {actions}
          {info && <InfoTip content={info} label={`About: ${title}`} />}
        </>
      }
    >
      {children}
    </HudFrame>
  );
}

export function DriversView() {
  const data = useData();
  const { status, manifest, schema, features, year, epoch, shapGlobal, dependence, interactions, zonesMeta, shapFeature, setShapFeature, uncertainty, epochLoading } = data;
  const ciLabel = uncertainty?.label ?? "95% CI";
  const tl = useTimeline();
  const timeline = tl.status === "ready" ? tl.data : null;
  const timeYear = useTimeStore((s) => s.year);
  const timeMode = useTimeStore((s) => s.mode);
  const mode = timeMode === "night" ? "night" : "day";
  const shapRaw = useAsset("shapGlobal");
  const depRaw = useAsset("dependence");
  const [view, setView] = useState("mode");

  const metaByName = useMemo(() => new Map((features ?? []).map((f) => [f.name, f])), [features]);
  const vocabulary = useMemo(() => featureGroupsFor(features ?? []), [features]);
  const [hidden, setHidden] = useState(() => new Set());
  const groups = useMemo(() => new Set(vocabulary.map((g) => g.id).filter((id) => !hidden.has(id))), [vocabulary, hidden]);
  const toggleGroup = useCallback(
    (id) =>
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const [colorOverride, setColorOverride] = useState(null);
  const [colorMode, setColorMode] = useState("partner");
  const feature = shapFeature && metaByName.has(shapFeature) ? shapFeature : (features?.[0]?.name ?? null);
  const meta = feature ? metaByName.get(feature) : null;
  const dep = feature ? (dependence?.features?.[feature] ?? null) : null;
  const curve = useMemo(() => buildCurve(dep), [dep]);
  const defaultPartner = dep?.scatter?.color_feature ?? null;
  const colorFeature = colorOverride && colorOverride.feature === feature ? colorOverride.color : defaultPartner;
  const onSelectCell = useCallback(
    (row, col) => {
      setShapFeature(row);
      setColorMode("partner");
      setColorOverride(row === col ? null : { feature: row, color: col });
    },
    [setShapFeature],
  );
  const onColorFeatureChange = useCallback((name) => setColorOverride({ feature, color: name }), [feature]);

  const simMetas = useMemo(() => scenarioMetas({ schema, manifest, features }), [schema, manifest, features]);
  const depKeyFor = useMemo(() => dependenceKeyResolver({ schema, manifest }), [schema, manifest]);
  const labelOf = useCallback((id) => metaByName.get(id)?.label ?? id, [metaByName]);
  const xaiFrames = useMemo(() => (timeline ? xaiYears(timeline, mode) : []), [timeline, mode]);
  const exactXai = xaiFrames.includes(Number(timeYear));
  const nearest = nearestXaiYear(xaiFrames, timeYear);
  const nightOk = modeAvailable(timeline, "night");

  if (status === "loading" || tl.status === "loading") return <ScanSkeleton label="Loading drivers" height={320} className="m-4" />;
  if (status !== "ready" || !manifest) return <Unavailable status={status} reason="The web bundle has not been loaded." className="m-4" />;

  const modeOptions = [
    { value: "day", label: "Day" },
    { value: "night", label: "Night", disabled: !nightOk, reason: modeUnavailableReason(timeline, "night") ?? undefined },
    { value: "diff", label: "Day − Night Δ", disabled: !nightOk, reason: nightOk ? undefined : "Needs night drivers" },
  ];
  const viewValue = view === "diff" ? "diff" : mode;
  const onView = (v) => {
    if (v === "diff") setView("diff");
    else {
      setView("mode");
      useTimeStore.getState().setMode?.(v);
    }
  };
  const tier = year !== null && timeline ? tierOf(timeline, year, mode) : null;

  return (
    <div className="space-y-3 px-3 pb-10 pt-4 sm:px-4">
      <header className="space-y-2">
        <p className="micro-label flex items-center gap-1.5">
          <Radar aria-hidden="true" className="size-3.5 text-signal" /> Drivers · grouped TreeSHAP
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-semibold text-ink-strong">Why it is hot {mode === "night" ? "at night" : "by day"}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-2 px-2.5 py-1 text-xs text-ink">
              frame <span className="font-mono">{year ?? "—"}</span>
              {tier && <TierGlyph tier={tier} variant="short" />}
              {epochLoading && <span className="text-ink-faint">· loading</span>}
            </span>
            <Segmented ariaLabel="Driver view" value={viewValue} onChange={onView} options={modeOptions} size="sm" layoutId="drivers-mode" />
          </div>
        </div>
        {!exactXai && timeline && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-hairline-strong bg-surface-3/40 px-3 py-2 text-xs text-ink-muted">
            <span>
              {Number.isFinite(Number(timeYear)) ? `${Math.round(timeYear)}` : "This year"} has no {mode} drivers{xaiFrames.length ? ` (frames with XAI: ${xaiFrames[0]}–${xaiFrames[xaiFrames.length - 1]})` : ""}; showing the nearest explained frame{year ? ` ${year}` : ""}.
            </span>
            {nearest !== null && (
              <Button size="xs" variant="outline" onClick={() => useTimeStore.getState().setYear?.(nearest, { snap: true })}>
                Go to {nearest}
              </Button>
            )}
          </div>
        )}
      </header>

      {view === "diff" ? (
        <ImportanceDiff shapGlobal={shapRaw.status === "ready" ? shapRaw.data : null} dependence={depRaw.status === "ready" ? depRaw.data : null} labelOf={labelOf} selected={feature} onSelect={(id) => { setShapFeature(id); setView("mode"); }} reason={nightOk ? null : modeUnavailableReason(timeline, "night")} />
      ) : null}

      <div className="grid items-start gap-3 2xl:grid-cols-2">
        <Panel icon={Layers} title={`Driver importance · ${mode}`} info={`Mean absolute SHAP (°C) per ${schema === "v2" ? "SHAP group (members summed; TreeSHAP additivity holds)" : "feature"}. Whiskers: ${uncertainty?.describe ?? "block-bootstrap intervals."} Click a driver to explore its dependence curve.`}>
          <div className="mb-2.5">
            <GroupChips vocabulary={vocabulary} groups={groups} onToggle={toggleGroup} onAll={() => setHidden(new Set())} />
          </div>
          <ImportanceChart shapGlobal={shapGlobal} metaByName={metaByName} zonesMeta={zonesMeta} year={year} groups={groups} selectedFeature={feature} onSelect={setShapFeature} ciLabel={ciLabel} />
        </Panel>

        <div className="min-w-0 space-y-3">
          <Panel icon={LineChart} title="Dependence & thresholds" info={`Each dot is one cell: the driver's value (x) against its SHAP contribution (y, °C). Line = binned mean; band = bootstrap ${ciLabel}. SHAP describes the model, not causal effects.`}>
            <DependencePanel
              feature={feature}
              dep={dep}
              curve={curve}
              metaByName={metaByName}
              epoch={epoch}
              year={year}
              zonesMeta={zonesMeta}
              colorFeature={colorFeature}
              colorMode={colorMode}
              onFeatureChange={setShapFeature}
              onColorFeatureChange={onColorFeatureChange}
              onColorModeChange={setColorMode}
              ciLabel={ciLabel}
            />
            <div className="mt-2.5">
              <DependenceBrush values={feature ? epoch?.features?.[feature] ?? null : null} meta={meta} feature={feature} year={year} />
            </div>
          </Panel>
          <Panel icon={Crosshair} title="Threshold readout">
            {dep ? <ThresholdCards meta={meta} threshold={dep.threshold ?? null} curve={curve} ciLabel={ciLabel} /> : <p className="text-xs text-ink-muted">No threshold analysis was exported for this driver.</p>}
          </Panel>
        </div>

        <Panel icon={Grid3x3} title="Interaction matrix" info="Mean |SHAP interaction| between driver pairs (°C). Click a cell to plot the row driver coloured by the column driver.">
          <InteractionMatrix interactions={interactions} metaByName={metaByName} zonesMeta={zonesMeta} selectedFeature={feature} colorFeature={colorMode === "partner" ? colorFeature : null} onSelectCell={onSelectCell} />
        </Panel>

        <ImportanceTrend slice={modeSlice(shapRaw.status === "ready" ? shapRaw.data : null, mode)} mode={mode} year={year} labelOf={labelOf} selected={feature} onSelect={setShapFeature} />

        <Panel
          icon={FlaskConical}
          title="What-if simulator"
          className="2xl:col-span-2"
          info={
            schema === "v2"
              ? "Perturb one actionable land-cover lever in a region; the browser rebalances the land-cover simplex (incl. other vegetation), shifts the coupled spectral indices, recomputes the 3- and 15-cell focal means on the grid (distances held fixed) and re-predicts with the exported per-mode surrogate. Model associations, not causal effects."
              : "Perturb one actionable feature in a region and re-predict LST in the browser with the exported surrogate model. Model associations, not causal effects."
          }
        >
          <ScenarioSimulator metaByName={simMetas} dependenceKeyFor={depKeyFor} />
        </Panel>
      </div>
    </div>
  );
}

export default DriversView;
