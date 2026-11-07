/**
 * AREA OF APPLICABILITY (UI_SPEC §3.8 "AOA mini map + DI hist"; SPEC §4.6, Meyer & Pebesma
 * 2021): where do the predictors resemble the training data? A cell is outside the AOA when its
 * dissimilarity index DI (distance to the nearest training row in SHAP-weighted standardised
 * feature space, divided by the mean pairwise distance) exceeds Q75 + 1.5·IQR of the training
 * DI. Shown: % of cells inside per frame (observed and projected), the error model (RMSE by DI
 * decile — error grows with DI) and a mini map of the outside cells for the chosen frame.
 */
import { useMemo, useState } from "react";
import { useCells, useCube, useTimeline } from "../../data/hooks.js";
import { cubeAoaOutside, cubeFrameIndex } from "../../data/cubes.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { fmt, fmtPct } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART } from "../../viz/chartTheme.js";
import { SmallMultiples } from "../../viz/SmallMultiples.jsx";
import { Sparkline } from "../../viz/Sparkline.jsx";
import { cellPixels } from "../../viz/thumbRaster.js";
import { aoaSummary } from "./labModel.js";

export function AoaPanel({ slice, mode }) {
  const summary = aoaSummary(slice);
  const tl = useTimeline();
  const timeline = tl.status === "ready" ? tl.data : null;
  const ssp = useTimeStore((s) => s.ssp);
  const timeYear = useTimeStore((s) => s.year);
  const cells = useCells();
  const [pick, setPick] = useState(null);
  const year = pick ?? (timeline?.years.includes(Number(timeYear)) ? Number(timeYear) : timeline?.now ?? null);
  const frame = timeline?.frames.find((f) => f.year === year) ?? null;
  const series = frame?.kind === "projected" ? (timeline.scenarioIds.includes(ssp) ? ssp : timeline.scenarioIds[0]) : "obs";
  const cube = useCube(summary && frame ? mode : null, series ?? "obs");
  const grid = useMemo(() => (cells.status === "ready" ? cellPixels(cells.data, 140) : null), [cells]);
  const item = useMemo(() => {
    if (cube.status !== "ready" || !frame) return null;
    const f = cubeFrameIndex(cube.data, frame.year);
    const out = f >= 0 ? cubeAoaOutside(cube.data, f) : null;
    if (!out) return null;
    const values = new Float32Array(out.length);
    for (let i = 0; i < out.length; i += 1) values[i] = out[i] ? 1 : 0.15;
    return { key: `aoa-${mode}-${series}-${frame.year}`, year: frame.year, label: `${frame.year} AOA`, tier: frame[mode]?.tier, values, ramp: "mist", domain: [0, 1], projected: frame.kind === "projected" };
  }, [cube, frame, mode, series]);
  const items = useMemo(() => (item ? [item] : []), [item]);
  const status = summary ? { status: "ready" } : { status: "unavailable", reason: "The area of applicability is a v2 export (metrics.json aoa) — rerun notebook v2." };
  const decilePts = (summary?.deciles ?? []).map((d) => ({ x: d.decile, y: d.rmse }));

  return (
    <ChartTable
      title={`Area of applicability · ${mode}`}
      status={status}
      columns={[
        { key: "year", label: "Frame" },
        { key: "pct", label: "Cells inside AOA", align: "right", format: (v) => fmtPct(v, 1) },
      ]}
      rows={summary?.pct ?? []}
      caption={`Share of cells inside the area of applicability per frame (DI threshold ${fmt(summary?.threshold, 2)}).`}
    >
      {summary && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-2">
            <p className="text-xs text-ink-muted">
              DI threshold <span className="tnum font-mono text-ink">{fmt(summary.threshold, 2)}</span> (Q75 + 1.5·IQR of training DI). Projected frames move outside as land use and climate drift away from the training conditions.
            </p>
            <ul className="space-y-0.5">
              {summary.pct.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setPick(r.year)} aria-pressed={r.year === year} className="focus-ring grid w-full grid-cols-[3rem_minmax(0,1fr)_3.5rem] items-center gap-2 rounded px-1 text-left text-[11px] hover:bg-surface-3/60">
                    <span className="font-mono text-ink-muted">{r.year}</span>
                    <span className="h-2 rounded-[3px] bg-surface-3">
                      <span className="block h-2 rounded-[3px]" style={{ width: `${r.pct * 100}%`, backgroundColor: r.year > (timeline?.now ?? Infinity) ? CHART.inkFaint : CHART.inkMuted }} />
                    </span>
                    <span className="tnum text-right font-mono text-ink">{fmtPct(r.pct, 1)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {decilePts.length > 1 && (
              <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                <Sparkline points={decilePts} width={120} height={28} color={CHART.ink} label={`RMSE by DI decile from ${fmt(decilePts[0].y, 2)} to ${fmt(decilePts.at(-1).y, 2)} °C`} />
                RMSE by DI decile: {fmt(decilePts[0].y, 2)} → {fmt(decilePts.at(-1).y, 2)} °C
              </div>
            )}
          </div>
          <div className="space-y-1">
            <span className="micro-label">Outside AOA · {year ?? "—"}</span>
            {items.length ? <SmallMultiples items={items} grid={grid} gridKey="aoa" thumbWidth={150} ariaLabel="Cells outside the area of applicability" /> : <p className="text-[11px] text-ink-faint">{cube.status === "loading" ? "Loading…" : cube.reason ?? "No AOA flags for this frame."}</p>}
            <p className="text-[10.5px] text-ink-faint">bright = outside the AOA (hatched on the map)</p>
          </div>
        </div>
      )}
    </ChartTable>
  );
}

export default AoaPanel;
