/**
 * One governance-zone comparison card. The four cards sit side by side (4 → 2 → 1 columns)
 * and share every scale (SHAP signature, sparkline formats), so reading across a row of
 * sections compares zones like a table.
 *
 * Sections, top to bottom: identity + description · area (km², share, change) · LST
 * (observed / predicted / anomaly) · epoch sparklines · SHAP signature · driver chips ·
 * interaction pairs · top districts · recommendations.
 */
import { motion, useReducedMotion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { withAlpha } from "../../lib/colors.js";
import { fmt, fmtC, fmtDeltaC, fmtPct, fmtSigned, isNum, MISSING } from "../../lib/format.js";
import {
  CardLabel,
  ClampText,
  DistrictShares,
  DriverChips,
  InteractionPairs,
  RecommendationList,
  ShapSignature,
  Sparkline,
} from "./ZoneCardParts.jsx";
import { HEAT_CORE_ID } from "./zoneModel.js";

/**
 * Whether growth of this zone is good, bad or neutral for heat governance: the cool base
 * growing is good, the heat core growing is bad; the middle zones are neutral.
 */
function growthTone(zoneId, delta) {
  if (!isNum(delta) || delta === 0) return "text-ink-muted";
  if (zoneId === HEAT_CORE_ID) return delta > 0 ? "text-rose" : "text-emerald";
  if (zoneId === 0) return delta > 0 ? "text-emerald" : "text-rose";
  return "text-ink-muted";
}

function ChangeLine({ zoneId, deltaArea, deltaSharePp, prevYear }) {
  if (!prevYear) return <p className="text-[11px] text-ink-faint">first epoch · no earlier comparison</p>;
  if (!isNum(deltaArea)) return <p className="text-[11px] text-ink-faint">no data for {prevYear}</p>;
  const Icon = deltaArea > 0 ? ArrowUpRight : deltaArea < 0 ? ArrowDownRight : Minus;
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-[11px]">
      <span className={cn("inline-flex items-center gap-0.5 font-mono font-medium", growthTone(zoneId, deltaArea))}>
        <Icon aria-hidden="true" className="size-3.5" />
        {fmtSigned(deltaArea, 0)} km²
      </span>
      {isNum(deltaSharePp) && <span className="font-mono text-ink-muted">({fmtSigned(deltaSharePp, 1)} pp)</span>}
      <span className="text-ink-faint">since {prevYear}</span>
    </p>
  );
}

/**
 * @param {{zone: object, summary: ReturnType<import("./zoneModel.js").zoneSummaries>[number],
 *          signature: {feature: string, value: number}[], signatureMax: number, manifest: object,
 *          year: number, index: number}} props
 */
