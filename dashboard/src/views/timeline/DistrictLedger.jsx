/**
 * DISTRICT LEDGER (UI_SPEC §3.5): a real, sortable <table> (TanStack Table v8) of the 25
 * districts — rank by the NOW day mean, Δ day and Δ night between the first and last
 * observed frames (frame-level CIs in quadrature in the tooltip), signed surface UHI (urban −
 * rural) by day and night at NOW, the sparkfan 1990–2050 on a shared scale and the selected
 * SSP's 2050 p50 with its change vs the weather-normalised baseline (D14). Header buttons sort
 * (aria-sort); a row click / Enter makes the district the scope; hovering highlights the district
 * in every linked chart.
 *
 * Honesty guards: the Δ columns use observed-evidence frames only (never a modelled hindcast) and
 * read "n/a" with the reason when the bundle's levels are not harmonised across sensors; the
 * projection column is hidden when the bundle has no projections.
 */
import { useMemo, useState } from "react";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { Delta } from "../../components/ui/Delta.jsx";
import { fmt, fmtPlusMinus, fmtSigned, MISSING } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { MODE_STYLE, sspStyle } from "../../viz/chartTheme.js";
import { Sparkfan } from "../../viz/Sparkfan.jsx";
import { useLinkStore } from "../../viz/linking.js";
import { LEVELS_NOT_HARMONISED, sparkDomain } from "./timelineModel.js";

const num = (v) => (Number.isFinite(v) ? v : null);
/** Sort NaN last in both directions. */
const nanLast = (a, b, id) => {
  const x = a.getValue(id);
  const y = b.getValue(id);
  const fx = Number.isFinite(x);
  const fy = Number.isFinite(y);
  if (!fx && !fy) return 0;
  if (!fx) return 1;
  if (!fy) return -1;
  return x - y;
};

/**
 * @param {{rows: object[], now: number, first?: number, last: number, ssp: string|null, nightAvailable: boolean,
 *          harmonised?: boolean, projections?: boolean, selectedScope: string, onSelect: (scopeId: string) => void}} props
 */
