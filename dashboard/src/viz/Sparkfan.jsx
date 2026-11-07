/**
 * Sparkfan (UI_SPEC §3.5 district ledger "sparkfan 1990–2050"): the observed frame means as
 * a solid line, then the selected SSP's p5–p95 fan (18 %) and p50 strand in its dash, opening
 * at NOW from the scope's weather-normalised `baseline` (D14; a hollow marker) — never from the
 * observed NOW frame. Without a baseline the fan starts at the first projected frame. Scale is
 * shared by the caller (pass `yDomain`) so rows compare honestly.
 * @param {{obs: {year: number, mean: number}[], fan?: {year: number, p05: number, p50: number, p95: number}[],
 *          baseline?: number|null, ssp?: string|null, now?: number|null, xDomain?: [number, number],
 *          yDomain?: [number, number], width?: number, height?: number, color?: string, label?: string}} props
 */
import { CHART, bandPath, linePath, linearScale, niceDomain, sspStyle } from "./chartTheme.js";

export function Sparkfan({ obs = [], fan = [], baseline = null, ssp = null, now = null, xDomain = [1990, 2050], yDomain, width = 120, height = 26, color = CHART.ink, label }) {
  const obsPts = obs.map((r) => ({ x: r.year, y: r.mean }));
  const fanRows = fan.filter((r) => Number.isFinite(r.p50));
  const anchor = Number.isFinite(baseline) && Number.isFinite(now) && fanRows.length && fanRows[0].year > now ? { x: now, y: baseline } : null;
  const rows = anchor ? [{ year: anchor.x, p05: anchor.y, p50: anchor.y, p95: anchor.y }, ...fanRows] : fanRows;
  const yd = yDomain ?? niceDomain([...obsPts.map((p) => p.y), ...rows.flatMap((r) => [r.p05, r.p95])], { pad: 0.08, minSpan: 0.5 });
  const x = linearScale(xDomain, [2, width - 2]);
  const y = linearScale(yd, [height - 2, 2]);
  const st = sspStyle(ssp);
  return (
    <svg width={width} height={height} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      {Number.isFinite(now) && <line x1={x(now)} x2={x(now)} y1={1} y2={height - 1} stroke={CHART.grid} />}
      {rows.length > 1 && <path d={bandPath(rows.map((r) => ({ x: r.year, lo: r.p05, hi: r.p95 })), x, y)} fill={st.color} fillOpacity={CHART.fanOuter} />}
      {rows.length > 1 && <path d={linePath(rows.map((r) => ({ x: r.year, y: r.p50 })), x, y)} fill="none" stroke={st.color} strokeWidth={1.25} strokeDasharray={st.dash ?? undefined} />}
      <path d={linePath(obsPts, x, y)} fill="none" stroke={color} strokeWidth={1.25} strokeLinecap="round" />
      {anchor && <circle cx={x(anchor.x)} cy={y(anchor.y)} r={2} fill={CHART.surface} stroke={st.color} strokeWidth={1} />}
    </svg>
  );
}

export default Sparkfan;
