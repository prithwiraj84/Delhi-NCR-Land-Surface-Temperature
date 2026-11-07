/**
 * Timeline filter row (UI_SPEC §3.5 header): scope [NCR | District | Zone] + entity, metric
 * [Mean | P90 | Hot-core km² | UHI | DTR], SSP checkboxes (only those in the manifest), and the
 * annual-context toggle. One filter row scopes every chart below it (dataviz interaction
 * rule). Unavailable options stay visible with their reason.
 */
import { Segmented } from "../../components/ui/Segmented.jsx";
import { Select } from "../../components/ui/Select.jsx";
import { cn } from "../../lib/cn.js";
import { METRIC_META, sspStyle } from "../../viz/chartTheme.js";

const KINDS = [
  { value: "ncr", label: "NCR" },
  { value: "district", label: "District" },
  { value: "zone", label: "Zone" },
];

/**
 * @param {{scope: string, onScope: (id: string) => void, districts: {id: string, label: string}[],
 *          zones: {id: string, label: string}[], metric: string, onMetric: (m: string) => void,
 *          dtrAvailable: boolean, dtrReason?: string|null, scenarios: {id: string, label: string}[],
 *          ssps: string[], onSsps: (ids: string[]) => void, showAnnual: boolean,
 *          onShowAnnual: (on: boolean) => void}} props
 */
export function ScopePicker({ scope, onScope, districts, zones, metric, onMetric, dtrAvailable, dtrReason, scenarios, ssps, onSsps, showAnnual, onShowAnnual, className }) {
  const kind = scope === "ncr" ? "ncr" : scope.startsWith("d:") ? "district" : "zone";
  const kindOptions = KINDS.map((k) => ({
    ...k,
    disabled: (k.value === "district" && !districts.length) || (k.value === "zone" && !zones.length),
    reason: k.value === "zone" && !zones.length ? "No zone series in this bundle" : k.value === "district" && !districts.length ? "No district series" : undefined,
  }));
  const setKind = (k) => {
    if (k === "ncr") onScope("ncr");
    else if (k === "district" && districts[0]) onScope(districts[0].id);
    else if (k === "zone" && zones[0]) onScope(zones[0].id);
  };
  const entities = kind === "district" ? districts : kind === "zone" ? zones : [];
  const metricOptions = Object.values(METRIC_META).map((m) => ({
    value: m.key,
    label: m.label,
    title: m.description,
    disabled: m.key === "dtr" && !dtrAvailable,
    reason: m.key === "dtr" && !dtrAvailable ? dtrReason ?? "DTR needs day and night frames" : undefined,
  }));
  const toggleSsp = (id) => onSsps(ssps.includes(id) ? ssps.filter((s) => s !== id) : [...ssps, id]);

  return (
    <div role="group" aria-label="Timeline filters" className={cn("flex flex-wrap items-end gap-x-4 gap-y-2", className)}>
      <div className="flex flex-col gap-1">
        <span className="micro-label">Scope</span>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented ariaLabel="Scope kind" value={kind} onChange={setKind} options={kindOptions} size="sm" layoutId="timeline-scope-kind" />
          {entities.length > 0 && (
            <Select size="sm" label={kind === "district" ? "District" : "Zone"} hideLabel value={scope} onValueChange={onScope} options={entities.map((e) => ({ value: e.id, label: e.label }))} />
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="micro-label">Metric</span>
        <Segmented ariaLabel="Metric" value={metric} onChange={onMetric} options={metricOptions} size="sm" layoutId="timeline-metric" />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="micro-label mb-1">Scenarios</legend>
        {scenarios.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {scenarios.map((s) => {
              const st = sspStyle(s.id);
              const on = ssps.includes(s.id);
              return (
                <label key={s.id} className={cn("focus-within:ring-signal inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs focus-within:ring-2", on ? "border-control bg-surface-3 text-ink" : "border-hairline text-ink-muted")}>
                  <input type="checkbox" className="size-3.5 accent-[var(--signal)]" checked={on} onChange={() => toggleSsp(s.id)} />
                  <svg width="16" height="8" aria-hidden="true">
                    <line x1="0" x2="16" y1="4" y2="4" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash ?? undefined} />
                  </svg>
                  {s.label ?? st.label}
                </label>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-ink-faint">No projections in this bundle — rerun notebook v2</span>
        )}
      </fieldset>
      <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
        <input type="checkbox" className="size-3.5 accent-[var(--signal)]" checked={showAnnual} onChange={(e) => onShowAnnual(e.target.checked)} />
        Annual satellite context
      </label>
    </div>
  );
}

export default ScopePicker;
