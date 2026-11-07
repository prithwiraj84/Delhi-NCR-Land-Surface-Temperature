/**
 * DAY − NIGHT importance (UI_SPEC §3.6 "Day−Night Δ view shows where driver signs flip"):
 * a butterfly of mean |SHAP| — day bars to the left (solar), night bars to the right (lunar),
 * one shared °C scale — with each driver's direction (↑ warming / ↓ cooling, from the
 * dependence analysis) per mode and a "sign flips" mark where they disagree. Sorted by the
 * size of the day − night difference. Rows are buttons that select the driver.
 */
import { useMemo } from "react";
import { ArrowDownRight, ArrowUpRight, Repeat } from "lucide-react";
import { fmt, fmtSigned } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { MODE_STYLE } from "../../viz/chartTheme.js";
import { importanceDiff } from "./driversModel.js";

function Dir({ dir, mode }) {
  if (!dir) return <span className="w-3" aria-hidden="true" />;
  const Icon = dir === "warming" ? ArrowUpRight : ArrowDownRight;
  return <Icon role="img" aria-label={`${dir} by ${mode}`} className="size-3 shrink-0 text-ink-muted" />;
}

/**
 * @param {{shapGlobal: object|null, dependence: object|null, labelOf: (id: string) => string,
 *          selected?: string|null, onSelect?: (id: string) => void, reason?: string|null}} props
 */
export function ImportanceDiff({ shapGlobal, dependence, labelOf, selected, onSelect, reason = null }) {
  const rows = useMemo(() => importanceDiff(shapGlobal, dependence), [shapGlobal, dependence]);
  const max = Math.max(1e-6, ...rows.map((r) => Math.max(r.day, r.night)));
  const flips = rows.filter((r) => r.flip).length;
  const status = reason ? { status: "unavailable", reason } : rows.length ? { status: "ready" } : { status: "unavailable", reason: "Day − night comparison needs SHAP for both modes (night drivers are unavailable in a v1 bundle — rerun notebook v2)." };

  return (
    <ChartTable
      title={`Day vs night importance${flips ? ` · ${flips} sign flips` : ""}`}
      status={status}
      columns={[
        { key: "label", label: "Driver" },
        { key: "day", label: "Day |SHAP| °C", align: "right", format: (v) => fmt(v, 3) },
        { key: "night", label: "Night |SHAP| °C", align: "right", format: (v) => fmt(v, 3) },
        { key: "diff", label: "Day − night", align: "right", format: (v) => fmtSigned(v, 3) },
        { key: "dirDay", label: "Direction (day)" },
        { key: "dirNight", label: "Direction (night)" },
      ]}
      rows={rows.map((r) => ({ ...r, label: labelOf(r.id) }))}
      caption="Mean absolute SHAP of each driver by day and at night on the same °C scale, with the dependence direction in each mode. A sign flip means the driver warms in one mode and cools in the other."
    >
      <div className="mb-1.5 grid grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1fr)] gap-2 text-[11px] text-ink-faint">
        <span className="text-right" style={{ color: MODE_STYLE.day.accent }}>
          ← Day mean |SHAP|
        </span>
        <span />
        <span style={{ color: MODE_STYLE.night.accent }}>Night mean |SHAP| →</span>
      </div>
      <ol className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect?.(r.id)}
              aria-pressed={r.id === selected}
              aria-label={`${labelOf(r.id)}: day ${fmt(r.day, 3)} °C${r.dirDay ? ` ${r.dirDay}` : ""}, night ${fmt(r.night, 3)} °C${r.dirNight ? ` ${r.dirNight}` : ""}${r.flip ? ", sign flips between day and night" : ""}`}
              className={cn("focus-ring grid w-full grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1fr)] items-center gap-2 rounded px-1 py-0.5 text-left", r.id === selected ? "bg-signal/10" : "hover:bg-surface-3/60")}
            >
              <span className="flex items-center justify-end gap-1">
                <span className="tnum font-mono text-[10.5px] text-ink-muted">{fmt(r.day, 2)}</span>
                <Dir dir={r.dirDay} mode="day" />
                <span className="h-2 rounded-l-[3px]" style={{ width: `${(r.day / max) * 100}%`, minWidth: 1, backgroundColor: MODE_STYLE.day.accent }} />
              </span>
              <span className="flex items-center justify-center gap-1 truncate text-center text-[11px] text-ink">
                {r.flip && <Repeat role="img" aria-label="sign flips" className="size-3 shrink-0 text-warn" />}
                <span className="truncate">{labelOf(r.id)}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 rounded-r-[3px]" style={{ width: `${(r.night / max) * 100}%`, minWidth: 1, backgroundColor: MODE_STYLE.night.accent }} />
                <Dir dir={r.dirNight} mode="night" />
                <span className="tnum font-mono text-[10.5px] text-ink-muted">{fmt(r.night, 2)}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] text-ink-faint">↑ warming / ↓ cooling = sign of the dependence (Spearman ρ of value vs SHAP). SHAP explains the model, not causal effects.</p>
    </ChartTable>
  );
}

export default ImportanceDiff;
