/**
 * Scenario picker (UI_SPEC_v2 §3.3 "SSP▾", §8 `ScenarioPicker`): a native <select> (best
 * keyboard / screen-reader support) listing ONLY the manifest scenarios, each labelled with
 * its line style ("solid", "long-dash") because the SSP colours alone are not CVD-safe.
 * Soft-disabled while the playhead is at or before NOW: the choice still works but is muted
 * with the note "applies 2030–2050". With no scenarios in the bundle it is disabled with the
 * reason ("No projections in this bundle — rerun notebook v2").
 */
import { useId } from "react";
import { SspStrand } from "../design/glyphs.jsx";
import { ssp as SSP_STYLE } from "../design/tokens.js";
import { cn } from "../lib/cn.js";
import { fmtSsp } from "../lib/format.js";
import { useTimeStore } from "../state/stores/timeStore.js";
import { announce } from "../shell/announcer.js";

const DASH_WORDS = { ssp126: "long dash", ssp245: "solid", ssp370: "dash-dot", ssp585: "bold" };

/**
 * @param {{ssp?: string|null, options: Array<{id:string, label?:string, n_gcm?:number}>, year?: number|null,
 *          now?: number|null, projYears?: number[], onChange?: (id:string)=>void, compact?: boolean,
 *          className?: string}} props
 */
export function ScenarioPicker({ ssp, options = [], year, now, projYears = [], onChange, compact = false, className }) {
  const id = useId();
  const storeSsp = useTimeStore((s) => s.ssp ?? null);
  const storeYear = useTimeStore((s) => s.year);
  const value = ssp === undefined ? storeSsp : ssp;
  const y = year === undefined ? storeYear : year;
  const none = options.length === 0;
  const historical = Number.isFinite(y) && Number.isFinite(now) && y <= now;
  const span = projYears.length ? `${projYears[0]}–${projYears[projYears.length - 1]}` : "projected years";
  const style = SSP_STYLE[value] ?? null;
  const change = (next) => {
    if (onChange) onChange(next);
    else if (useTimeStore.getState().setSsp?.(next) !== false) announce(`Scenario ${fmtSsp(next)}`);
  };
  const hint = none ? "No projections in this bundle — rerun notebook v2" : historical ? `applies ${span}` : null;
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {style && !none && <SspStrand color={style.color} dash={style.dash} weight={style.width} width={18} height={8} />}
      <label htmlFor={id} className="sr-only">
        Climate scenario{hint ? ` (${hint})` : ""}
      </label>
      <select
        id={id}
        value={none ? "" : value ?? options[0]?.id ?? ""}
        disabled={none}
        title={hint ?? "Climate scenario"}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => change(e.target.value)}
        className={cn(
          "focus-ring h-8 min-w-0 cursor-pointer appearance-none rounded-md border border-control bg-surface-3 pl-2 pr-6 font-mono text-[12px] text-ink",
          "disabled:cursor-not-allowed disabled:opacity-50",
          historical && !none && "text-ink-muted",
        )}
        style={{
          backgroundImage: "linear-gradient(45deg, transparent 50%, var(--ink-muted) 50%), linear-gradient(135deg, var(--ink-muted) 50%, transparent 50%)",
          backgroundPosition: "calc(100% - 12px) 14px, calc(100% - 8px) 14px",
          backgroundSize: "4px 4px",
          backgroundRepeat: "no-repeat",
        }}
      >
        {none && <option value="">No SSP</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {`${o.label ?? fmtSsp(o.id)}${compact ? "" : ` · ${DASH_WORDS[o.id] ?? "line"}`}`}
          </option>
        ))}
      </select>
      {hint && !compact && (
        <span id={`${id}-hint`} className="hidden truncate font-mono text-[11px] text-ink-faint xl:inline">
          {hint}
        </span>
      )}
      {hint && compact && (
        <span id={`${id}-hint`} className="sr-only">
          {hint}
        </span>
      )}
    </div>
  );
}

export default ScenarioPicker;
