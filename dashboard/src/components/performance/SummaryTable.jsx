/**
 * Sortable cross-validation summary (TanStack Table v8): one row per model × scheme with
 * mean ± SD of R², RMSE and MAE across folds, fold count, mean fit time and devices.
 *
 * The best model of each scheme is highlighted per metric (trophy icon + bold ink + an
 * sr-only "best" suffix, so the highlight never relies on colour). Headers are real
 * buttons with aria-sort on the <th>, so sorting is keyboard- and screen-reader-operable.
 * A scheme filter narrows the table without repainting the scheme dots (colour follows the
 * scheme, never its row position).
 */
import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Trophy } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { fmt, isNum, MISSING } from "../../lib/format.js";
import SegmentedToggle from "../shap/SegmentedToggle.jsx";
import { formatDuration, METRICS, modelLabel, schemeMeta } from "./perfModel.js";

/** mean ± sd cell with best-in-scheme highlighting. */
function MetricCell({ row, metric }) {
  const mean = row[`${metric.key}_mean`];
  const sd = row[`${metric.key}_std`];
  const best = row.best?.[metric.key];
  if (!isNum(mean)) return <span className="text-ink-faint">{MISSING}</span>;
  return (
    <span className={cn("inline-flex items-center justify-end gap-1.5", best ? "font-semibold text-ink-strong" : "text-ink")}>
      {best && <Trophy aria-hidden="true" className="size-3 text-cyan" />}
      <span>{fmt(mean, metric.dp)}</span>
      <span className="text-[11px] font-normal text-ink-faint">{isNum(sd) ? `± ${fmt(sd, metric.dp)}` : ""}</span>
      {best && <span className="sr-only">(best in scheme)</span>}
    </span>
  );
}

function SortIcon({ state }) {
  if (state === "asc") return <ArrowUp aria-hidden="true" className="size-3 text-cyan" />;
  if (state === "desc") return <ArrowDown aria-hidden="true" className="size-3 text-cyan" />;
  return <ArrowUpDown aria-hidden="true" className="size-3 opacity-40 group-hover:opacity-80" />;
}

/**
 * @param {{rows: ReturnType<import("./perfModel.js").summaryTableRows>, schemes: string[]}} props
 */
export function SummaryTable({ rows, schemes }) {
  const [sorting, setSorting] = useState([]);
  const [schemeFilter, setSchemeFilter] = useState("all");

  const columns = useMemo(
    () => [
      {
        id: "model",
        header: "Model",
        accessorFn: (r) => r.modelOrder,
        sortDescFirst: false,
        cell: ({ row }) => <span className="font-sans text-ink">{modelLabel(row.original.model)}</span>,
        meta: { align: "left" },
      },
      {
        id: "scheme",
        header: "Scheme",
        accessorFn: (r) => r.schemeOrder,
        sortDescFirst: false,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 font-sans text-ink">
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ backgroundColor: schemeMeta(row.original.scheme).color }}
            />
            {schemeMeta(row.original.scheme).label}
          </span>
        ),
        meta: { align: "left" },
      },
      ...METRICS.map((metric) => ({
        id: metric.key,
        header: `${metric.label}${metric.unit ? ` (${metric.unit})` : ""}`,
        accessorFn: (r) => r[`${metric.key}_mean`],
        sortUndefined: "last",
        // Default first click sorts best-first: descending for R², ascending for errors.
        sortDescFirst: metric.better === "higher",
        cell: ({ row }) => <MetricCell row={row.original} metric={metric} />,
        meta: { align: "right", description: metric.description },
      })),
      {
        id: "nFolds",
        header: "Folds",
        accessorFn: (r) => r.nFolds,
        sortUndefined: "last",
        cell: ({ getValue }) => <span className="text-ink-muted">{isNum(getValue()) ? getValue() : MISSING}</span>,
        meta: { align: "right" },
      },
      {
        id: "fit",
        header: "Fit / fold",
        accessorFn: (r) => r.meanFitSeconds,
        sortUndefined: "last",
        cell: ({ getValue }) => <span className="text-ink-muted">{formatDuration(getValue())}</span>,
        meta: { align: "right" },
      },
      {
        id: "devices",
        header: "Device",
        accessorFn: (r) => r.devices.join(", "),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-[11px] text-ink-muted">{row.original.devices.length ? row.original.devices.join(", ") : MISSING}</span>
        ),
        meta: { align: "left" },
      },
    ],
    [],
  );

  const data = useMemo(
    () => (schemeFilter === "all" ? rows : rows.filter((r) => r.scheme === schemeFilter)),
    [rows, schemeFilter],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const filterOptions = [
    { value: "all", label: "All schemes" },
    ...schemes.map((s) => ({ value: s, label: schemeMeta(s).label, dot: schemeMeta(s).color })),
  ];
  const visible = table.getRowModel().rows;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedToggle
          label="Filter summary by validation scheme"
          options={filterOptions}
          value={schemeFilter}
          onChange={setSchemeFilter}
          layoutId="perf-summary-scheme"
        />
        <p className="text-[11px] text-ink-faint">
          <Trophy aria-hidden="true" className="mr-1 inline size-3 -translate-y-px text-cyan" />
          best model per scheme · click a header to sort
        </p>
      </div>
      <div className="scrollbar-thin overflow-x-auto rounded-xl border border-panel-border">
        <table className="w-full min-w-[720px] border-collapse text-xs">
          <caption className="sr-only">
            Cross-validation summary: mean and standard deviation across folds for every model and validation scheme.
          </caption>
          <thead className="bg-bg-raised/70 text-[11px] uppercase tracking-wider text-ink-faint">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const align = header.column.columnDef.meta?.align ?? "left";
                  const canSort = header.column.getCanSort();
                  const label = flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                      className={cn("whitespace-nowrap px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}
                      title={header.column.columnDef.meta?.description}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "focus-ring group inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider",
                            "transition-colors hover:text-ink",
                            sorted ? "text-cyan-soft" : "",
                            align === "right" && "flex-row-reverse",
                          )}
                        >
                          {label}
                          <SortIcon state={sorted} />
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="kpi-number font-mono">
            {visible.map((row) => (
              <tr key={row.id} className="border-t border-panel-border/60 transition-colors hover:bg-slate-800/40">
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={cn(
                      "whitespace-nowrap px-3 py-1.5",
                      (cell.column.columnDef.meta?.align ?? "left") === "right" ? "text-right" : "text-left",
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center font-sans text-ink-muted">
                  No summary rows for this scheme.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
