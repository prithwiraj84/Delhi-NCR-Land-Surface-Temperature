/**
 * Cell timeline 1990–2050 (UI_SPEC_v2 §3.4 "Cell timeline (from cubes)"): the pinned cell's
 * value in every frame of the display mode — observed frames from the obs cube, projections
 * from the selected SSP cube with its p5–p95 — gathered per cell from the cubes (no per-frame
 * files). Tiers per frame come from the cube / manifest. Pending SSP cubes are noted, never
 * silently dropped.
 */
import { useCellTimeline } from "../../../data/hooks.js";
import { tierOf } from "../../../data/timeline.js";
import { fmtSsp } from "../../../lib/format.js";
import { MiniFanChart } from "./MiniFanChart.jsx";

/** @param {{index:number, mode:string, ssp:string|null, timeline:object, t:number}} props */
export function CellTimeline({ index, mode, ssp, timeline, t }) {
  const res = useCellTimeline(index, mode);
  if (res.status === "loading") return <p className="scan-skeleton h-16" aria-label="Loading the cell timeline" />;
  if (res.status !== "ready") return <p className="text-[12px] text-ink-muted">{res.reason ?? "Cell timeline unavailable"}</p>;
  const { obs, ssp: fans, pending } = res.data;
  const panel = {
    id: mode,
    label: mode === "night" ? "Night" : mode === "dtr" ? "DTR" : "Day",
    frames: obs.map((r) => ({ year: r.year, value: r.p50, tier: tierOf(timeline, r.year, mode) ?? r.tier })),
    fan: ssp && fans[ssp] ? fans[ssp].map((r) => ({ year: r.year, p05: r.p05, p50: r.p50, p95: r.p95 })) : null,
  };
  return (
    <div>
      <MiniFanChart panels={[panel]} first={timeline.first} last={timeline.last} now={timeline.now} year={t} ssp={ssp} panelHeight={64} caption={`Cell value by frame (${panel.label.toLowerCase()})${panel.fan ? ` with the ${fmtSsp(ssp)} fan` : ""}`} />
      {pending?.length > 0 && <p className="mt-1 font-mono text-[11px] text-ink-faint">loading {pending.map(fmtSsp).join(", ")}…</p>}
    </div>
  );
}

export default CellTimeline;
