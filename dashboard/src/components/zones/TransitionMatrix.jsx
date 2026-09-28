/**
 * Zone transition matrix between two epochs (rows = zone in the earlier epoch, columns =
 * zone in the later epoch; the same grid cells are followed through time).
 *
 * Each cell shows the cell count and the row percentage (where that zone's cells went).
 * Shading is a single-hue sequential encoding of the row percentage; the diagonal
 * (persistence) is outlined, and off-diagonal flows INTO the Heat Extreme Core carry a
 * rose ring + arrow icon because they are the policy-relevant signal. Inflow / outflow /
 * net rows summarise every zone; the headline reports the core's net gain in cells and
 * km². Rendered as a real <table> so it is fully readable by screen readers.
 */
import { useMemo, useState } from "react";
import { ArrowRightLeft, Flame } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { fmtInt, fmtPct, fmtSigned, isNum, MISSING } from "../../lib/format.js";
import { Select } from "../ui/Select.jsx";
import { defaultPair, HEAT_CORE_ID, transitionPairs, transitionStats } from "./zoneModel.js";

/** Cyan wash whose opacity follows the row share (0..1). */
function cellBackground(pct) {
  if (!isNum(pct) || pct <= 0) return "transparent";
  return `rgba(34, 211, 238, ${(0.06 + 0.5 * Math.sqrt(pct)).toFixed(3)})`;
}

/**
 * @param {{transitions: object|null, zoneList: object[], year: number|null, cellArea: number}} props
 */
