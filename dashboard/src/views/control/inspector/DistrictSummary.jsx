/**
 * Inspector · district block (UI_SPEC_v2 §3.4):
 *
 *   DISTRICT · Gurugram (Haryana)                         ⌖ fly to   ✕
 *   38.1 °C  Day 2025 ● Observed     +0.4 vs NCR
 *   ┌ Day   ◒──●──●──●──●──┃╱▔▔  ┐  two stacked mini panels, shared x,
 *   └ Night ◇──◇──●──●──●──┃╱▔▔  ┘  SSP fan only in the selected SSP
 *   DTR 13.2 °C · Surface UHI (urban − rural) rank 4/25
 *
 * Values are the notebook's district scope statistics (timeline_series); tiers per frame come
 * from the manifest. Interpolated years show "≈" and the bracket.
 */
import { Crosshair, X } from "lucide-react";
import { TierShape } from "../../../design/glyphs.jsx";
import { normalizeTier, TIER_META } from "../../../design/tiers.js";
import { Delta } from "../../../components/ui/Delta.jsx";
import { useResource, useSeries } from "../../../data/hooks.js";
import { scopeBaseline, scopesOfKind, scopeSeries, seriesValueAt } from "../../../data/series.js";
import { frameTierInfo, tierOf } from "../../../data/timeline.js";
import { fmt, fmtSigned, fmtSsp } from "../../../lib/format.js";
import { useSelectionStore } from "../../../state/stores/selectionStore.js";
import { SHELL_EVENTS } from "../../../shell/actions.js";
import { districtRank } from "../controlModel.js";
import { MiniFanChart } from "./MiniFanChart.jsx";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

function panelFor(series, timeline, mode, ssp, label) {
  if (!series) return { id: mode, label, frames: [], fan: null, unavailable: `no ${mode} series` };
  return {
    id: mode,
    label,
    frames: series.frames.map((f) => ({ year: f.year, value: f.mean, tier: tierOf(timeline, f.year, mode) ?? f.tier })),
    fan: ssp ? series.ssp?.[ssp] ?? null : null,
    // The fan opens from the scope's weather-normalised baseline (D14), not the observed NOW frame.
    baseline: ssp ? scopeBaseline(series, ssp)?.base ?? null : null,
  };
}

/** Value of a scope at a (possibly fractional) year: exact record, or a flagged linear mix. */
function valueAt(series, timeline, t, ssp) {
  const info = frameTierInfo(timeline, t, series?.mode ?? "day", ssp);
  if (!series || !info) return null;
  const b = info.bracket;
  const a = seriesValueAt(series, b.yA, ssp);
  if (info.exact) return a ? { ...a, interpolated: false } : null;
  const c = seriesValueAt(series, b.yB, ssp);
  if (!a || !c || !finite(a.mean) || !finite(c.mean)) return null;
  return { mean: a.mean + (c.mean - a.mean) * b.mix, interpolated: true, bracket: b };
}

/**
 * @param {{districtId:number, district: {name:string, state?:string}|null, t:number, mode:string,
 *          ssp:string|null, timeline:object}} props
 */
