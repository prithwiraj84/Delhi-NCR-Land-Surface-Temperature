/**
 * Header strip of the zoning view: clustering quality (silhouette), K, mapped area and the
 * epoch shown, plus a stacked horizontal bar of zone area shares for the current epoch.
 *
 * The bar is a part-to-whole of exactly four fixed-identity categories, so a single
 * stacked bar is the right form; segments keep a 2 px surface gap, animate their width
 * when the epoch changes, and are direct-labelled in the legend row beneath (name, share,
 * km² and change vs the previous epoch) so identity never rests on colour alone.
 */
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Boxes, CalendarRange, Map as MapIcon, Sigma } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { fmt, fmtKm2, fmtPct, fmtSigned, isNum, MISSING } from "../../lib/format.js";
import { StatTile } from "../ui/StatTile.jsx";
import { silhouetteQuality } from "./zoneModel.js";

/**
 * @param {{summaries: ReturnType<import("./zoneModel.js").zoneSummaries>, k: number|null,
 *          silhouette: number|null, total: number|null, prevTotal: number|null, year: number|null,
 *          prevYear: number|null, requestedYear: number|null}} props
 */
export function ZoneHeader({ summaries, k, silhouette, total, prevTotal, year, prevYear, requestedYear }) {
  const reduceMotion = useReducedMotion();
  const [hover, setHover] = useState(null);
  const quality = silhouetteQuality(silhouette);
  const valid = summaries.filter((s) => isNum(s.share) && s.share > 0);
  const epochMismatch = isNum(requestedYear) && isNum(year) && requestedYear !== year;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          size="sm"
          label="Silhouette"
          value={fmt(silhouette, 2)}
          icon={Sigma}
          accent={quality.tone === "amber" ? "amber" : quality.tone === "emerald" ? "emerald" : "cyan"}
          hint={`K-means on SHAP · ${quality.label} (−1 to 1)`}
        />
        <StatTile size="sm" label="Zones (K)" value={isNum(k) ? String(k) : MISSING} icon={Boxes} accent="violet" hint="fixed canonical ids 0–3" />
        <StatTile
          size="sm"
          label="Mapped area"
          value={isNum(total) ? fmt(total, 0) : MISSING}
          unit="km²"
          icon={MapIcon}
          accent="emerald"
          delta={isNum(total) && isNum(prevTotal) ? total - prevTotal : undefined}
          deltaText={isNum(total) && isNum(prevTotal) ? `${fmtSigned(total - prevTotal, 0)} km²` : undefined}
          deltaLabel={prevYear ? `vs ${prevYear}` : undefined}
          goodDirection="none"
        />
        <StatTile
          size="sm"
          label="Epoch shown"
          value={year ? String(year) : MISSING}
          icon={CalendarRange}
          accent="cyan"
          hint={
            epochMismatch
              ? `${requestedYear} not in zones.json - showing ${year}`
              : prevYear
                ? `changes compared with ${prevYear}`
                : "first epoch - no earlier comparison"
          }
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="text-[11px] uppercase tracking-wider text-ink-faint">Area share by zone · {year ?? MISSING}</p>
          <p className="font-mono text-[11px] text-ink-faint">{isNum(total) ? fmtKm2(total) : ""}</p>
        </div>
        <div
          role="img"
          aria-label={`Zone area shares in ${year}: ${summaries
            .map((s) => `${s.name} ${fmtPct(s.share, 1)}`)
            .join(", ")}`}
          className="flex h-5 w-full gap-[2px] overflow-hidden rounded-md bg-bg-raised/60"
        >
          {valid.map((s, i) => (
            <motion.div
              key={s.id}
              className="relative h-full min-w-[3px] first:rounded-l-md last:rounded-r-md"
              // flex-grow (not width) so the 2 px gaps never push the last segment out of the track.
              style={{ flexBasis: 0, backgroundColor: s.color, opacity: hover === null || hover === s.id ? 1 : 0.35 }}
              initial={reduceMotion ? false : { flexGrow: 0 }}
              animate={{ flexGrow: s.share }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: reduceMotion ? 0 : i * 0.05 }}
              onPointerEnter={() => setHover(s.id)}
              onPointerLeave={() => setHover(null)}
            >
              {s.share >= 0.09 && (
                <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] font-semibold text-bg-deep">
                  {fmtPct(s.share, 0)}
                </span>
              )}
            </motion.div>
          ))}
        </div>
        <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-4" aria-label="Zone area legend">
          {summaries.map((s) => (
            <li
              key={s.id}
              onPointerEnter={() => setHover(s.id)}
              onPointerLeave={() => setHover(null)}
              className={cn(
                "flex min-w-0 items-baseline gap-2 rounded-md px-1 text-xs transition-opacity",
                hover !== null && hover !== s.id && "opacity-50",
              )}
            >
              <span aria-hidden="true" className="size-2.5 shrink-0 translate-y-px rounded-[3px]" style={{ backgroundColor: s.color }} />
              <span className="min-w-0 truncate text-ink">{s.name}</span>
              <span className="kpi-number ml-auto shrink-0 font-mono text-ink-strong">{fmtPct(s.share, 1)}</span>
              <span className="kpi-number shrink-0 font-mono text-[11px] text-ink-faint">
                {isNum(s.deltaSharePp) ? `${fmtSigned(s.deltaSharePp, 1)} pp` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
