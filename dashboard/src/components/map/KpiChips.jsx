/**
 * Top-right epoch readout: the year (prominent) and three KPI chips for the current
 * epoch - mean observed LST, hottest district by mean LST and the share of cells in the
 * Heat Extreme Core zone. Hero figures use proportional digits (no tabular-nums).
 */
import { AnimatePresence, motion } from "framer-motion";
import { Flame, Thermometer, Crosshair } from "lucide-react";
import { fmtC, fmtPct } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

const CHIP = "flex min-w-0 items-center gap-2 rounded-lg border border-panel-border bg-panel/70 px-2.5 py-1.5 shadow-glass backdrop-blur-md";

function Chip({ icon: Icon, label, value, detail, accent }) {
  return (
    <div className={CHIP}>
      <Icon className={cn("h-4 w-4 shrink-0", accent)} aria-hidden="true" />
      <div className="min-w-0 leading-tight">
        <p className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
        <p className="truncate font-display text-sm font-semibold text-ink-strong">
          {value}
          {detail ? <span className="ml-1 font-sans text-[11px] font-normal text-ink-muted">{detail}</span> : null}
        </p>
      </div>
    </div>
  );
}

/**
 * @param {{year: number, kpis: {meanLst: number, hottest: object|null, heatCoreShare: number},
 *          loading: boolean, compact?: boolean}} props
 *   compact: phone layout - only the epoch pill (the chips would cover the map controls);
 *   the same figures remain available in the legend, tooltips and the other views.
 */
export default function KpiChips({ year, kpis, loading, compact = false }) {
  return (
    <section className="pointer-events-auto flex flex-col items-end gap-2" aria-label={`Epoch ${year} key figures`}>
      <div className="relative flex items-baseline gap-2 rounded-xl border border-cyan/25 bg-bg/70 px-3 py-1 shadow-glow-cyan backdrop-blur-md">
        <span className="text-[10px] uppercase tracking-[0.2em] text-cyan-soft">Epoch</span>
        {/* popLayout (not "wait"): the new year renders in the same commit as the new KPI
            values, so the label can never lag behind the data while the old year fades out. */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={year}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            className={cn("font-display font-bold text-ink-strong", compact ? "text-2xl" : "text-3xl")}
          >
            {year}
          </motion.span>
        </AnimatePresence>
        {loading ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" aria-label="Loading epoch" /> : null}
      </div>
      <div className={cn("flex max-w-[34rem] flex-wrap justify-end gap-2", compact && "hidden")}>
        <Chip icon={Thermometer} label="Mean LST" value={fmtC(kpis.meanLst, 1)} accent="text-amber" />
        <Chip
          icon={Flame}
          label="Hottest district"
          value={kpis.hottest?.name ?? "—"}
          detail={kpis.hottest ? fmtC(kpis.hottest.meanLst, 1) : null}
          accent="text-rose"
        />
        <Chip icon={Crosshair} label="Heat Extreme Core" value={fmtPct(kpis.heatCoreShare, 1)} detail="of cells" accent="text-rose-soft" />
      </div>
    </section>
  );
}
