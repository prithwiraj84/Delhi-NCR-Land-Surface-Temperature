/**
 * TIMELINE route (UI_SPEC §3.5): 1990–2050 at a glance.
 *
 *   filter row   scope (NCR / district / zone) · metric · SSPs · annual context
 *   fans         Day and Night panels (shared x, synced crosshair, playhead cursor) | key figures
 *   atlas        every frame × mode on the fixed scale
 *   barcode      districts × frames  | day vs night dumbbell | future decomposition + budget
 *   ledger       sortable district table with sparkfans
 *   rank bump    | zone share 100 %  | threshold-crossing years
 *
 * Linking: chart cursors follow the playhead without re-rendering; clicking a chart's x sets
 * the year (snapped to the frame); hovering a district highlights it in every chart; picking
 * a district anywhere scopes the whole page (and the selection store, so the map follows).
 * v1 bundles: day only, no projections — every night / scenario panel says why it is empty.
 */
import { useEffect, useMemo, useState } from "react";
import { LineChart } from "lucide-react";
import { useAsset, useCube, useManifest, useResource, useSeries, useTimeline } from "../../data/hooks.js";
import { scopesOfKind } from "../../data/series.js";
import { modeAvailable, modeUnavailableReason } from "../../data/timeline.js";
import { useSelectionStore } from "../../state/stores/selectionStore.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { ScanSkeleton } from "../../components/ui/ScanSkeleton.jsx";
import { TierGlyph } from "../../components/ui/TierGlyph.jsx";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { FanChart } from "../../viz/FanChart.jsx";
import { fanTableRows, buildFanModel } from "../../viz/fanModel.js";
import { MODE_STYLE, sspStyle } from "../../viz/chartTheme.js";
import { SeriesLegend } from "../../viz/SeriesLegend.jsx";
import { ThermalBarcode } from "../../viz/ThermalBarcode.jsx";
import { Unavailable } from "../../viz/Unavailable.jsx";
import { fmt, fmtInterval, fmtSigned } from "../../lib/format.js";
import { AtlasStrip } from "./AtlasStrip.jsx";
import { DayNightDumbbell } from "./DayNightDumbbell.jsx";
import { DistrictLedger } from "./DistrictLedger.jsx";
import { FutureDecomposition } from "./FutureDecomposition.jsx";
import { KeyFigures } from "./KeyFigures.jsx";
import { RankBump } from "./RankBump.jsx";
import { ScopePicker } from "./ScopePicker.jsx";
import { ThresholdYearTable } from "./ThresholdYearTable.jsx";
import { ZoneShareArea } from "./ZoneShareArea.jsx";
import { barcodeDomain, barcodeRows, districtList, LEVELS_NOT_HARMONISED, ledgerRows, projectionAoa, snapshotYear } from "./timelineModel.js";

const SORTS = [
  { value: "name", label: "Name" },
  { value: "delta", label: "Δ" },
  { value: "end", label: "2050" },
  { value: "dtr", label: "DTR" },
];

/** Barcode sort options: Δ (a frame-to-frame level difference) is disabled on non-harmonised levels. */
const sortOptions = (harmonised) => SORTS.map((o) => (o.value === "delta" && !harmonised ? { ...o, disabled: true, reason: LEVELS_NOT_HARMONISED } : o));

