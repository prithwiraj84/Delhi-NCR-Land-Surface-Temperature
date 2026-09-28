/**
 * Non-Linear Threshold Explorer (view "thresholds").
 *
 * Three columns (stacked below 1280 px):
 *   left   – global SHAP importance with bootstrap CIs (global / by epoch / by zone) and
 *            feature-group filter chips; clicking a bar selects the feature;
 *   centre – dependence plot of the selected feature (scatter + binned mean + 95 % band +
 *            threshold lines), threshold cards, and the K×K interaction heatmap whose cells
 *            choose the scatter's colour feature;
 *   right  – scenario simulator running the in-browser surrogate model.
 *
 * Shared state lives in DataContext (selected feature, scenario); view-local state (group
 * filter, colour feature/mode) lives here. Every optional asset may be null: each panel
 * renders an explanatory fallback instead of failing.
 */
import { useCallback, useMemo, useState } from "react";
import { Crosshair, FlaskConical, Grid3x3, Layers, LineChart, Radar } from "lucide-react";
import { useData } from "../state/DataContext.jsx";
import { cn } from "../lib/cn.js";
import { Badge } from "./ui/Badge.jsx";
import { GlassPanel } from "./ui/GlassPanel.jsx";
import { InfoTip } from "./ui/InfoTip.jsx";
import { SectionHeader } from "./ui/SectionHeader.jsx";
import { Skeleton } from "./ui/Skeleton.jsx";
import { EmptyState } from "./common/EmptyState.jsx";
import DependencePanel from "./shap/DependencePanel.jsx";
import ImportanceChart from "./shap/ImportanceChart.jsx";
import InteractionMatrix from "./shap/InteractionMatrix.jsx";
import ScenarioSimulator from "./shap/ScenarioSimulator.jsx";
import ThresholdCards from "./shap/ThresholdCards.jsx";
import { FEATURE_GROUPS, buildCurve } from "./shap/shapMath.js";

const ALL_GROUPS = FEATURE_GROUPS.map((g) => g.id);