export function DistrictLedger({ rows, now, first = 1990, last, ssp, nightAvailable, harmonised = true, projections = true, selectedScope, onSelect }) {
  const [sorting, setSorting] = useState([{ id: "rank", desc: false }]);
  const hoverScope = useLinkStore((s) => s.hoverScope);
  const setHoverScope = useLinkStore((s) => s.setHoverScope);
  const yDomain = useMemo(() => sparkDomain(rows), [rows]);

  const columns = useMemo(
    () => [
      { id: "rank", accessorKey: "rank", header: "#", sortingFn: nanLast, cell: (c) => <span className="tnum font-mono text-ink-muted">{c.getValue() ?? MISSING}</span> },
      { id: "label", accessorKey: "label", header: "District", cell: (c) => <span className="text-ink">{c.getValue()}</span> },
      { id: "state", accessorKey: "state", header: "State", cell: (c) => <span className="text-ink-muted">{c.getValue() || MISSING}</span> },
      {
        id: "dayDelta",
        accessorKey: "dayDelta",
        header: "Day Δ",
        sortingFn: nanLast,
        cell: (c) => (harmonised ? <DeltaCell value={c.getValue()} ci={c.row.original.dayCi} from={c.row.original.dayFrom} to={now} /> : <NotHarmonised />),
      },
      {
        id: "nightDelta",
        accessorKey: "nightDelta",
        header: "Night Δ",
        sortingFn: nanLast,
        cell: (c) =>
          !nightAvailable ? <span className="text-ink-faint">n/a</span> : harmonised ? <DeltaCell value={c.getValue()} ci={c.row.original.nightCi} from={c.row.original.nightFrom} to={now} /> : <NotHarmonised />,
      },
      { id: "uhiDay", accessorKey: "uhiDay", header: "UHI (d)", sortingFn: nanLast, cell: (c) => <Delta value={num(c.getValue())} dp={2} context="surface UHI by day" /> },
      {
        id: "uhiNight",
        accessorKey: "uhiNight",
        header: "UHI (n)",
        sortingFn: nanLast,
        cell: (c) => (nightAvailable ? <Delta value={num(c.getValue())} dp={2} context="surface UHI at night" /> : <span className="text-ink-faint">n/a</span>),
      },
      {
        id: "spark",
        header: `Day ${first}–${last}`,
        enableSorting: false,
        cell: (c) => (
          <Sparkfan obs={c.row.original.spark.obs} fan={c.row.original.spark.fan} baseline={c.row.original.spark.baseline ?? null} ssp={ssp} now={now} xDomain={[first, last]} yDomain={yDomain} color={MODE_STYLE.day.accent} width={112} height={24} />
        ),
      },
      ...(projections
        ? [
            {
              id: "p2050",
              accessorKey: "p2050",
              header: `${last} p50`,
              sortingFn: nanLast,
              cell: (c) => {
                const v = c.getValue();
                const d = c.row.original.p2050Delta;
                if (!Number.isFinite(v)) return <span className="text-ink-faint">{MISSING}</span>;
                return (
                  <span className="tnum font-mono" title={Number.isFinite(d) ? `${fmtSigned(d, 1)} °C vs the weather-normalised ${now} baseline (p50)` : undefined}>
                    {fmt(v, 1)} °C{Number.isFinite(d) ? <span className="text-ink-muted"> ({fmtSigned(d, 1)})</span> : null}
                  </span>
                );
              },
            },
          ]
        : []),
    ],
    [nightAvailable, harmonised, projections, now, first, last, ssp, yDomain],
  );

  const table = useReactTable({ data: rows, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });

  return (
    <HudFrame solid title={`District ledger · ${rows.length} districts`} className="min-w-0">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left text-xs">
          <caption className="sr-only">
            Districts ranked by the {now} day mean. Δ = change of the frame mean between the first and last observed frames (not a trend){harmonised ? "" : "; not shown because the levels are not harmonised across sensors"}. UHI = surface urban − rural, signed. Sparkfan: observed frames and {ssp ? sspStyle(ssp).label : "no"} projection, shared scale. Select a row to scope the timeline to that district.
          </caption>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const can = h.column.getCanSort();
                  return (
                    <th key={h.id} scope="col" aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"} className="border-b border-hairline px-2 py-1.5 font-sans text-[11px] font-medium text-ink-faint">
                      {can ? (
                        <button type="button" onClick={h.column.getToggleSortingHandler()} className="focus-ring inline-flex items-center gap-1 rounded hover:text-ink">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" ? <ArrowUp aria-hidden="true" className="size-3" /> : sorted === "desc" ? <ArrowDown aria-hidden="true" className="size-3" /> : <ArrowUpDown aria-hidden="true" className="size-3 opacity-50" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const id = row.original.id;
              const selected = id === selectedScope;
              return (
                <tr
                  key={row.id}
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => onSelect(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(id);
                    }
                  }}
                  onMouseEnter={() => setHoverScope(id)}
                  onMouseLeave={() => setHoverScope(null)}
                  onFocus={() => setHoverScope(id)}
                  onBlur={() => setHoverScope(null)}
                  className={cn("focus-ring cursor-pointer border-b border-hairline/60", selected ? "bg-signal/10" : id === hoverScope ? "bg-surface-3/70" : "hover:bg-surface-3/50")}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-2 py-1 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </HudFrame>
  );
}

function NotHarmonised() {
  return (
    <span className="text-ink-faint" title={LEVELS_NOT_HARMONISED}>
      n/a
    </span>
  );
}

function DeltaCell({ value, ci, from, to }) {
  if (!Number.isFinite(value)) return <span className="text-ink-faint">{MISSING}</span>;
  return (
    <span className="inline-flex items-baseline gap-1" title={`${from ?? ""} → ${to}: change of frame means${Number.isFinite(ci) ? `, ${fmtPlusMinus(ci, 1)} (frame CIs in quadrature)` : ""}`}>
      <Delta value={value} dp={1} context={`since ${from ?? "first frame"}`} />
      {Number.isFinite(ci) && <span className="font-mono text-[10.5px] text-ink-faint">{fmtPlusMinus(ci, 1, "")}</span>}
    </span>
  );
}

export default DistrictLedger;
