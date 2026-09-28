/**
 * Policy engine: every zone's threshold-based recommendation merged into one sortable,
 * filterable table (TanStack Table v8).
 *
 * - Default order: expected ΔLST ascending (largest cooling first). Any column with a
 *   button header sorts; aria-sort is set on the <th>.
 * - Filters: priority (segmented), feature (select) and zone (toggle chips), all combined.
 * - Each row expands to its full rationale (button with aria-expanded) instead of
 *   truncating it silently.
 * Expected deltas are model-based ceteris-paribus estimates for the zone's cells (the notebook's
 * final model re-run with one lever moved; associations, not causal effects); they are NOT
 * additive across rows, so the table never sums them.
 */
import { Fragment, useCallback, useMemo, useState } from "react";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, FilterX } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { featureLabel, featureMeta, fmtFeatureValue, isNum } from "../../lib/format.js";
import { Button } from "../ui/Button.jsx";
import { Select } from "../ui/Select.jsx";
import SegmentedToggle from "../shap/SegmentedToggle.jsx";
import { ActionVerb, DeltaWithCi, PriorityBadge } from "./ZoneCardParts.jsx";
import { PRIORITIES } from "./zoneModel.js";

function SortIcon({ state }) {
  if (state === "asc") return <ArrowUp aria-hidden="true" className="size-3 text-cyan" />;
  if (state === "desc") return <ArrowDown aria-hidden="true" className="size-3 text-cyan" />;
  return <ArrowUpDown aria-hidden="true" className="size-3 opacity-40 group-hover:opacity-80" />;
}

const ALL = "all";

/**
 * @param {{rows: ReturnType<import("./zoneModel.js").mergeRecommendations>, zoneList: object[],
 *          manifest: object}} props
 */
