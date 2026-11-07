/**
 * Mini fan chart for the inspector (UI_SPEC_v2 §3.4): stacked mini panels (e.g. Day | Night)
 * on a shared 1990–2050 x-axis. Each panel shows the frame values with their manifest tier
 * glyph (observed solid line, reconstructed dashed, modelled dotted — UI_SPEC §4.6), the NOW
 * rule, the current-year cursor and ONLY the selected SSP's p5–p95 fan (18 %) with its p50
 * line, so the panel stays readable at 320 px. Day and night are never drawn in one panel
 * when fans are present (§3.5 rule). Gaps are never interpolated silently.
 *
 * A visually hidden table carries the same numbers (every chart has a table view).
 */
import { memo, useMemo } from "react";
import { scaleLinear } from "d3-scale";
import { area as d3area, line as d3line } from "d3-shape";
import { TierShape } from "../../../design/glyphs.jsx";
import { ssp as SSP_STYLE } from "../../../design/tokens.js";
import { weakerTier } from "../../../data/timeline.js";
import { fmt, fmtSsp, MISSING } from "../../../lib/format.js";

const W = 320;
const PAD = { l: 58, r: 8 }; // left gutter holds the panel label (≤ 5 chars) and the y ticks
const DASH = { reconstructed: "2 4", modelled: "1 3" };
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {{panels: Array<{id:string, label:string, frames:Array<{year:number, value:number, tier:string|null}>,
 *          fan?: Array<{year:number, p05:number, p50:number, p95:number}>|null, baseline?: number|null,
 *          unavailable?: string|null}>,   `baseline` = weather-normalised NOW baseline the fan opens from
 *          first:number, last:number, now:number|null, year:number|null, ssp?:string|null,
 *          panelHeight?: number, caption: string}} props
 */