/** One fan panel (a ChartTable with its table twin). */
function FanPanel({ scope, mode, metric, ssps, selectedSsp, showAnnual, timeline, unavailableReason }) {
  const s = useSeries(unavailableReason ? null : scope, mode);
  const data = s.status === "ready" ? s.data : null;
  const model = useMemo(() => buildFanModel({ series: data, metric, ssps, now: timeline.now, showAnnual }), [data, metric, ssps, timeline.now, showAnnual]);
  const rows = useMemo(() => fanTableRows(model, ssps), [model, ssps]);
  const unit = model.metric.unit;
  const status = unavailableReason ? { status: "unavailable", reason: unavailableReason } : s.status === "ready" ? { status: "ready" } : s;
  const label = `${MODE_STYLE[mode]?.label ?? mode} · ${model.metric.label}${unit ? ` (${unit})` : ""}`;
  return (
    <ChartTable
      title={<span style={{ color: MODE_STYLE[mode]?.accent }}>{`Fan · ${label}`}</span>}
      status={status}
      columns={[
        { key: "year", label: "Frame" },
        { key: "tier", label: "Tier", format: (v) => (v ? <TierGlyph tier={v} variant="short" /> : "—") },
        { key: "value", label: model.metric.label, align: "right", format: (v) => (Number.isFinite(v) ? (model.metric.signed ? fmtSigned(v, model.metric.dp) : fmt(v, model.metric.dp)) : "—") },
        { key: "ci", label: "Level CI", align: "right", format: (v) => (v ? fmtInterval(v) : "—") },
        ...ssps.map((id) => ({ key: `${id}_p50`, label: `${sspStyle(id).label} p50`, align: "right", format: (v, row) => (Number.isFinite(v) ? `${fmt(v, 1)} ${row[`${id}_range`] ? fmtInterval(row[`${id}_range`]) : ""}` : "—") })),
      ]}
      rows={rows}
      caption={`${label} of ${data?.label ?? scope}: observed frames with their evidence tier and level CI, and the projected p50 with its p5–p95 range per scenario.`}
    >
      <FanChart series={data} status="ready" mode={mode} metric={metric} ssps={ssps} selectedSsp={selectedSsp} showAnnual={showAnnual} now={timeline.now} xDomain={[timeline.first, timeline.last]} height={210} label={label} />
    </ChartTable>
  );
}