export function TransitionMatrix({ transitions, zoneList, year, cellArea }) {
  const pairs = useMemo(() => transitionPairs(transitions), [transitions]);
  const [choice, setChoice] = useState(null);
  const pairKey = pairs.some((p) => p.key === choice) ? choice : defaultPair(pairs, year);
  const pair = pairs.find((p) => p.key === pairKey) ?? null;
  const stats = useMemo(() => (pair ? transitionStats(transitions?.[pair.key]) : null), [pair, transitions]);
  const [hover, setHover] = useState(null);

  if (!pairs.length) {
    return <p className="py-6 text-center text-xs text-ink-muted">No zone transitions were exported (needs at least two epochs).</p>;
  }

  const zoneAt = (i) => zoneList.find((z) => z.id === i) ?? { id: i, name: `Zone ${i}`, color: "#94a3b8" };
  const core = HEAT_CORE_ID;
  const coreNet = stats && stats.k > core ? stats.net[core] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select
          label="Epoch pair"
          size="sm"
          value={pairKey ?? ""}
          onValueChange={setChoice}
          options={pairs.map((p) => ({ value: p.key, label: `${p.from} → ${p.to}` }))}
          className="w-40"
        />
        {stats && (
          <div className="flex flex-wrap gap-2 text-xs">
            {isNum(coreNet) && (
              <div className="flex items-center gap-2 rounded-lg border border-rose/35 bg-rose/10 px-3 py-1.5">
                <Flame aria-hidden="true" className="size-4 text-rose" />
                <span className="text-ink">
                  Net flow into {zoneAt(core).name}:{" "}
                  <strong className="kpi-number font-mono text-ink-strong">{fmtSigned(coreNet, 0)} cells</strong>{" "}
                  <span className="font-mono text-ink-muted">({fmtSigned(coreNet * cellArea, 0)} km²)</span>
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-panel-border bg-bg-raised/50 px-3 py-1.5">
              <ArrowRightLeft aria-hidden="true" className="size-4 text-cyan" />
              <span className="text-ink">
                Persistence <strong className="kpi-number font-mono text-ink-strong">{fmtPct(stats.persistence, 1)}</strong>{" "}
                <span className="text-ink-muted">of {fmtInt(stats.total)} cells kept their zone</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {!stats ? (
        <p className="py-6 text-center text-xs text-ink-muted">The {pairKey} matrix is malformed and cannot be shown.</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[560px] border-separate border-spacing-[3px] text-xs">
            <caption className="sr-only">
              Zone transitions from {pair.from} (rows) to {pair.to} (columns): cell counts and row percentages.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                  {pair.from} ↓ · {pair.to} →
                </th>
                {stats.counts[0].map((_, j) => {
                  const z = zoneAt(j);
                  return (
                    <th
                      key={j}
                      scope="col"
                      className={cn(
                        "px-2 py-1 text-left text-[11px] font-medium transition-colors",
                        hover?.j === j ? "text-ink-strong" : "text-ink-muted",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: z.color }} />
                        {z.name}
                      </span>
                    </th>
                  );
                })}
                <th scope="col" className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.counts.map((row, i) => {
                const from = zoneAt(i);
                return (
                  <tr key={i}>
                    <th
                      scope="row"
                      className={cn(
                        "whitespace-nowrap px-2 py-1 text-left text-[11px] font-medium transition-colors",
                        hover?.i === i ? "text-ink-strong" : "text-ink-muted",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: from.color }} />
                        {from.name}
                      </span>
                    </th>
                    {row.map((count, j) => {
                      const pct = stats.rowPct[i][j];
                      const diagonal = i === j;
                      const intoCore = j === core && i !== core && count > 0;
                      const dimmed = hover && hover.i !== i && hover.j !== j;
                      return (
                        <td
                          key={j}
                          onPointerEnter={() => setHover({ i, j })}
                          onPointerLeave={() => setHover(null)}
                          aria-label={`${from.name} to ${zoneAt(j).name}: ${fmtInt(count)} cells, ${fmtPct(pct, 1)} of ${from.name}${
                            intoCore ? ", flow into the heat core" : ""
                          }`}
                          className={cn(
                            "relative rounded-md px-2 py-1.5 text-right align-top transition-opacity duration-150",
                            diagonal && "outline-dashed outline-1 -outline-offset-2 outline-slate-400/50",
                            intoCore && "shadow-[inset_0_0_0_1.5px_rgba(251,113,133,0.85)]",
                            dimmed && "opacity-45",
                          )}
                          style={{ backgroundColor: cellBackground(pct) }}
                        >
                          {intoCore && (
                            <Flame aria-hidden="true" className="absolute left-1.5 top-1.5 size-3 text-rose" />
                          )}
                          <span className="kpi-number block font-mono text-[12px] font-semibold text-ink-strong">
                            {fmtInt(count)}
                          </span>
                          <span className="kpi-number block font-mono text-[10.5px] text-ink">{isNum(pct) ? fmtPct(pct, 1) : MISSING}</span>
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 text-right font-mono text-[11px] text-ink-muted">{fmtInt(stats.rowTotals[i])}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="text-[11px]">
              {[
                { key: "in", label: "Inflow", values: stats.inflow, signed: false },
                { key: "out", label: "Outflow", values: stats.outflow, signed: false },
                { key: "net", label: "Net", values: stats.net, signed: true },
              ].map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="px-2 py-1 text-left font-medium uppercase tracking-wider text-ink-faint">
                    {r.label}
                  </th>
                  {r.values.map((v, j) => (
                    <td
                      key={j}
                      className={cn(
                        "kpi-number px-2 py-1 text-right font-mono",
                        r.key === "net" ? "font-semibold text-ink-strong" : "text-ink-muted",
                        r.key === "net" && j === core && "rounded-md bg-rose/10",
                      )}
                    >
                      {r.signed ? fmtSigned(v, 0) : fmtInt(v)}
                      {r.key === "net" && (
                        <span className="block text-[10px] font-normal text-ink-faint">{fmtSigned(v * cellArea, 0)} km²</span>
                      )}
                    </td>
                  ))}
                  <td />
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Rows: zone in {pair?.from ?? "the earlier epoch"}; columns: zone in {pair?.to ?? "the later epoch"}; shading = row share.
        Dashed = cells that stayed; <span className="text-ink-muted">rose ring</span> = cells that moved into the heat core.
        Zones are defined on SHAP mechanisms, so a transition means the drivers of heat changed, not just the temperature.
      </p>
    </div>
  );
}
