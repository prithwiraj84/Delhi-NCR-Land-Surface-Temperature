/**
 * Inspector · cell block (UI_SPEC_v2 §3.4):
 *
 *   CELL #48211 · 28.46N 77.03E · Zone 3 Heat Extreme Core
 *   Obs 41.2 · Pred 40.8 · OOF resid +0.4      headline from the MANIFEST tier (D22 e): "Obs" ●
 *                                              only for observed tiers, "Reconstructed" ◐,
 *                                              "Map (modelled)" ◇, "<SSP> p50" ○, "DTR"
 *   ▸ SHAP waterfall (Day | Night tabs)
 *   ▸ Feature values (n) with p-ranks
 *   ▸ Cell timeline 1990–2050 (from cubes)
 *   AOA ✓ inside
 *   ▸ 250 m: 40.1–43.0 °C within this cell
 *   [Open in Drivers →] [Simulate →] [⤓ CSV]
 *
 * States: cell (exact XAI frame), xai-unavailable ("drivers exist for frames with XAI:
 * 2010–2025" + a button to the nearest XAI frame), interpolated (values need an exact frame).
 * Keyboard cell walking: focus the cell header and use the arrow keys to move to the
 * neighbouring 1 km cell (UI_SPEC §12 map alternative).
 */
import { useMemo, useState } from "react";
import { TierShape } from "../../../design/glyphs.jsx";
import { ZoneLabelCaveat } from "../../../components/zones/ZoneLabelCaveat.jsx";
import { SCENARIO_PRESETS } from "../../../lib/scenarioPresets.js";
import { announce } from "../../../shell/announcer.js";
import { useData } from "../../../state/DataContext.jsx";
import { ArrowRight, Download, FlaskConical, Move } from "lucide-react";
import { Segmented } from "../../../components/ui/Segmented.jsx";
import { CellWaterfall, WaterfallSumCheck } from "../../../components/map/CellWaterfall.jsx";
import { useAsset, useCellTimeline, useCells, useCube, useFrameValues, useRaster, useXai, useZonesCube } from "../../../data/hooks.js";
import { rasterRangeInBox } from "../../../data/rasters.js";
import { frameAt, seriesForYear, tierOf, xaiYears } from "../../../data/timeline.js";
import { cellWaterfall } from "../../../data/xai.js";
import { cn } from "../../../lib/cn.js";
import { featureLabel, featureMeta, fmt, fmtSigned, fmtSsp } from "../../../lib/format.js";
import { useSelectionStore } from "../../../state/stores/selectionStore.js";
import { useTimeStore } from "../../../state/stores/timeStore.js";
import { useViewStore } from "../../../state/stores/viewStore.js";
import { cellBox, cellHeadline, cellTimelineCsv, neighbourIndex, waterfallForCell } from "../controlModel.js";
import { zoneEntries } from "../layerModel.js";
import { AoaBadge } from "./AoaBadge.jsx";
import { CellTimeline } from "./CellTimeline.jsx";
import { FeatureTable } from "./FeatureTable.jsx";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

function Readout({ label, value, emphasis = false, tier = null }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label flex items-center gap-1 truncate">
        {tier && <TierShape tier={tier} size={9} data-testid={`tier-${tier}`} />}
        {label}
      </dt>
      <dd className={cn("tnum truncate font-mono", emphasis ? "text-[15px] font-semibold text-ink-strong" : "text-[13px] text-ink")}>{value}</dd>
    </div>
  );
}

