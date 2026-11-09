/**
 * Chart panel with its table twin (UI_SPEC §3.5 "Every chart has a `Table ⊞` toggle", §12
 * "Every chart has a table view"). The table is a real <table> with a caption, scoped headers
 * and right-aligned numerals — the WCAG-clean equivalent of the chart, never a tooltip dump.
 *
 * Props
 *   title     panel heading (micro label)
 *   columns   [{key, label, align?: "left"|"right", format?: (v, row) => node, title?}]
 *   rows      array of plain objects (one table row each)
 *   caption   one-sentence description read by screen readers and shown under the table
 *   children  the chart (rendered when the chart view is active)
 *   actions   extra header controls (shown in both views)
 *   status    optional {status, reason} — loading / unavailable / error replaces the body
 *   defaultView "chart" | "table"
 */
import { useId, useState } from "react";
import { Table2, LineChart } from "lucide-react";
import { HudFrame } from "../components/ui/HudFrame.jsx";
import { ScanSkeleton } from "../components/ui/ScanSkeleton.jsx";
import { MISSING } from "../lib/format.js";
import { cn } from "../lib/cn.js";
import { Unavailable } from "./Unavailable.jsx";

export function ChartTable({
  title,
  columns = [],
  rows = [],
  caption,
  children,
  actions,
  status = null,
  defaultView = "chart",
  className,
  bodyClassName,
  scanId,
  id,
  maxTableHeight = 360,
}) {
  const [view, setView] = useState(defaultView);
  const tableId = useId().replace(/:/g, "");
  const isTable = view === "table";
  const blocked = status && status.status !== "ready";
  const toggle = (
    <button
      type="button"
      onClick={() => setView(isTable ? "chart" : "table")}
      aria-pressed={isTable}
      aria-controls={tableId}
      disabled={blocked || !rows.length}
      title={isTable ? "Show chart" : "Show the data as a table"}
      className="focus-ring inline-flex h-7 items-center gap-1 rounded-md border border-control/70 px-2 text-[11px] text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
    >
      {isTable ? <LineChart aria-hidden="true" className="size-3.5" /> : <Table2 aria-hidden="true" className="size-3.5" />}
      {isTable ? "Chart" : "Table"}
    </button>
  );
  return (
    <HudFrame solid title={title} id={id} scanId={scanId} className={cn("min-w-0", className)} actions={<>{actions}{toggle}</>}>
      <div id={tableId} className={bodyClassName}>
        {blocked ? (
          status.status === "loading" || status.status === "idle" ? (
            <ScanSkeleton label={`Loading ${typeof title === "string" ? title.toLowerCase() : "chart"}`} height={160} />
          ) : (
            <Unavailable status={status.status} reason={status.reason} />
          )
        ) : isTable ? (
          <div className="scrollbar-thin overflow-auto" style={{ maxHeight: maxTableHeight }}>
            <table className="w-full border-collapse text-left text-xs">
              {caption && <caption className="sr-only">{caption}</caption>}
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" title={c.title} className={cn("border-b border-hairline px-2 py-1.5 font-sans text-[11px] font-medium text-ink-faint", c.align === "right" && "text-right")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={row.id ?? r} className="border-b border-hairline/60 last:border-0">
                    {columns.map((c, k) => {
                      const v = row[c.key];
                      const body = c.format ? c.format(v, row) : v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? MISSING : v;
                      const Cell = k === 0 ? "th" : "td";
                      return (
                        <Cell key={c.key} scope={k === 0 ? "row" : undefined} className={cn("px-2 py-1 font-normal text-ink", c.align === "right" && "tnum text-right font-mono")}>
                          {body}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {caption && <p className="mt-2 text-[11px] text-ink-faint">{caption}</p>}
          </div>
        ) : (
          children
        )}
      </div>
    </HudFrame>
  );
}

export default ChartTable;
