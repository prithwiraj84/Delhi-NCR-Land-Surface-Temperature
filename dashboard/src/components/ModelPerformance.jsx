/**
 * Model Performance & Spatial CV (view "performance").
 *
 * Reads `metrics.json` (SPEC §4.7) and answers, in order:
 *   1. How good is the model where it matters?  KPI tiles lead with the best SPATIAL-block
 *      CV R² (the honest estimate for unseen areas), its RMSE/MAE, the temporal hold-out
 *      R², residual Moran's I and the optimism gap of random CV.
 *   2. What does that mean?  Plain-language callouts derived from the same numbers.
 *   3. How do the six models compare under each scheme?  Grouped bars (mean ± 1 SD across
 *      folds) beside a per-fold strip plot in the same model × scheme slots.
 *   4. Exact numbers: a sortable TanStack table with the best model per scheme marked.
 *   5. Is spatial structure left in the errors?  Residual Moran's I per model against the
 *      target's own I, and the Moran scatter (z vs spatial lag, slope = I, LISA quadrants).
 *   6. What did it run on?  GPUs, devices, RAPIDS and stage timings.
 *
 * Everything is derived with pure helpers in ./performance/perfModel.js. `metrics` is an
 * optional asset: when it is null (or partially empty) each panel renders an explanation
 * instead of failing.
 */
import { useMemo, useState } from "react";
import { Activity, BarChart3, Cpu, Radar, Table2 } from "lucide-react";
import { useData } from "../state/DataContext.jsx";
import { Badge } from "./ui/Badge.jsx";
import { GlassPanel } from "./ui/GlassPanel.jsx";
import { SectionHeader } from "./ui/SectionHeader.jsx";
import { Skeleton } from "./ui/Skeleton.jsx";
import { EmptyState } from "./common/EmptyState.jsx";
import SegmentedToggle from "./shap/SegmentedToggle.jsx";
import { ChartLegend } from "./performance/ChartTooltip.jsx";
import { FoldStripPlot } from "./performance/FoldStripPlot.jsx";
import { GroupedBarChart } from "./performance/GroupedBarChart.jsx";
import { HardwareCard } from "./performance/HardwareCard.jsx";
import { InterpretationCallouts } from "./performance/InterpretationCallouts.jsx";
import { KpiStrip } from "./performance/KpiStrip.jsx";
import { MoranPanel } from "./performance/MoranPanel.jsx";
import { PanelTitle } from "./performance/PanelTitle.jsx";
import { SummaryTable } from "./performance/SummaryTable.jsx";
import {
  bestModelsByScheme,
  buildInterpretations,
  deriveKpis,
  foldPoints,
  groupedMetricData,
  hardwareInfo,
  listModels,
  listSchemes,
  metricMeta,
  METRICS,
  schemeMeta,
  summaryMeans,
  summaryTableRows,
} from "./performance/perfModel.js";

function LoadingLayout() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading model performance">
      <Skeleton className="h-16 w-2/3 rounded-xl" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[380px] rounded-2xl" />
      <Skeleton className="h-[320px] rounded-2xl" />
    </div>
  );
}

function lastEpochOf(manifest) {
  const years = (manifest?.epochs ?? []).map(Number).filter(Number.isFinite);
  return years.length ? Math.max(...years) : null;
}