export const MiniFanChart = memo(function MiniFanChart({ panels, first, last, now, year, ssp = null, panelHeight = 54, caption }) {
  const x = useMemo(() => scaleLinear().domain([first, last]).range([PAD.l, W - PAD.r]), [first, last]);
  const style = SSP_STYLE[ssp] ?? { color: "var(--ink-muted)", dash: null };
  const height = panels.length * (panelHeight + 6) + 14;

  const geo = useMemo(
    () =>
      panels.map((p, k) => {
        const top = k * (panelHeight + 6) + 2;
        const vals = [...p.frames.map((f) => f.value), ...(p.fan ?? []).flatMap((r) => [r.p05, r.p95, r.p50]), p.fan?.length ? p.baseline : NaN].filter(finite);
        if (!vals.length) return { top, y: null };
        let lo = Math.min(...vals);
        let hi = Math.max(...vals);
        if (hi - lo < 1) {
          lo -= 0.5;
          hi += 0.5;
        }
        const y = scaleLinear().domain([lo, hi]).nice(3).range([top + panelHeight - 4, top + 4]);
        const pts = p.frames.filter((f) => finite(f.value));
        const segs = [];
        for (let i = 1; i < pts.length; i += 1) segs.push({ a: pts[i - 1], b: pts[i], dash: DASH[weakerTier(pts[i - 1].tier, pts[i].tier)] ?? null });
        // The fan opens at NOW from the panel's weather-normalised baseline (a hollow marker,
        // D14); without one (cells) it starts at the first projected frame — never at a
        // zero-width observed point.
        const fan = (p.fan ?? []).filter((r) => finite(r.p50));
        const anchorX = finite(now) ? now : null;
        const baseline = finite(p.baseline) && anchorX !== null && fan.length && fan[0].year > anchorX ? { year: anchorX, value: p.baseline } : null;
        const fanPts = baseline ? [{ year: baseline.year, p05: baseline.value, p95: baseline.value, p50: baseline.value }, ...fan] : fan;
        const band = d3area()
          .defined((d) => finite(d.p05) && finite(d.p95))
          .x((d) => x(d.year))
          .y0((d) => y(d.p05))
          .y1((d) => y(d.p95))(fanPts);
        const mid = d3line()
          .x((d) => x(d.year))
          .y((d) => y(d.p50))(fanPts);
        return { top, y, pts, segs, band: fan.length ? band : null, mid: fan.length ? mid : null, baseline, ticks: y.ticks(2) };
      }),
    [panels, panelHeight, x, now],
  );

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={caption} className="block overflow-visible">
        {panels.map((p, k) => {
          const g = geo[k];
          return (
            <g key={p.id}>
              <text x={0} y={g.top + 11} style={{ font: "500 11px var(--font-mono)", fill: "var(--ink-faint)", letterSpacing: "0.08em" }}>
                {p.label.toUpperCase()}
              </text>
              {!g.y ? (
                <text x={PAD.l} y={g.top + panelHeight / 2 + 4} style={{ font: "11px var(--font-sans)", fill: "var(--ink-faint)" }}>
                  {p.unavailable ?? "no data"}
                </text>
              ) : (
                <>
                  {g.ticks.map((t) => (
                    <g key={t}>
                      <line x1={PAD.l} x2={W - PAD.r} y1={g.y(t)} y2={g.y(t)} stroke="rgba(160, 185, 225, 0.08)" />
                      <text x={PAD.l - 4} y={g.y(t) + 3.5} textAnchor="end" style={{ font: "10.5px var(--font-mono)", fill: "var(--ink-faint)" }}>
                        {fmt(t, 0)}
                      </text>
                    </g>
                  ))}
                  {g.band && <path d={g.band} fill={style.color} fillOpacity={0.18} />}
                  {g.mid && <path d={g.mid} fill="none" stroke={style.color} strokeWidth={1.75} strokeDasharray={style.dash ?? undefined} />}
                  {g.baseline && (
                    <circle cx={x(g.baseline.year)} cy={g.y(g.baseline.value)} r={3.5} fill="var(--surface-2)" stroke={style.color} strokeWidth={1.5} data-testid="fan-baseline">
                      <title>{`Weather-normalised ${g.baseline.year} baseline ${fmt(g.baseline.value, 1)} °C`}</title>
                    </circle>
                  )}
                  {g.segs.map((s) => (
                    <line key={`${s.a.year}-${s.b.year}`} x1={x(s.a.year)} y1={g.y(s.a.value)} x2={x(s.b.year)} y2={g.y(s.b.value)} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray={s.dash ?? undefined} />
                  ))}
                  {g.pts.map((f) => (
                    <g key={f.year} style={{ color: "var(--ink)" }}>
                      <circle cx={x(f.year)} cy={g.y(f.value)} r={5} fill="var(--surface-2)" />
                      <TierShape tier={f.tier} size={8} x={x(f.year) - 4} y={g.y(f.value) - 4} />
                    </g>
                  ))}
                </>
              )}
            </g>
          );
        })}
        {finite(now) && now >= first && now <= last && <line x1={x(now)} x2={x(now)} y1={2} y2={height - 14} stroke="var(--signal)" strokeOpacity={0.7} strokeDasharray="3 3" />}
        {finite(year) && <line x1={x(year)} x2={x(year)} y1={2} y2={height - 14} stroke="var(--reticle)" strokeWidth={1} strokeOpacity={0.8} />}
        <text x={PAD.l} y={height - 2} style={{ font: "10.5px var(--font-mono)", fill: "var(--ink-faint)" }}>
          {first}
        </text>
        {finite(now) && x(now) < W - PAD.r - 36 && x(now) > PAD.l + 36 && (
          <text x={x(now)} y={height - 2} textAnchor="middle" style={{ font: "10.5px var(--font-mono)", fill: "var(--ink-faint)" }}>
            NOW
          </text>
        )}
        <text x={W - PAD.r} y={height - 2} textAnchor="end" style={{ font: "10.5px var(--font-mono)", fill: "var(--ink-faint)" }}>
          {finite(now) && x(now) >= W - PAD.r - 36 ? `NOW · ${last}` : last}
        </text>
      </svg>
      <figcaption className="sr-only">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Series</th>
              <th scope="col">Year</th>
              <th scope="col">Value °C</th>
              <th scope="col">Tier / range</th>
            </tr>
          </thead>
          <tbody>
            {panels.flatMap((p) => [
              ...p.frames.map((f) => (
                <tr key={`${p.id}-${f.year}`}>
                  <td>{p.label}</td>
                  <td>{f.year}</td>
                  <td>{finite(f.value) ? fmt(f.value, 1) : MISSING}</td>
                  <td>{f.tier ?? MISSING}</td>
                </tr>
              )),
              ...(p.fan ?? []).map((r) => (
                <tr key={`${p.id}-fan-${r.year}`}>
                  <td>{`${p.label} ${fmtSsp(ssp)}`}</td>
                  <td>{r.year}</td>
                  <td>{finite(r.p50) ? fmt(r.p50, 1) : MISSING}</td>
                  <td>{finite(r.p05) && finite(r.p95) ? `p5–p95 ${fmt(r.p05, 1)}–${fmt(r.p95, 1)}` : "projected"}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
});

export default MiniFanChart;
