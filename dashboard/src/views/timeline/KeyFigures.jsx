/**
 * KEY FIGURES (guarded) — UI_SPEC §3.5 right column, §9 content rules:
 *   - Δ observed first → last frame ± CI (difference of two frame levels, CIs in quadrature;
 *     labelled a change between frames, never a trend). Only observed-evidence frames anchor it
 *     (the exported trend's frames, else observed / observed-sparse / reconstructed tiers: a
 *     modelled hindcast never does), and only when the bundle's levels are harmonised across
 *     sensors and overpass times — otherwise the guard reason is shown instead of numbers;
 *   - trend sentence only from the exported trend and only when its CI excludes 0, else
 *     "No clear trend: year-to-year weather dominates."; a bundle without an exported trend says so;
 *   - Δ vs the weather-normalised 2025 baseline → 2050 p50 per SSP with the p5–p95 range
 *     ("Model + CMIP6 scenario, not observations"); the baseline value is printed and the
 *     observed NOW value is a separate note (it includes the 2024–26 weather anomaly);
 *   - first frame with a day mean above 40 °C (observed or projected), threshold years
 *     (+1/+2/+3 °C over the weather-normalised baseline) for the selected SSP;
 *   - DTR change (day − night) between the first and last observed-evidence frames that have both.
 * Each figure carries its evidence tier glyph; missing inputs say why. The projection figure
 * always states the AOA share of the horizon frame under the selected SSP (§9 projection copy).
 */
import { MicroLabel } from "../../components/ui/MicroLabel.jsx";
import { Delta } from "../../components/ui/Delta.jsx";
import { TierGlyph } from "../../components/ui/TierGlyph.jsx";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { fmt, fmtPct, fmtPlusMinus, fmtSigned } from "../../lib/format.js";
import { sspStyle } from "../../viz/chartTheme.js";
import { deriveDtrSeries } from "../../data/series.js";
import { firstLastChange, firstYearAbove, LEVELS_NOT_HARMONISED, projectedChange, trendCopy } from "./timelineModel.js";

function Figure({ label, children, note }) {
  return (
    <div className="space-y-1 border-b border-hairline pb-2.5 last:border-0 last:pb-0">
      <MicroLabel as="h3">{label}</MicroLabel>
      <div className="text-sm text-ink">{children}</div>
      {note && <p className="text-[11px] leading-snug text-ink-faint">{note}</p>}
    </div>
  );
}

/** "AOA 2050 · SSP5-8.5: 95% (day) · 90% (night) inside" or why it is missing. */
function aoaNote(aoa) {
  const day = aoa?.day ?? null;
  const night = aoa?.night ?? null;
  const ref = day ?? night;
  if (!ref) return "AOA share not exported in metrics.json.";
  const head = ref.source === "observed" ? `AOA (observed ${ref.year})` : `AOA ${ref.year}${ref.ssp ? ` · ${sspStyle(ref.ssp).label}` : ""}`;
  const parts = [];
  if (day) parts.push(`${fmtPct(day.pct, 0)} (day)`);
  if (night) parts.push(`${fmtPct(night.pct, 0)} (night)`);
  return `${head}: ${parts.join(" · ")} inside.`;
}

function ChangeLine({ change, mode }) {
  if (!change) return <p className="text-xs text-ink-muted">Fewer than two observed frames with a {mode} mean.</p>;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-mono text-xs text-ink-muted">
        {change.from} → {change.to}
      </span>
      <Delta value={change.delta} dp={1} context={`${mode}, ${change.from} to ${change.to}`} className="text-base" />
      {Number.isFinite(change.ci) ? <span className="font-mono text-xs text-ink-muted">{fmtPlusMinus(change.ci, 1)}</span> : <span className="text-[11px] text-ink-faint">no level CI exported</span>}
      <TierGlyph tier={change.tierFrom} variant="glyph" />
    </p>
  );
}