/** Feature-group filter chips (multi-select toggle buttons + "All"). */
function GroupChips({ groups, onToggle, onAll }) {
  const all = groups.size === ALL_GROUPS.length;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter features by group">
      <button
        type="button"
        onClick={onAll}
        aria-pressed={all}
        className={cn(
          "focus-ring rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
          all ? "border-cyan/50 bg-cyan/10 text-ink-strong" : "border-panel-border text-ink-muted hover:text-ink",
        )}
      >
        All
      </button>
      {FEATURE_GROUPS.map((g) => {
        const on = groups.has(g.id);
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => onToggle(g.id)}
            aria-pressed={on}
            className={cn(
              "focus-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
              on
                ? "border-slate-400/40 bg-slate-800/70 text-ink"
                : "border-panel-border text-ink-faint hover:text-ink-muted",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("h-1.5 w-1.5 rounded-full transition-opacity", on ? "opacity-100" : "opacity-35")}
              style={{ backgroundColor: g.color }}
            />
            {g.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small panel heading used inside the glass panels. */
function PanelTitle({ icon: Icon, title, info, right }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold tracking-wide text-ink-strong">
        {Icon ? <Icon aria-hidden="true" className="h-4 w-4 text-cyan" /> : null}
        {title}
        {info ? <InfoTip content={info} label={`About: ${title}`} /> : null}
      </h3>
      {right}
    </div>
  );
}

function LoadingLayout() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(260px,300px)_minmax(0,1fr)_minmax(320px,380px)]" aria-busy="true">
      <Skeleton className="h-[520px] rounded-2xl" />
      <div className="space-y-4">
        <Skeleton className="h-[460px] rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
      <Skeleton className="h-[620px] rounded-2xl" />
    </div>
  );
}

export default function ShapDependenceViewer() {
  const {
    status,
    manifest,
    features,
    year,
    epoch,
    shapGlobal,
    dependence,
    interactions,
    zonesMeta,
    shapFeature,
    setShapFeature,
    uncertainty,
  } = useData();
  const ciLabel = uncertainty?.label ?? "95% CI";

  const [groups, setGroups] = useState(() => new Set(ALL_GROUPS));
  // Colour override is remembered per plotted feature: switching features falls back to that
  // feature's own strongest interaction partner.
  const [colorOverride, setColorOverride] = useState(null); // {feature, color}
  const [colorMode, setColorMode] = useState("partner");

  const metaByName = useMemo(() => new Map((features ?? []).map((f) => [f.name, f])), [features]);
  const feature = shapFeature && metaByName.has(shapFeature) ? shapFeature : (features?.[0]?.name ?? null);
  const meta = feature ? metaByName.get(feature) : null;
  const dep = feature ? (dependence?.features?.[feature] ?? null) : null;
  const curve = useMemo(() => buildCurve(dep), [dep]);

  const defaultPartner = dep?.scatter?.color_feature ?? null;
  const colorFeature = colorOverride && colorOverride.feature === feature ? colorOverride.color : defaultPartner;

  const toggleGroup = useCallback((id) => {
    setGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onSelectCell = useCallback(
    (row, col) => {
      setShapFeature(row);
      setColorMode("partner");
      setColorOverride(row === col ? null : { feature: row, color: col });
    },
    [setShapFeature],
  );

  const onColorFeatureChange = useCallback((name) => setColorOverride({ feature, color: name }), [feature]);

  if (status === "loading") return <LoadingLayout />;
  if (status !== "ready" || !manifest) {
    return (
      <EmptyState
        title="Threshold explorer unavailable"
        description="The web bundle has not been loaded. Run the notebook and copy outputs/web/* to dashboard/public/data/."
      />
    );
  }

  const partnerLabel = colorFeature ? (metaByName.get(colorFeature)?.label ?? colorFeature) : null;

  return (
    <div className="space-y-4">
      <SectionHeader
        eyebrow="Explainable AI · TreeSHAP"
        icon={Radar}
        title="Non-Linear Threshold Explorer"
        description="Where does each driver stop helping or start hurting? Dependence curves with bootstrap uncertainty, detected thresholds, pairwise interactions and a what-if simulator on the in-browser model."
        actions={
          <>
            {meta ? (
              <Badge variant="cyan" dot>
                {meta.label}
              </Badge>
            ) : null}
            {partnerLabel && colorMode === "partner" ? <Badge variant="violet">× {partnerLabel}</Badge> : null}
            {year ? <Badge variant="outline">epoch {year}</Badge> : null}
          </>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(260px,300px)_minmax(0,1fr)_minmax(320px,380px)]">
        {/* LEFT: importance */}
        <GlassPanel as="section" aria-label="Global SHAP importance" padding="sm" className="min-w-0 sm:p-4">
          <PanelTitle
            icon={Layers}
            title="Driver importance"
            info={`Mean absolute SHAP value (°C): the average size of each feature's contribution to predicted LST. Whiskers: ${uncertainty?.describe ?? "block-bootstrap intervals."} Click a feature to explore its dependence curve.`}
          />
          <div className="mb-3">
            <GroupChips groups={groups} onToggle={toggleGroup} onAll={() => setGroups(new Set(ALL_GROUPS))} />
          </div>
          <ImportanceChart
            shapGlobal={shapGlobal}
            metaByName={metaByName}
            zonesMeta={zonesMeta}
            year={year}
            groups={groups}
            selectedFeature={feature}
            onSelect={setShapFeature}
            ciLabel={ciLabel}
          />
        </GlassPanel>

        {/* CENTRE: dependence, thresholds, interactions */}
        <div className="min-w-0 space-y-4">
          <GlassPanel as="section" aria-label="SHAP dependence plot" padding="sm" className="sm:p-4">
            <PanelTitle
              icon={LineChart}
              title="Dependence & thresholds"
              info={`Each dot is one grid cell: its feature value (x) against that feature's SHAP contribution (y, °C, relative to the average cell's prediction). The line is the binned mean from the final model; the band is the bootstrap ${ciLabel} of the bin means. Dashed lines mark detected thresholds; shading shows their ${ciLabel}. SHAP describes the model, not causal effects.`}
            />
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
          </GlassPanel>

          <GlassPanel as="section" aria-label="Detected thresholds" padding="sm" className="sm:p-4">
            <PanelTitle
              icon={Crosshair}
              title="Threshold readout"
              info="Zero crossing: where the mean effect changes sign, i.e. where the feature's contribution equals that of the average cell (not reported when the curve crosses zero several times). Breakpoint: hinge of the best two-segment fit. Saturation: where the marginal effect falls below 10% of its peak. Effect range: span of the mean curve. Direction: sign of Spearman ρ(x, SHAP). Intervals are shown only next to a detected threshold."
            />
            {dep ? (
              <ThresholdCards meta={meta} threshold={dep.threshold ?? null} curve={curve} ciLabel={ciLabel} />
            ) : (
              <p className="text-xs text-ink-muted">No threshold analysis was exported for this feature.</p>
            )}
          </GlassPanel>

          <GlassPanel as="section" aria-label="SHAP interaction matrix" padding="sm" className="sm:p-4">
            <PanelTitle
              icon={Grid3x3}
              title="Interaction matrix"
              info="Mean |SHAP interaction value| between each feature pair (°C), from TreeSHAP interaction values. Large off-diagonal cells mean the effect of one feature depends on the level of the other. Click a cell to plot the row feature coloured by the column feature."
            />
            <InteractionMatrix
              interactions={interactions}
              metaByName={metaByName}
              zonesMeta={zonesMeta}
              selectedFeature={feature}
              colorFeature={colorMode === "partner" ? colorFeature : null}
              onSelectCell={onSelectCell}
            />
          </GlassPanel>
        </div>

        {/* RIGHT: scenario simulator (sticky on wide screens) */}
        <GlassPanel
          as="section"
          aria-label="Scenario simulator"
          glow="cyan"
          padding="sm"
          className="min-w-0 sm:p-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto"
        >
          <PanelTitle
            icon={FlaskConical}
            title="Scenario simulator"
            info="Perturb one actionable feature in a region and re-predict LST in your browser (in a background worker) with the exported surrogate model. Results are for the currently selected epoch and are model associations, not causal effects."
          />
          <ScenarioSimulator metaByName={metaByName} />
        </GlassPanel>
      </div>
    </div>
  );
}
