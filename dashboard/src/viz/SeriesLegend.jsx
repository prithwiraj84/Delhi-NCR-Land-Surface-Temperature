/**
 * Legend for the time-series charts: evidence-tier encodings (marker + dash + label, never
 * hue alone), the hatched band, the satellite annual context line and the SSP strands
 * (colour + dash + label). Shown once above a group of panels (dataviz: one legend row for
 * ≥ 2 series; direct end labels repeat the SSP identity on the chart).
 * @param {{tiers?: string[], ssps?: string[], selectedSsp?: string|null, accent?: string,
 *          showAnnual?: boolean, showHatch?: boolean, className?: string}} props
 */
import { cn } from "../lib/cn.js";
import { CHART, sspStyle, tierStyle } from "./chartTheme.js";
import { TierMarker } from "./FanChart.jsx";
import { HatchSwatch } from "./Hatch.jsx";

export function SeriesLegend({ tiers = [], ssps = [], selectedSsp = null, accent = CHART.ink, showAnnual = false, showHatch = true, className }) {
  const uniqueTiers = [...new Set(tiers.filter(Boolean))];
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted", className)} aria-label="Chart legend">
      {uniqueTiers.map((t) => {
        const s = tierStyle(t);
        return (
          <li key={t} className="inline-flex items-center gap-1.5">
            <svg width="26" height="10" aria-hidden="true">
              <line x1="1" x2="25" y1="5" y2="5" stroke={accent} strokeWidth="1.5" strokeDasharray={s.dash ?? undefined} />
              <TierMarker cx={13} cy={5} tier={t} color={accent} r={3} />
            </svg>
            {s.label}
          </li>
        );
      })}
      {showHatch && uniqueTiers.some((t) => tierStyle(t).hatchCi) && (
        <li>
          <HatchSwatch kind="recon" label="Hatched band: reconstructed / modelled level CI" />
        </li>
      )}
      {showAnnual && (
        <li className="inline-flex items-center gap-1.5">
          <svg width="18" height="10" aria-hidden="true">
            <line x1="1" x2="17" y1="5" y2="5" stroke={CHART.inkFaint} strokeWidth="1" />
          </svg>
          Satellite annual (context)
        </li>
      )}
      {ssps.map((id) => {
        const st = sspStyle(id);
        return (
          <li key={id} className={cn("inline-flex items-center gap-1.5", id === selectedSsp && "text-ink")}>
            <svg width="22" height="10" aria-hidden="true">
              {id === selectedSsp && <rect x="1" y="1" width="20" height="8" fill={st.color} fillOpacity={CHART.fanOuter} />}
              <line x1="1" x2="21" y1="5" y2="5" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash ?? undefined} />
            </svg>
            {st.label}
            {id === selectedSsp ? " · p5–p95 fan" : ""}
          </li>
        );
      })}
    </ul>
  );
}

export default SeriesLegend;