function Expander({ title, children, onToggle, defaultOpen = false }) {
  return (
    <details className="group border-t border-hairline pt-1.5" open={defaultOpen} onToggle={(e) => onToggle?.(e.currentTarget.open)}>
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-1.5 rounded py-0.5 text-[12px] text-ink marker:hidden">
        <ArrowRight aria-hidden="true" className="size-3 transition-transform duration-quick group-open:rotate-90" />
        {title}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

function downloadText(name, text) {
  try {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.warn("[inspector] CSV download failed", error);
  }
}

/** Waterfall of one mode for the pinned cell, with v2 group labels or v1 feature labels. */
function WaterfallFor({ xai, index, manifest }) {
  const groups = manifest?.groups ?? null;
  const groupById = useMemo(() => new Map((groups ?? []).map((g) => [g.id, g])), [groups]);
  const wf = useMemo(() => {
    if (!xai) return null;
    const raw = cellWaterfall(xai, index);
    const valueOf = (g) => {
      const primary = groupById.get(g)?.primary ?? g;
      return xai.features?.[primary]?.[index];
    };
    return waterfallForCell(raw, valueOf);
  }, [xai, index, groupById]);
  const labelOf = useMemo(() => (groups ? (g) => groupById.get(g)?.label ?? g : (n) => featureLabel(manifest, n)), [groups, groupById, manifest]);
  const metaOf = useMemo(() => (groups ? (g) => featureMeta(manifest, groupById.get(g)?.primary ?? g) : (n) => featureMeta(manifest, n)), [groups, groupById, manifest]);
  if (!wf) return <p className="text-[12px] text-ink-muted">No SHAP values for this cell.</p>;
  return (
    <>
      <CellWaterfall waterfall={wf} manifest={manifest} topN={8} labelOf={labelOf} metaOf={metaOf} />
      <WaterfallSumCheck waterfall={wf} />
    </>
  );
}

/**
 * @param {{index:number, t:number, mode:string, ssp:string|null, timeline:object, manifest:object|null,
 *          districtName?: string|null}} props
 */
export function CellSummary({ index, t, mode, ssp, timeline, manifest, districtName }) {
  const cells = useCells();
  const { setScenario, presets } = useData() ?? {};
  const exact = Number.isInteger(t) || Math.abs(t - Math.round(t)) < 1e-6;
  const frame = exact ? frameAt(timeline, Math.round(t)) : null;
  const year = frame?.year ?? null;
  const xaiMode = mode === "dtr" ? "day" : mode;
  const [tab, setTab] = useState(xaiMode);
  const [rasterOpen, setRasterOpen] = useState(false);
  const [walkStatus, setWalkStatus] = useState("");
  const xaiDay = useXai(year, "day");
  const xaiNight = useXai(timeline.modeIds.includes("night") ? year : null, "night");
  const xai = xaiMode === "night" ? xaiNight : xaiDay;
  const values = useFrameValues(year, mode, ssp);
  const zones = useZonesCube(mode === "dtr" ? null : mode);
  const series = year !== null ? seriesForYear(timeline, year, ssp) : null;
  const cube = useCube(year !== null && mode !== "dtr" ? mode : null, series ?? "obs");
  const metrics = useAsset("metrics");
  const rasterKey = rasterOpen && year !== null && frame?.raster?.[xaiMode] ? `${xaiMode}_${year}` : null;
  const raster = useRaster(rasterKey);
  const cellTl = useCellTimeline(index, mode);

  const c = cells.status === "ready" ? cells.data : null;
  if (!c) return <p className="scan-skeleton h-24" aria-label="Loading the cell" />;
  const lon = c.lon[index];
  const lat = c.lat[index];
  const cellId = c.cell_id[index];
  const res = Number(c.grid?.res) || 1000;

  // Zone of the cell at this frame (obs or the selected SSP series).
  let zone = null;
  if (zones.status === "ready" && year !== null) {
    const s = zones.data.series?.[series === "obs" || !series ? "obs" : series];
    const f = s ? s.years.indexOf(year) : -1;
    const z = f >= 0 ? s.values[f * s.n + index] : 255;
    if (z !== 255 && z !== undefined) zone = zoneEntries(manifest, mode === "dtr" ? "day" : mode).find((e) => e.id === z) ?? { id: z, label: `Zone ${z}` };
  }

  // AOA verdict from the frame's cube.
  let outside = null;
  if (cube.status === "ready" && year !== null) {
    const f = cube.data.years.indexOf(year);
    const col = cube.data.columns.aoa_out ?? cube.data.columns.flags;
    if (f >= 0 && col) outside = Boolean(col.name === "flags" ? col.raw[f * cube.data.n + index] & 1 : col.raw[f * cube.data.n + index]);
  }
  const threshold = metrics.status === "ready" ? Number(metrics.data?.modes?.[xaiMode]?.aoa?.di_threshold) : NaN;
  const lst = values.status === "ready" ? values.data.values[index] : NaN;
  const x = xai.status === "ready" ? xai.data : null;
  const xaiList = xaiYears(timeline, xaiMode);
  const nearestXai = xaiList.length ? xaiList.reduce((best, y) => (Math.abs(y - t) < Math.abs(best - t) ? y : best), xaiList[0]) : null;
  const range = raster.status === "ready" ? rasterRangeInBox(raster.data, cellBox(lon, lat, res)) : null;

  const walk = (e) => {
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const next = neighbourIndex(c, index, d[0], d[1]);
    if (next < 0) {
      setWalkStatus("Edge of the study area");
      return;
    }
    useSelectionStore.getState().pin(next);
    useSelectionStore.getState().setDistrict(Number(c.district[next]));
    const v = values.status === "ready" ? values.data.values[next] : NaN;
    setWalkStatus(`Cell ${c.cell_id[next]}${finite(v) ? `, ${fmt(v, 1)} degrees` : ""}`);
  };

  const csv = () => {
    if (cellTl.status !== "ready") return;
    const text = cellTimelineCsv({ cellId, mode, lon, lat, district: districtName ?? c.district[index], obs: cellTl.data.obs, ssp: cellTl.data.ssp });
    downloadText(`ncr_cell_${cellId}_${mode}.csv`, text);
  };
  const toDrivers = () => {
    if (nearestXai !== null && nearestXai !== year) useTimeStore.getState().setYear(nearestXai);
    useViewStore.getState().setRoute("drivers");
  };
  // Simulate: the what-if region becomes the pinned cell's district; the year moves to the nearest
  // XAI frame (as "Open in Drivers" does) and the simulator opens on the Drivers route.
  const simulate = () => {
    const districtId = Number(c.district[index]);
    const name = districtName ?? manifest?.districts?.find?.((d) => Number(d.id) === districtId)?.name ?? `district ${districtId}`;
    setScenario?.((prev) => ({ ...(prev ?? presets?.[0]?.scenario ?? SCENARIO_PRESETS[0].scenario), region: { type: "district", ids: [districtId] } }));
    if (nearestXai !== null && nearestXai !== year) useTimeStore.getState().setYear(nearestXai);
    useViewStore.getState().setRoute("drivers");
    announce(`Simulator region set to ${name} from the inspector`);
  };
  const headline = cellHeadline({
    frameKind: frame?.kind ?? "observed",
    tier: mode === "dtr" ? tierOf(timeline, year, "dtr") : frame?.[mode]?.tier ?? (values.status === "ready" ? values.data.tier : null) ?? x?.tier ?? null,
    mode,
    sspLabel: fmtSsp(ssp),
    obs: mode === "dtr" ? NaN : x?.obs?.[index],
    map: lst,
    pred: x?.pred?.[index],
  });

  return (
    <section aria-label={`Cell ${cellId}`} className="space-y-2">
      <div
        tabIndex={0}
        role="group"
        aria-label={`Cell ${cellId}. Arrow keys move to the neighbouring cell.`}
        onKeyDown={walk}
        className="focus-ring rounded-md"
      >
        <p className="micro-label flex items-center gap-1.5">
          Cell <Move aria-hidden="true" className="size-3" strokeWidth={1.5} />
        </p>
        <p className="font-mono text-[13px] text-ink-strong">
          #{cellId} <span className="text-ink-muted">· {fmt(lat, 2)}N {fmt(lon, 2)}E</span>
        </p>
        {zone && (
          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink">
            <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ background: zone.color }} />
            Zone {zone.id} · {zone.label}
            {zone.caveat && <ZoneLabelCaveat caveat={zone.caveat} name={zone.label} />}
          </p>
        )}
        <span role="status" className="sr-only">
          {walkStatus}
        </span>
      </div>

      {year === null ? (
        <p className="text-[12px] text-ink-muted">Cell values need an exact frame — release the playhead on a frame (≈ positions are interpolated).</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 rounded-md bg-surface-2/70 p-2" data-testid="cell-readout">
            <Readout label={headline.label} tier={headline.tier} value={finite(headline.value) ? fmt(headline.value, 1) : "—"} emphasis />
            {headline.showPred ? <Readout label={headline.predLabel} value={finite(x?.pred?.[index]) ? fmt(x.pred[index], 1) : "—"} /> : <Readout label={headline.predLabel} value="= map" />}
            <Readout label={headline.residLabel} value={finite(x?.resid?.[index]) ? fmtSigned(x.resid[index], 2) : "—"} />
          </dl>
          {headline.note && <p className="text-[11px] leading-snug text-ink-faint">{headline.note}</p>}
        </>
      )}

      {year !== null && !x && xai.status !== "loading" && (
        <p className="text-[12px] text-ink-muted">
          {xai.reason ?? "No drivers for this frame."}{" "}
          {nearestXai !== null && nearestXai !== year && (
            <button type="button" onClick={() => useTimeStore.getState().setYear(nearestXai)} className="focus-ring rounded px-1 text-signal underline-offset-2 hover:underline">
              Go to {nearestXai}
            </button>
          )}
        </p>
      )}

      {x && (
        <Expander title="SHAP waterfall" defaultOpen>
          {timeline.modeIds.includes("night") && (
            <Segmented
              ariaLabel="Waterfall mode"
              layoutId={`wf-tab-${index}`}
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "day", label: "Day", disabled: xaiDay.status !== "ready", reason: xaiDay.reason ?? undefined },
                { value: "night", label: "Night", disabled: xaiNight.status !== "ready", reason: xaiNight.reason ?? undefined },
              ]}
              className="mb-1.5"
            />
          )}
          <WaterfallFor xai={tab === "night" && xaiNight.status === "ready" ? xaiNight.data : xaiDay.status === "ready" ? xaiDay.data : x} index={index} manifest={manifest} />
        </Expander>
      )}
      {x && Object.keys(x.features ?? {}).length > 0 && (
        <Expander title={`Feature values (${Object.keys(x.features).length}) with p-ranks`}>
          <FeatureTable xai={x} index={index} manifest={manifest} />
        </Expander>
      )}
      <Expander title={`Cell timeline ${timeline.first}–${timeline.last}`}>
        <CellTimeline index={index} mode={mode} ssp={ssp} timeline={timeline} t={t} />
      </Expander>
      <AoaBadge outside={timeline.schema === "v1" ? null : outside} threshold={finite(threshold) ? threshold : null} reason={timeline.schema === "v1" ? "is not in a v1 bundle — rerun notebook v2" : null} />
      {year !== null && frame?.raster?.[xaiMode] && (
        <Expander title="250 m detail within this cell" onToggle={setRasterOpen}>
          {raster.status === "loading" ? (
            <p className="scan-skeleton h-4" aria-label="Loading the 250 m raster" />
          ) : range ? (
            <p className="tnum font-mono text-[12px] text-ink">
              250 m: {fmt(range.min, 1)}–{fmt(range.max, 1)} °C within this cell <span className="text-ink-muted">({range.count} px{xaiMode === "night" ? ", downscaled" : ""})</span>
            </p>
          ) : (
            <p className="text-[12px] text-ink-muted">{raster.reason ?? "No valid 250 m pixels in this cell."}</p>
          )}
        </Expander>
      )}

      <div className="flex flex-wrap gap-1.5 border-t border-hairline pt-2">
        <button type="button" onClick={toDrivers} className="focus-ring inline-flex h-8 items-center gap-1 rounded-md border border-control px-2 text-[12px] text-ink hover:bg-surface-3">
          Open in Drivers <ArrowRight aria-hidden="true" className="size-3.5" />
        </button>
        <button type="button" onClick={simulate} className="focus-ring inline-flex h-8 items-center gap-1 rounded-md border border-control px-2 text-[12px] text-ink hover:bg-surface-3">
          <FlaskConical aria-hidden="true" className="size-3.5" strokeWidth={1.5} /> Simulate
        </button>
        <button type="button" onClick={csv} disabled={cellTl.status !== "ready"} className="focus-ring inline-flex h-8 items-center gap-1 rounded-md border border-control px-2 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-50">
          <Download aria-hidden="true" className="size-3.5" strokeWidth={1.5} /> CSV
        </button>
      </div>
    </section>
  );
}

export default CellSummary;