export function TimelineView() {
  const tl = useTimeline();
  const seriesRes = useResource("series");
  const timeline = tl.status === "ready" ? tl.data : null;
  const series = seriesRes.status === "ready" ? seriesRes.data : null;
  const selectedSsp = useTimeStore((s) => s.ssp);
  const year = useTimeStore((s) => s.year);
  const timeMode = useTimeStore((s) => s.mode);
  const districtId = useSelectionStore((s) => s.districtId);
  const [scope, setScopeState] = useState(() => (Number.isInteger(districtId) ? `d:${districtId}` : "ncr"));
  const [metric, setMetric] = useState("mean");
  const [showAnnual, setShowAnnual] = useState(true);
  const [sort, setSort] = useState("name");
  const scenarioIds = useMemo(() => timeline?.scenarioIds ?? [], [timeline]);
  const [ssps, setSsps] = useState(null);
  const shownSsps = ssps ?? scenarioIds;

  // Follow district picks made elsewhere (map, palette).
  useEffect(() => {
    if (Number.isInteger(districtId)) setScopeState(`d:${districtId}`);
  }, [districtId]);

  const setScope = (id) => {
    setScopeState(id);
    const m = /^d:(\d+)$/.exec(id);
    useSelectionStore.getState().setDistrict?.(m ? Number(m[1]) : null);
  };

  const districts = useMemo(() => (series ? districtList(series).map((d) => ({ id: d.id, label: d.label })) : []), [series]);
  const zones = useMemo(() => {
    if (!series) return [];
    const list = scopesOfKind(series, "zone", "day");
    return list.map((z) => ({ id: `z:${String(z.id).split(":").pop()}`, label: z.label }));
  }, [series]);

  const nightOk = modeAvailable(timeline, "night");
  const nightReason = nightOk ? null : modeUnavailableReason(timeline, "night");
  const dtrOk = modeAvailable(timeline, "dtr");
  const barMode = timeMode === "night" && nightOk ? "night" : "day";
  const snap = snapshotYear(timeline, year ?? timeline?.now);
  const ssp = scenarioIds.includes(selectedSsp) ? selectedSsp : scenarioIds[0] ?? null;

  const dayScope = useSeries(scope, "day");
  const nightScope = useSeries(nightOk ? scope : null, "night");
  const scopeLabel = dayScope.status === "ready" ? dayScope.data.label : scope === "ncr" ? "Delhi NCR" : scope;
  // AOA share of the horizon frame under the SELECTED SSP, shown with the projection copy (§9):
  // metrics.projection_meta first, else the SSP cube flags, else the observed share (labelled).
  // metrics.json is only requested when the bundle actually carries projections.
  const hasProjections = Boolean(timeline && timeline.projYears.length > 0 && scenarioIds.length > 0);
  const harmonised = timeline?.harmonised === true;
  const metricsRes = useAsset(hasProjections ? "metrics" : null);
  const metrics = metricsRes.status === "ready" ? metricsRes.data : null;
  const needCube = (m) => Boolean(metrics && timeline && ssp && !Number.isFinite(Number(metrics.projection_meta?.[m]?.[ssp]?.pct_outside_aoa?.[String(timeline.last)])));
  const dayCube = useCube(needCube("day") ? "day" : null, ssp ?? "obs");
  const nightCube = useCube(nightOk && needCube("night") ? "night" : null, ssp ?? "obs");
  const aoa = useMemo(
    () =>
      metrics && timeline
        ? {
            day: projectionAoa(metrics, "day", timeline.last, ssp, { cube: dayCube.status === "ready" ? dayCube.data : null }),
            night: nightOk ? projectionAoa(metrics, "night", timeline.last, ssp, { cube: nightCube.status === "ready" ? nightCube.data : null }) : null,
          }
        : null,
    [metrics, timeline, nightOk, ssp, dayCube, nightCube],
  );

  const ledger = useMemo(() => (series && timeline ? ledgerRows(series, { now: timeline.now, ssp, lastYear: timeline.last, nightAvailable: nightOk, harmonised }) : []), [series, timeline, ssp, nightOk, harmonised]);
  const barcode = useMemo(
    () => (series && timeline ? barcodeRows(series, { mode: barMode, ssp, years: timeline.years, referencePeriod: series.referencePeriod ?? timeline.referencePeriod, variable: "anom", now: timeline.now, sort, harmonised }) : []),
    [series, timeline, barMode, ssp, sort, harmonised],
  );
  const bDomain = useMemo(() => barcodeDomain(barcode, "anom"), [barcode]);
  const manifestRes = useManifest();
  const zonesMeta = useMemo(() => {
    const m = manifestRes.data?.manifestV2 ?? manifestRes.data?.manifest ?? null;
    const z = m?.zones;
    const list = Array.isArray(z) ? z : z?.[barMode];
    if (Array.isArray(list) && list.length) return list;
    return series ? scopesOfKind(series, "zone", barMode).map((sc) => ({ id: Number(String(sc.id).split(":").pop()), name: sc.label, color: sc.color })) : [];
  }, [manifestRes, series, barMode]);

  if (tl.status !== "ready") {
    return (
      <div className="p-4">
        {tl.status === "loading" ? <ScanSkeleton label="Loading the timeline" height={240} /> : <Unavailable status={tl.status} reason={tl.reason} />}
      </div>
    );
  }

  const fanModes = metric === "dtr" ? ["dtr"] : ["day", "night"];
  const tiersSeen = [...new Set(timeline.frames.flatMap((f) => [f.day.tier, f.night.tier]).filter((t) => t && t !== "projected"))];
  const barcodeTitle = harmonised
    ? `Thermal barcode · ${barMode} anomaly vs ${series?.referencePeriod ? `${series.referencePeriod[0]}–${series.referencePeriod[1]}` : "reference"} mean`
    : `Thermal barcode · ${barMode} district − NCR mean of the same frame`;

  return (
    <div className="mx-auto w-full max-w-[1680px] space-y-3 px-3 pb-10 pt-4 sm:px-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="micro-label flex items-center gap-1.5">
            <LineChart aria-hidden="true" className="size-3.5 text-signal" /> Timeline
          </p>
          <h1 className="font-display text-2xl font-semibold text-ink-strong">
            {timeline.first}–{timeline.last} · {scopeLabel}
          </h1>
          <p className="max-w-3xl text-sm text-ink-muted">
            Observed frames carry their evidence tier; projections are a model + CMIP6 scenario, not observations. Click any chart to move the map to that frame.
          </p>
        </div>
        <ScopePicker
          scope={scope}
          onScope={setScope}
          districts={districts}
          zones={zones}
          metric={metric}
          onMetric={setMetric}
          dtrAvailable={dtrOk}
          dtrReason={modeUnavailableReason(timeline, "dtr")}
          scenarios={timeline.scenarios}
          ssps={shownSsps}
          onSsps={setSsps}
          showAnnual={showAnnual}
          onShowAnnual={setShowAnnual}
        />
      </header>

      <SeriesLegend tiers={tiersSeen} ssps={shownSsps} selectedSsp={ssp} accent={MODE_STYLE.day.accent} showAnnual={showAnnual} />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          {fanModes.map((m) => (
            <FanPanel key={m} scope={scope} mode={m} metric={metric} ssps={shownSsps} selectedSsp={ssp} showAnnual={showAnnual} timeline={timeline} unavailableReason={m === "night" ? nightReason : m === "dtr" && !dtrOk ? modeUnavailableReason(timeline, "dtr") : null} />
          ))}
        </div>
        <KeyFigures
          day={dayScope.status === "ready" ? dayScope.data : null}
          night={nightScope.status === "ready" ? nightScope.data : null}
          nightReason={nightReason ?? (nightScope.status === "unavailable" ? nightScope.reason : null)}
          now={timeline.now}
          last={timeline.last}
          ssps={shownSsps}
          selectedSsp={ssp}
          scopeLabel={scopeLabel}
          projections={hasProjections}
          aoa={aoa}
          harmonised={harmonised}
        />
      </div>

      <AtlasStrip ssp={ssp} />

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <ChartTable
          title={barcodeTitle}
          status={series ? { status: barcode.length ? "ready" : "unavailable", reason: "No district series in this bundle." } : seriesRes}
          actions={<Segmented ariaLabel="Sort barcode rows" size="sm" value={harmonised || sort !== "delta" ? sort : "name"} onChange={setSort} options={sortOptions(harmonised)} layoutId="barcode-sort" />}
          columns={[{ key: "label", label: "District" }, ...timeline.years.map((y) => ({ key: String(y), label: String(y), align: "right", format: (v) => fmtSigned(v, 1) }))]}
          rows={barcode.map((r) => ({ id: r.id, label: r.label, ...Object.fromEntries(r.cells.map((c) => [String(c.year), c.value])) }))}
          caption={
            harmonised
              ? `District mean minus its own reference-period mean, °C, per frame (projected frames: ${ssp ?? "—"} p50).`
              : `District mean minus the NCR mean of the same frame, °C (levels are not harmonised across sensors, so frames are not compared with each other).`
          }
          className="lg:col-span-2 2xl:col-span-1"
        >
          <ThermalBarcode rows={barcode} years={timeline.years} xDomain={[timeline.first, timeline.last]} domain={bDomain} ramp="polar" now={timeline.now} selectedId={scope} onSelectRow={setScope} valueLabel="Anomaly" ariaLabel="Thermal barcode of district anomalies" />
          <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="font-mono">{fmtSigned(bDomain[0], 1)}</span>
            <span aria-hidden="true" className="h-2 w-28 rounded-sm" style={{ backgroundImage: "var(--ramp-polar)" }} />
            <span className="font-mono">{fmtSigned(bDomain[1], 1)} °C</span>
            <span>{harmonised ? "cooler ↔ warmer than the district's reference mean · hatched = projected" : "cooler ↔ warmer than the NCR mean of the same frame"}</span>
          </div>
        </ChartTable>
        <DayNightDumbbell series={series} year={snap} nightReason={nightReason} onSelect={setScope} />
        <FutureDecomposition series={dayScope.status === "ready" ? (barMode === "night" && nightScope.status === "ready" ? nightScope.data : dayScope.data) : null} ssps={shownSsps} projYears={timeline.projYears} scopeLabel={scopeLabel} mode={barMode} reason={scenarioIds.length ? null : "No projections in this bundle — rerun notebook v2."} />
      </div>

      {series ? (
        <DistrictLedger rows={ledger} now={timeline.now} first={timeline.first} last={timeline.last} ssp={ssp} nightAvailable={nightOk} harmonised={harmonised} projections={hasProjections} selectedScope={scope} onSelect={setScope} />
      ) : (
        <Unavailable status={seriesRes.status} reason={seriesRes.reason} />
      )}

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <RankBump series={series} mode={barMode} years={timeline.years} metric="mean" ssp={ssp} now={timeline.now} selectedScope={scope} onSelect={setScope} />
        <ZoneShareArea series={series} mode={barMode} ssp={ssp} zonesMeta={zonesMeta} now={timeline.now} />
        <ThresholdYearTable series={series} mode={barMode} ssps={shownSsps} selectedScope={scope} reason={scenarioIds.length ? null : "No projections in this bundle — rerun notebook v2."} last={timeline.last} />
      </div>
    </div>
  );
}

export default TimelineView;