export function DistrictSummary({ districtId, district, t, mode, ssp, timeline }) {
  const scope = `d:${districtId}`;
  const day = useSeries(scope, "day");
  const night = useSeries(scope, "night");
  const ncr = useSeries("ncr", mode);
  const series = useResource("series");
  const own = mode === "night" ? night : mode === "dtr" ? null : day;
  const ownData = mode === "dtr" ? (series.status === "ready" ? scopeSeries(series.data, scope, "dtr") : null) : own?.status === "ready" ? own.data : null;
  const v = ownData ? valueAt(ownData, timeline, t, ssp) : null;
  const n = ncr.status === "ready" ? valueAt(ncr.data, timeline, t, ssp) : null;
  const info = frameTierInfo(timeline, t, mode, ssp);
  const tierId = normalizeTier(info?.tier);
  const exactYear = info?.exact ? info.frame.year : null;

  const dayData = day.status === "ready" ? day.data : null;
  const nightData = night.status === "ready" ? night.data : null;
  const dtr = exactYear !== null && dayData && nightData ? (seriesValueAt(dayData, exactYear, ssp)?.mean ?? NaN) - (seriesValueAt(nightData, exactYear, ssp)?.mean ?? NaN) : NaN;
  let rank = null;
  if (exactYear !== null && series.status === "ready" && mode !== "dtr") {
    const entries = scopesOfKind(series.data, "district").map((s) => ({ id: s.id, value: seriesValueAt(scopeSeries(series.data, s.id, mode), exactYear, null)?.uhi ?? NaN }));
    rank = districtRank(entries, scope);
  }
  const panels = [panelFor(dayData, timeline, "day", ssp, "Day")];
  if (timeline.modeIds.includes("night")) panels.push(panelFor(nightData, timeline, "night", ssp, "Night"));

  return (
    <section aria-label={`District ${district?.name ?? districtId}`} className="space-y-2">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="micro-label">District</p>
          <h3 className="truncate font-display text-[16px] font-semibold text-ink-strong">
            {district?.name ?? `District ${districtId}`}
            {district?.state && <span className="ml-1 font-sans text-[12px] font-normal text-ink-muted">({district.state})</span>}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={`Fly to ${district?.name ?? "district"}`}
            onClick={() => window.dispatchEvent(new CustomEvent(SHELL_EVENTS.flyTo, { detail: { districtId } }))}
            className="focus-ring grid size-7 place-items-center rounded-md text-ink-muted hover:bg-surface-3 hover:text-ink"
          >
            <Crosshair aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </button>
          <button type="button" aria-label="Clear district" onClick={() => useSelectionStore.getState().setDistrict(null)} className="focus-ring grid size-7 place-items-center rounded-md text-ink-muted hover:bg-surface-3 hover:text-ink">
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      </header>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={v?.interpolated ? "tnum font-mono text-[20px] font-semibold italic text-ink" : "tnum font-mono text-[20px] font-semibold text-ink-strong"}>
          {v?.interpolated ? "≈" : ""}
          {finite(v?.mean) ? fmt(v.mean, 1) : "—"}
          <span className="unit">°C</span>
        </span>
        <span className="inline-flex items-center gap-1 text-[12px] text-ink-muted">
          {mode === "night" ? "Night" : mode === "dtr" ? "DTR" : "Day"} {v?.interpolated ? `${v.bracket.yA} ↔ ${v.bracket.yB}` : Math.round(t)}
          {!v?.interpolated && tierId && (
            <>
              <TierShape tier={tierId} size={9} /> {TIER_META[tierId].short.toLowerCase()}
            </>
          )}
          {info?.kind === "projected" && ` · ${fmtSsp(ssp)} p50`}
        </span>
        {finite(v?.mean) && finite(n?.mean) && <Delta value={v.mean - n.mean} dp={1} context="vs NCR" approx={Boolean(v.interpolated)} className="text-[12px]" />}
      </p>
      <MiniFanChart panels={panels} first={timeline.first} last={timeline.last} now={timeline.now} year={t} ssp={ssp} caption={`${district?.name ?? "District"} mean LST by frame${timeline.modeIds.includes("night") ? ", day and night" : ", day"}${ssp && timeline.scenarioIds.includes(ssp) ? `, with the ${fmtSsp(ssp)} fan` : ""}`} />
      <p className="font-mono text-[11px] text-ink-muted">
        {finite(dtr) ? `DTR ${fmt(dtr, 1)} °C` : "DTR n/a"}
        {rank ? ` · Surface UHI (urban − rural) rank ${rank.rank}/${rank.of}` : ""}
        {rank && exactYear !== null && dayData && mode === "day" ? ` · ${fmtSigned(seriesValueAt(dayData, exactYear, null)?.uhi, 1)} °C by day` : ""}
      </p>
    </section>
  );
}

export default DistrictSummary;
