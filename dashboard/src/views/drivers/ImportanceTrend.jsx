/**
 * IMPORTANCE THROUGH TIME (UI_SPEC §3.6 "bars + CI + trend sparks"): mean |SHAP| of the top
 * drivers at every XAI frame of the current mode — small multiples on ONE shared °C scale
 * (a driver that matters more in 2025 than 1990 visibly grows). The frame the map shows is
 * marked; the table view lists every value.
 */
import { useMemo } from "react";
import { fmt } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { MODE_STYLE } from "../../viz/chartTheme.js";
import { Sparkline } from "../../viz/Sparkline.jsx";
import { importanceTrend } from "./driversModel.js";

/**
 * @param {{slice: object|null, mode: string, year: number|null, labelOf: (id) => string,
 *          selected?: string|null, onSelect?: (id) => void}} props
 */
export function ImportanceTrend({ slice, mode, year, labelOf, selected, onSelect }) {
  const data = useMemo(() => importanceTrend(slice, 8), [slice]);
  const yMax = Math.max(1e-6, ...data.lines.flatMap((l) => l.points.map((p) => (Number.isFinite(p.y) ? p.y : 0))));
  const xDomain = [data.years[0] ?? 1990, data.years[data.years.length - 1] ?? 2025];
  const color = MODE_STYLE[mode]?.accent;
  const status = data.years.length >= 2 ? { status: "ready" } : { status: "unavailable", reason: data.years.length ? "Importance is exported for a single frame only." : "No per-frame importance in this bundle." };
  return (
    <ChartTable
      title={`Importance through time · ${mode}`}
      status={status}
      columns={[{ key: "label", label: "Driver" }, ...data.years.map((y) => ({ key: String(y), label: String(y), align: "right", format: (v) => fmt(v, 3) }))]}
      rows={data.lines.map((l) => ({ id: l.id, label: labelOf(l.id), ...Object.fromEntries(l.points.map((p) => [String(p.x), p.y])) }))}
      caption={`Mean absolute SHAP (°C) of the eight most important ${mode} drivers at each frame with explanations; shared scale 0–${fmt(yMax, 2)} °C.`}
    >
      <p className="mb-1.5 text-[11px] text-ink-faint">
        Shared scale 0–{fmt(yMax, 2)} °C · {xDomain[0]}–{xDomain[1]}
      </p>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
        {data.lines.map((l) => {
          const last = l.points.filter((p) => Number.isFinite(p.y)).at(-1);
          return (
            <li key={l.id}>
              <button type="button" onClick={() => onSelect?.(l.id)} aria-pressed={l.id === selected} className={cn("focus-ring w-full rounded px-1 py-0.5 text-left", l.id === selected ? "bg-signal/10" : "hover:bg-surface-3/60")}>
                <span className="block truncate text-[11px] text-ink">{labelOf(l.id)}</span>
                <Sparkline points={l.points} width={110} height={26} color={color} xDomain={xDomain} yDomain={[0, yMax]} highlightX={year} />
                <span className="tnum font-mono text-[10.5px] text-ink-muted">
                  {last ? `${last.x}: ${fmt(last.y, 3)} °C` : "—"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </ChartTable>
  );
}

export default ImportanceTrend;