export function ZoneCard({ zone, summary, signature, signatureMax, manifest, year, index, ciLabel = "95% CI" }) {
  const reduceMotion = useReducedMotion();
  const color = zone.color;
  const headingId = `zone-card-${zone.id}`;
  const shareSeries = summary.series.map((p) => ({ year: p.year, value: p.share }));
  const lstSeries = summary.series.map((p) => ({ year: p.year, value: p.lst }));

  return (
    <motion.article
      aria-labelledby={headingId}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: reduceMotion ? 0 : index * 0.06, ease: [0.22, 1, 0.36, 1] }}
      whileHover={reduceMotion ? undefined : { y: -2 }}
      className="glass relative flex min-w-0 flex-col overflow-hidden rounded-2xl border"
      style={{ borderColor: withAlpha(color, 0.32), boxShadow: `0 0 28px -14px ${withAlpha(color, 0.75)}` }}
    >
      {/* neon accent edge */}
      <div
        aria-hidden="true"
        className="h-[3px] w-full"
        style={{ background: `linear-gradient(90deg, ${withAlpha(color, 0)} 0%, ${color} 30%, ${color} 70%, ${withAlpha(color, 0)} 100%)` }}
      />
      <div className="flex flex-1 flex-col gap-4 p-4">
        {/* identity */}
        <header>
          <div className="flex items-center justify-between gap-2">
            <h3 id={headingId} className="flex min-w-0 items-center gap-2 font-display text-base font-semibold text-ink-strong">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: color, boxShadow: `0 0 10px ${withAlpha(color, 0.8)}` }}
              />
              <span className="truncate">{zone.name}</span>
            </h3>
            <span className="shrink-0 rounded border border-panel-border px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
              zone {zone.id}
            </span>
          </div>
          <ClampText text={zone.description} className="mt-1.5 text-xs text-ink-muted" />
        </header>

        {/* area + LST */}
        <section aria-label="Area and temperature" className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <CardLabel>Area · {year}</CardLabel>
            <p className="kpi-number font-mono text-lg font-semibold leading-tight text-ink-strong">
              {isNum(summary.area) ? fmt(summary.area, 0) : MISSING}
              <span className="ml-1 text-xs font-normal text-ink-muted">km²</span>
            </p>
            <p className="kpi-number font-mono text-xs text-ink">{fmtPct(summary.share, 1)} of NCR</p>
            <ChangeLine
              zoneId={zone.id}
              deltaArea={summary.deltaArea}
              deltaSharePp={summary.deltaSharePp}
              prevYear={summary.prevYear}
            />
          </div>
          <div className="min-w-0">
            <CardLabel>Mean LST · {year}</CardLabel>
            <p className="kpi-number font-mono text-lg font-semibold leading-tight text-ink-strong">{fmtC(summary.lstObs, 1)}</p>
            <p className="kpi-number font-mono text-xs text-ink">
              <span className="text-ink-faint">pred </span>
              {fmtC(summary.lstPred, 1)}
            </p>
            <p className="text-[11px] text-ink-muted">
              <span className="font-mono">{fmtDeltaC(summary.anomaly, 1)}</span>{" "}
              <span className="text-ink-faint">vs NCR mean</span>
            </p>
          </div>
        </section>

        {/* sparklines */}
        <section aria-label="Trends across epochs" className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <CardLabel>Area share</CardLabel>
            <Sparkline
              series={shareSeries}
              currentYear={year}
              color={color}
              format={(v) => fmtPct(v, 1)}
              label={`${zone.name} area share by epoch`}
            />
          </div>
          <div className="min-w-0">
            <CardLabel>Mean LST</CardLabel>
            <Sparkline
              series={lstSeries}
              currentYear={year}
              color={color}
              format={(v) => fmtC(v, 1)}
              label={`${zone.name} mean observed LST by epoch`}
            />
          </div>
          {isNum(summary.deltaLst) && (
            <p className="col-span-2 -mt-1 text-[11px] text-ink-faint">
              LST {fmtDeltaC(summary.deltaLst, 1)} since {summary.prevYear} (includes the inter-annual climate offset)
            </p>
          )}
        </section>

        {/* SHAP signature */}
        <section aria-label="SHAP signature">
          <CardLabel right="mean SHAP, °C">SHAP signature · top {signature.length}</CardLabel>
          <ShapSignature rows={signature} maxAbs={signatureMax} manifest={manifest} zoneName={zone.name} />
        </section>

        <section aria-label="Top drivers">
          <CardLabel>Top drivers</CardLabel>
          <DriverChips warming={zone.top_warming} cooling={zone.top_cooling} manifest={manifest} />
        </section>

        <section aria-label="Top interaction pairs">
          <CardLabel right="mean |interaction|">Interaction pairs</CardLabel>
          <InteractionPairs pairs={zone.top_interactions} manifest={manifest} />
        </section>

        <section aria-label="Top districts">
          <CardLabel right="share of zone cells">Top districts</CardLabel>
          <DistrictShares districts={zone.top_districts} color={color} />
        </section>

        <section aria-label="Recommendations">
          <CardLabel right={`model ΔLST · ${ciLabel}`}>Recommendations</CardLabel>
          <RecommendationList recs={zone.recommendations} manifest={manifest} ciLabel={ciLabel} />
        </section>
      </div>
    </motion.article>
  );
}