/** One line per SSP of the projected change vs the weather-normalised baseline. */
function ProjectionList({ proj, selectedSsp }) {
  return (
    <ul className="space-y-1">
      {proj.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <svg width="16" height="8" aria-hidden="true" className="self-center">
            <line x1="0" x2="16" y1="4" y2="4" stroke={sspStyle(r.id).color} strokeWidth={sspStyle(r.id).width} strokeDasharray={sspStyle(r.id).dash ?? undefined} />
          </svg>
          <span className={r.id === selectedSsp ? "text-ink" : "text-ink-muted"}>{sspStyle(r.id).label}</span>
          {r.day && (
            <span className="tnum font-mono">
              day {fmtSigned(r.day.delta, 1)} [{fmtSigned(r.day.lo, 1)}, {fmtSigned(r.day.hi, 1)}]
            </span>
          )}
          {r.night && <span className="tnum font-mono text-ink-muted">night {fmtSigned(r.night.delta, 1)}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * @param {{day: object|null, night: object|null, nightReason?: string|null, now: number,
 *          last: number, ssps: string[], selectedSsp: string|null, scopeLabel: string, projections: boolean,
 *          harmonised?: boolean,
 *          aoa?: {day: {year:number, ssp:string|null, pct:number, source:string}|null, night: object|null}|null}} props
 */
export function KeyFigures({ day, night, nightReason, now, last, ssps, selectedSsp, scopeLabel, projections, harmonised = true, aoa = null }) {
  const dayChange = harmonised ? firstLastChange(day, now) : null;
  const nightChange = harmonised ? firstLastChange(night, now) : null;
  const trendDay = trendCopy(day, "Day");
  const trendNight = night ? trendCopy(night, "Night") : null;
  const hot = firstYearAbove(day, 40, selectedSsp);
  const dtr = day && night ? deriveDtrSeries(day, night) : null;
  const dtrChange = dtr && harmonised ? firstLastChange(dtr, now) : null;
  const thresholds = day?.thresholdYears?.[selectedSsp] ?? null;
  const horizon = projections && last > now ? last : 2050;
  const proj = ssps.map((id) => ({ id, day: projectedChange(day, id, last, now), night: night ? projectedChange(night, id, last, now) : null })).filter((r) => r.day || r.night);
  const sel = proj.find((r) => r.id === selectedSsp) ?? proj[0] ?? null;
  const baseDay = sel?.day?.base;
  const obsDay = sel?.day?.observedNow;
  const baseNote = Number.isFinite(baseDay)
    ? `Baseline ${fmt(baseDay, 1)} °C (day${Number.isFinite(sel?.night?.base) ? `; night ${fmt(sel.night.base, 1)} °C` : ""}).${Number.isFinite(obsDay) ? ` The observed ${now} value ${fmt(obsDay, 1)} °C includes the 2024–26 weather anomaly.` : ""}`
    : "";

  return (
    <HudFrame solid title={`Key figures · ${scopeLabel}`} className="min-w-0" aria-live="off">
      <div className="space-y-2.5">
        <Figure label="Observed change, day" note={harmonised ? trendDay.text : null}>
          {harmonised ? <ChangeLine change={dayChange} mode="day" /> : <p className="text-xs text-ink-muted" data-testid="levels-guard">{LEVELS_NOT_HARMONISED}</p>}
        </Figure>
        <Figure label="Observed change, night" note={night ? (harmonised ? trendNight?.text : null) : nightReason}>
          {!night ? <p className="text-xs text-ink-muted">Unavailable</p> : harmonised ? <ChangeLine change={nightChange} mode="night" /> : <p className="text-xs text-ink-muted">{LEVELS_NOT_HARMONISED}</p>}
        </Figure>
        {/* Without projections (v1 bundles) `last` equals NOW, which would read "Δ 2025 → 2025": name the
            horizon the figure is about (2050) instead. */}
        <Figure
          label={`Δ ${horizon} vs weather-normalised ${now} baseline (p50)`}
          note={projections ? `Model + CMIP6 scenario, not observations. Range = p5–p95 of the Monte-Carlo scope means. ${baseNote} ${aoaNote(aoa)}`.replace(/\s+/g, " ").trim() : "No projections in this bundle — rerun notebook v2."}
        >
          {proj.length ? <ProjectionList proj={proj} selectedSsp={selectedSsp} /> : <p className="text-xs text-ink-muted">—</p>}
        </Figure>
        <Figure label="First frame with day mean > 40 °C" note={hot?.kind === "projected" ? `Under ${sspStyle(selectedSsp).label} (p50).` : null}>
          {hot ? (
            <p className="flex items-center gap-2">
              <span className="font-mono text-base text-ink-strong">{hot.year}</span>
              <TierGlyph tier={hot.tier} variant="short" />
            </p>
          ) : (
            <p className="text-xs text-ink-muted">Not reached{projections ? ` by ${last}` : ""} in this scope.</p>
          )}
        </Figure>
        {thresholds && (
          <Figure label={`Threshold years · ${sspStyle(selectedSsp).label}`} note="First projected frame whose p50 exceeds the weather-normalised baseline by +1/+2/+3 °C.">
            <p className="tnum font-mono text-xs">
              +1 °C {thresholds["+1"] ?? "—"} · +2 °C {thresholds["+2"] ?? "—"} · +3 °C {thresholds["+3"] ?? "—"}
            </p>
          </Figure>
        )}
        <Figure label="Diurnal range (day − night)" note={!dtr ? nightReason : harmonised ? "Difference of the day and night frame means between observed-evidence frames; the weaker tier of the two applies." : null}>
          {!harmonised && dtr ? (
            <p className="text-xs text-ink-muted">{LEVELS_NOT_HARMONISED}</p>
          ) : dtrChange ? (
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs text-ink-muted">
                {dtrChange.from} {fmt(dtr.frames.find((f) => f.year === dtrChange.from)?.mean, 1)} → {dtrChange.to} {fmt(dtr.frames.find((f) => f.year === dtrChange.to)?.mean, 1)} °C
              </span>
              <Delta value={dtrChange.delta} dp={1} semantics="neutral" context="diurnal range change" />
            </p>
          ) : (
            <p className="text-xs text-ink-muted">Unavailable</p>
          )}
        </Figure>
      </div>
    </HudFrame>
  );
}

export default KeyFigures;