export default function ModelPerformance() {
  const { status, manifest, metrics } = useData();
  const [metricKey, setMetricKey] = useState("r2");

  const models = useMemo(() => listModels(metrics), [metrics]);
  const schemes = useMemo(() => listSchemes(metrics), [metrics]);
  const kpis = useMemo(() => deriveKpis(metrics), [metrics]);
  const lastEpoch = lastEpochOf(manifest);
  const callouts = useMemo(() => buildInterpretations(metrics, kpis, lastEpoch), [metrics, kpis, lastEpoch]);
  const metric = metricMeta(metricKey);
  const grouped = useMemo(() => groupedMetricData(metrics, metricKey), [metrics, metricKey]);
  const bestByScheme = useMemo(
    () => bestModelsByScheme(metrics?.summary, schemes, metricKey),
    [metrics, schemes, metricKey],
  );
  const points = useMemo(() => foldPoints(metrics, metricKey), [metrics, metricKey]);
  const means = useMemo(() => summaryMeans(metrics, metricKey), [metrics, metricKey]);
  const tableRows = useMemo(() => summaryTableRows(metrics), [metrics]);
  const hardware = useMemo(() => hardwareInfo(metrics), [metrics]);

  if (status === "loading") return <LoadingLayout />;
  if (status !== "ready" || !manifest) {
    return (
      <EmptyState
        title="Model diagnostics unavailable"
        description="The web bundle has not been loaded. Run the notebook and copy outputs/web/* to dashboard/public/data/."
      />
    );
  }

  const header = (
    <SectionHeader
      eyebrow="Validation · triple cross-validation"
      icon={Activity}
      title="Model Performance & Spatial CV"
      description="Six models scored three ways - random K-fold, spatial-block and temporal hold-out - with residual spatial autocorrelation. Spatial-block CV is the honest estimate of skill in places the model has not seen."
      actions={
        metrics ? (
          <>
            <Badge variant="cyan" dot>
              {models.length} models
            </Badge>
            <Badge variant="outline">{schemes.length} schemes</Badge>
            {lastEpoch ? <Badge variant="outline">temporal test {lastEpoch}</Badge> : null}
          </>
        ) : null
      }
    />
  );

  if (!metrics) {
    return (
      <div className="space-y-4">
        {header}
        <GlassPanel>
          <EmptyState
            compact
            icon={BarChart3}
            title="No validation metrics in this bundle"
            description="metrics.json is missing or failed to load. It is written by notebook section 05 from the cross-validation (03) results; re-export the web bundle to populate this view."
          />
        </GlassPanel>
      </div>
    );
  }

  const hasSummary = tableRows.length > 0;
  const metricOptions = METRICS.map((m) => ({ value: m.key, label: m.label, title: m.description }));
  const schemeLegend = schemes.map((s) => ({ key: s, label: schemeMeta(s).long, color: schemeMeta(s).color }));

  return (
    <div className="space-y-4">
      {header}

      {hasSummary ? (
        <KpiStrip kpis={kpis} />
      ) : (
        <GlassPanel padding="sm">
          <p className="text-xs text-ink-muted">metrics.json has no cross-validation summary rows.</p>
        </GlassPanel>
      )}

      <InterpretationCallouts items={callouts} />

      {hasSummary && (
        <GlassPanel as="section" aria-labelledby="perf-skill-title" padding="sm" className="sm:p-4">
          <PanelTitle
            id="perf-skill-title"
            icon={BarChart3}
            title="Skill by model and validation scheme"
            info="Bars show the mean across folds with ±1 standard deviation whiskers. Random K-fold mixes neighbouring cells between train and test; spatial-block CV holds out whole 5×5 blocks; the temporal hold-out trains on earlier epochs and tests the last one."
            subtitle={`${metric.description} ${metric.better === "higher" ? "Higher is better." : "Lower is better."}`}
            right={
              <SegmentedToggle
                label="Metric"
                options={metricOptions}
                value={metricKey}
                onChange={setMetricKey}
                layoutId="perf-metric"
              />
            }
          />
          <ChartLegend items={schemeLegend} label="Validation schemes" className="mb-2" />
          <div className="grid gap-5 xl:grid-cols-2">
            <div className="min-w-0">
              <h4 className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Mean ± 1 SD across folds</h4>
              <GroupedBarChart rows={grouped} schemes={schemes} metric={metric} bestByScheme={bestByScheme} />
            </div>
            <div className="min-w-0">
              <h4 className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">
                Per-fold scores · tick = fold mean
              </h4>
              {points.length ? (
                <FoldStripPlot points={points} models={models} schemes={schemes} metric={metric} means={means} height={300} />
              ) : (
                <p className="py-10 text-center text-xs text-ink-muted">No per-fold scores were exported.</p>
              )}
            </div>
          </div>
        </GlassPanel>
      )}

      {hasSummary && (
        <GlassPanel as="section" aria-labelledby="perf-table-title" padding="sm" className="sm:p-4">
          <PanelTitle
            id="perf-table-title"
            icon={Table2}
            title="Cross-validation summary"
            tone="violet"
            info="Mean ± standard deviation across folds. The temporal scheme has a single fold (train on earlier epochs, test the last), so its SD may be empty."
          />
          <SummaryTable rows={tableRows} schemes={schemes} />
        </GlassPanel>
      )}

      <GlassPanel as="section" aria-labelledby="perf-moran-title" padding="sm" className="sm:p-4">
        <PanelTitle
          id="perf-moran-title"
          icon={Radar}
          title="Spatial autocorrelation of residuals"
          tone="rose"
          info="Moran's I measures whether neighbouring cells (8 nearest neighbours, row-standardised) have similar values. For out-of-fold residuals it should be near zero: a significantly positive I means errors cluster in space and a spatial process is missing from the model. p-values come from a permutation test."
        />
        <MoranPanel metrics={metrics} />
      </GlassPanel>

      <GlassPanel as="section" aria-labelledby="perf-hw-title" padding="sm" className="sm:p-4">
        <PanelTitle id="perf-hw-title" icon={Cpu} title="Hardware & timings" tone="violet" />
        <HardwareCard hardware={hardware} timings={metrics.timings} />
      </GlassPanel>
    </div>
  );
}
