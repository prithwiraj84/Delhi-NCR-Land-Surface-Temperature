/**
 * Scenario summary shown while the "Scenario delta" layer is active: what was changed
 * (feature, delta, region), the mean simulated ΔLST and the affected area. Without a
 * scenario result it prompts the user to design one in the Threshold Explorer.
 */
import { motion } from "framer-motion";
import { FlaskConical, ArrowRight } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { featureLabel, featureMeta, fmtDeltaC, fmtKm2, fmtInt, fmtPct, fmtSigned } from "../../lib/format.js";
import { coupledBadgeVisible as showCoupledBadge } from "../../lib/scenario.js";

/** "+20%" for fraction features, "+0.05" for indices / numbers. */
function formatDelta(manifest, feature, delta) {
  if (!Number.isFinite(delta)) return "";
  const meta = featureMeta(manifest, feature);
  if (meta?.display === "percent") return `${delta > 0 ? "+" : ""}${fmtPct(delta, Math.abs(delta) < 0.1 ? 1 : 0)}`;
  return fmtSigned(delta, 2);
}

/** Human description of a scenario region. */
function describeRegion(region, districtsById, zoneById) {
  const ids = region?.ids ?? [];
  if (!region || region.type === "all" || !ids.length) return "all of NCR";
  const lookup = region.type === "district" ? (id) => districtsById.get(id)?.name : (id) => zoneById.get(id)?.label;
  const names = ids.map((id) => lookup(id) ?? `#${id}`);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(" & ");
}

export default function ScenarioChip({ scenario, result, manifest, districtsById, zoneById, onOpenThresholds, className }) {
  // tailwind-merge lets a caller's width (e.g. a narrower phone width) replace w-80.
  const base = cn("pointer-events-auto w-80 rounded-xl border bg-panel/75 p-3 shadow-glass backdrop-blur-md", className);

  if (!result) {
    return (
      <motion.section
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        className={`${base} border-violet/30`}
        aria-label="Scenario"
      >
        <p className="flex items-center gap-2 font-display text-sm font-semibold text-ink-strong">
          <FlaskConical className="h-4 w-4 text-violet" aria-hidden="true" /> No scenario yet
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Design a what-if change (e.g. +20% tree canopy in Gurugram) in the Threshold Explorer; its
          simulated ΔLST will appear here cell by cell.
        </p>
        <button
          type="button"
          onClick={onOpenThresholds}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/10 px-2.5 py-1 text-xs font-medium text-violet-soft transition hover:bg-violet/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet"
        >
          Open Threshold Explorer <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </motion.section>
    );
  }

  const { stats } = result;
  const cooling = Number.isFinite(stats?.mean) && stats.mean < 0;
  return (
    <motion.section
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`${base} ${cooling ? "border-cyan/30" : "border-rose/30"}`}
      aria-label="Scenario summary"
    >
      <p className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-ink-faint">
        <FlaskConical className="h-3.5 w-3.5 text-violet" aria-hidden="true" /> Scenario
        {showCoupledBadge(scenario, result) ? (
          <span className="rounded bg-white/5 px-1 text-ink-muted">coupled indices</span>
        ) : null}
      </p>
      <p className="mt-0.5 truncate text-xs text-ink">
        <span className="font-semibold text-ink-strong">
          {formatDelta(manifest, scenario?.feature, scenario?.delta)} {featureLabel(manifest, scenario?.feature)}
        </span>{" "}
        in {describeRegion(scenario?.region, districtsById, zoneById)}
      </p>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-ink-faint">Mean Δ</dt>
          <dd className="font-display text-base font-semibold text-ink-strong">{fmtDeltaC(stats?.mean, 2)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-ink-faint">Changed area</dt>
          <dd className="font-display text-base font-semibold text-ink-strong">{fmtKm2(stats?.areaKm2)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-ink-faint">Changed cells</dt>
          <dd className="font-display text-base font-semibold text-ink-strong">{fmtInt(stats?.count)}</dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={onOpenThresholds}
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-violet-soft underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet"
      >
        Edit in Threshold Explorer <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </button>
    </motion.section>
  );
}