export function PolicyTable({ rows, zoneList, manifest, ciLabel = "95% CI" }) {
  const [sorting, setSorting] = useState([{ id: "delta", desc: false }]);
  const [priority, setPriority] = useState(ALL);
  const [feature, setFeature] = useState(ALL);
  const [hiddenZones, setHiddenZones] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());

  const featureOptions = useMemo(() => {
    const names = [...new Set(rows.map((r) => r.feature))];
    names.sort((a, b) => featureLabel(manifest, a).localeCompare(featureLabel(manifest, b)));
    return [{ value: ALL, label: "All features" }, ...names.map((n) => ({ value: n, label: featureLabel(manifest, n) }))];
  }, [rows, manifest]);

  const data = useMemo(
    () =>
      rows.filter(
        (r) =>
          (priority === ALL || r.priority === priority) &&
          (feature === ALL || r.feature === feature) &&
          !hiddenZones.has(r.zoneId),
      ),
    [rows, priority, feature, hiddenZones],
  );

  const toggleExpanded = useCallback(
    (id) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const columns = useMemo(
    () => [
      {
        id: "zone",
        header: "Zone",
        accessorFn: (r) => r.zoneId,
        sortDescFirst: false,
        cell: ({ row }) => (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-ink">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: row.original.zoneColor }} />
            <span className="truncate">{row.original.zoneName}</span>
          </span>
        ),
      },
      {
        id: "action",
        header: "Action",
        accessorFn: (r) => featureLabel(manifest, r.feature),
        cell: ({ row }) => (
          <span className="text-xs">
            <ActionVerb action={row.original.action} />{" "}
            <span className="text-ink">{featureLabel(manifest, row.original.feature)}</span>
          </span>
        ),
      },
      {
        id: "change",
        header: "Current → target",
        enableSorting: false,
        cell: ({ row }) => {
          const meta = featureMeta(manifest, row.original.feature);
          return (
            <span className="kpi-number whitespace-nowrap font-mono text-ink-muted">
              {fmtFeatureValue(meta, row.original.current)} <span className="text-ink-faint">→</span>{" "}
              <span className="text-ink">{fmtFeatureValue(meta, row.original.target)}</span>
            </span>
          );
        },
      },
      {
        id: "delta",
        header: `Model ΔLST · ${ciLabel}`,
        accessorFn: (r) => (isNum(r.delta) ? r.delta : undefined),
        sortUndefined: "last",
        cell: ({ row }) => <DeltaWithCi delta={row.original.delta} ci={row.original.ci} compact ciLabel={ciLabel} />,
        meta: { align: "right" },
      },
      {
        id: "priority",
        header: "Priority",
        accessorFn: (r) => r.priorityRank,
        sortDescFirst: false,
        cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
      },
      {
        id: "why",
        header: "Rationale",
        enableSorting: false,
        cell: ({ row }) => {
          const open = expanded.has(row.id);
          return (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} rationale for ${row.original.zoneName}: ${featureLabel(manifest, row.original.feature)}`}
              onClick={() => toggleExpanded(row.id)}
              className="focus-ring group inline-flex max-w-[22rem] items-center gap-1 rounded text-left text-[11px] text-ink-muted hover:text-ink"
            >
              <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
              <span className="truncate">{row.original.rationale || "—"}</span>
            </button>
          );
        },
      },
    ],
    [manifest, expanded, toggleExpanded, ciLabel],
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

  const filtersActive = priority !== ALL || feature !== ALL || hiddenZones.size > 0;
  const resetFilters = () => {
    setPriority(ALL);
    setFeature(ALL);
    setHiddenZones(new Set());
  };
  const visible = table.getRowModel().rows;

  if (!rows.length) {
    return (
      <p className="py-6 text-center text-xs text-ink-muted">
        No zone has a threshold-based action with an expected cooling above 0.05 °C in this bundle.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">Priority</span>
          <SegmentedToggle
            label="Filter by priority"
            options={[{ value: ALL, label: "All" }, ...PRIORITIES.map((p) => ({ value: p.id, label: p.label }))]}
            value={priority}
            onChange={setPriority}
            layoutId="policy-priority"
          />
        </div>
        <Select
          label="Feature"
          size="sm"
          value={feature}
          onValueChange={setFeature}
          options={featureOptions}
          className="w-48"
        />
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">Zones</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show or hide zones">
            {zoneList.map((z) => {
              const on = !hiddenZones.has(z.id);
              return (
                <button
                  key={z.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setHiddenZones((prev) => {
                      const next = new Set(prev);
                      if (next.has(z.id)) next.delete(z.id);
                      else next.add(z.id);
                      return next;
                    })
                  }
                  className={cn(
                    "focus-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    on ? "border-slate-400/40 bg-slate-800/70 text-ink" : "border-panel-border text-ink-faint hover:text-ink-muted",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-2 rounded-full transition-opacity", on ? "opacity-100" : "opacity-30")}
                    style={{ backgroundColor: z.color }}
                  />
                  {z.name}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[11px] text-ink-faint" aria-live="polite">
            {visible.length} / {rows.length} actions
          </span>
          {filtersActive && (
            <Button variant="ghost" size="xs" onClick={resetFilters}>
              <FilterX aria-hidden="true" />
              Reset
            </Button>
          )}
        </div>
      </div>

      <div className="scrollbar-thin overflow-x-auto rounded-xl border border-panel-border">
        <table className="w-full min-w-[820px] border-collapse text-xs">
          <caption className="sr-only">
            Recommendations across all governance zones, with the model-based change in land surface temperature and its
            bootstrap {ciLabel}. Expected changes are associations, not causal effects, and are not additive across rows.
          </caption>
          <thead className="bg-bg-raised/70 text-[11px] uppercase tracking-wider text-ink-faint">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const right = header.column.columnDef.meta?.align === "right";
                  const label = flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                      className={cn("whitespace-nowrap px-3 py-2 font-medium", right ? "text-right" : "text-left")}
                    >
                      {header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "focus-ring group inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider transition-colors hover:text-ink",
                            sorted && "text-cyan-soft",
                            right && "flex-row-reverse",
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
          <tbody>
            {visible.map((row) => (
              <Fragment key={row.id}>
                <tr className="border-t border-panel-border/60 align-middle transition-colors hover:bg-slate-800/40">
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cn("px-3 py-2", cell.column.columnDef.meta?.align === "right" ? "text-right" : "text-left")}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
                {expanded.has(row.id) && (
                  <tr className="bg-bg-raised/40">
                    <td colSpan={columns.length} className="px-3 pb-3 pt-1 text-xs leading-relaxed text-ink-muted">
                      <span
                        aria-hidden="true"
                        className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                        style={{ backgroundColor: row.original.zoneColor }}
                      />
                      {row.original.rationale || "No rationale exported."}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-ink-muted">
                  No recommendation matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Model ΔLST is the mean change in the final model&apos;s prediction over the zone&apos;s cells when every cell moves by
        the shown step (current → target are zone medians; land-cover changes are rebalanced against the other covers and the
        coupled spectral indices follow). The interval re-evaluates the same change with every block-bootstrap replicate model.
        These are model-based associations, not causal effects, and several actions are not additive - use the scenario
        simulator in the threshold explorer to test a combination on the in-browser model.
      </p>
    </div>
  );
}
