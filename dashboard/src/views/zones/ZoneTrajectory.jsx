/**
 * Zone area trajectory 1990–2050 (UI_SPEC §3.7 ZoneCard "area trajectory with an SSP fan"):
 * the zone's share of the mapped area at every observed frame (solid, zone colour) and its
 * projected share under each SSP (SSP colour + dash, the selected one emphasised). There is
 * no Monte-Carlo spread of zone areas in the bundle, so the "fan" is the spread ACROSS
 * scenarios — labelled as such, never as a confidence band.
 */
import { CHART, linePath, linearScale, sspStyle } from "../../viz/chartTheme.js";
import { fmtPct } from "../../lib/format.js";

/**
 * @param {{trajectories: Record<string, {year: number, share: number}[]>, color: string,
 *          selectedSsp?: string|null, now?: number|null, xDomain?: [number, number], name: string}} props
 */
export function ZoneTrajectory({ trajectories, color, selectedSsp = null, now = null, xDomain = [1990, 2050], name }) {
  const obs = trajectories?.obs ?? [];
  const ssps = Object.keys(trajectories ?? {}).filter((k) => k !== "obs");
  if (obs.length < 2 && !ssps.length) return null;
  const width = 220;
  const height = 64;
  const all = Object.values(trajectories).flat().map((p) => p.share).filter(Number.isFinite);
  const hi = Math.max(0.05, ...all) * 1.1;
  const x = linearScale(xDomain, [4, width - 34]);
  const y = linearScale([0, hi], [height - 12, 4]);
  const anchor = obs.filter((p) => Number.isFinite(p.share)).at(-1);
  const toPts = (list) => list.map((p) => ({ x: p.year, y: p.share }));
  const lastObs = anchor ? fmtPct(anchor.share, 0) : "—";
  const sel = selectedSsp && trajectories[selectedSsp] ? trajectories[selectedSsp].at(-1) : null;
  return (
    <figure className="space-y-0.5">
      <svg width={width} height={height} role="img" aria-label={`${name}: share of mapped area ${obs[0]?.year ?? ""}–${anchor?.year ?? ""} ending at ${lastObs}${sel ? `, ${fmtPct(sel.share, 0)} in ${sel.year} under ${sspStyle(selectedSsp).label}` : ""}.`}>
        {Number.isFinite(now) && <line x1={x(now)} x2={x(now)} y1={2} y2={height - 12} stroke={CHART.now} />}
        {ssps.map((id) => {
          const st = sspStyle(id);
          const pts = anchor ? [{ x: anchor.year, y: anchor.share }, ...toPts(trajectories[id])] : toPts(trajectories[id]);
          const on = id === selectedSsp;
          return <path key={id} d={linePath(pts, x, y)} fill="none" stroke={st.color} strokeOpacity={on ? 1 : CHART.otherSspAlpha + 0.15} strokeWidth={on ? 1.75 : 1.25} strokeDasharray={st.dash ?? undefined} />;
        })}
        <path d={linePath(toPts(obs), x, y)} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
        {obs.map((p) => (Number.isFinite(p.share) ? <circle key={p.year} cx={x(p.year)} cy={y(p.share)} r={2} fill={color} /> : null))}
        <text x={x(xDomain[0])} y={height - 1} fill={CHART.axis} fontSize={9.5} fontFamily={CHART.font}>
          {xDomain[0]}
        </text>
        <text x={x(xDomain[1])} y={height - 1} textAnchor="end" fill={CHART.axis} fontSize={9.5} fontFamily={CHART.font}>
          {xDomain[1]}
        </text>
        {sel && (
          <text x={x(sel.year) + 3} y={y(sel.share)} dy="0.32em" fill={CHART.ink} fontSize={9.5} fontFamily={CHART.font}>
            {fmtPct(sel.share, 0)}
          </text>
        )}
      </svg>
      <figcaption className="text-[10.5px] text-ink-faint">Share of mapped area · lines after NOW = scenarios (spread across SSPs, not a CI)</figcaption>
    </figure>
  );
}

export default ZoneTrajectory;
