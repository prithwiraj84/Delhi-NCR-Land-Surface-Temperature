/**
 * Global SHAP importance: mean |SHAP| (°C) per feature as horizontal bars.
 *
 * - "Global" shows the pooled importance with its block-bootstrap interval as a whisker
 *   (labelled "95% CI", or "replicate range" when the bundle has fewer than 50 replicates).
 * - "By epoch" / "By zone" show the importance within one epoch / governance zone (no CI is
 *   exported for these slices) plus the sign of the mean SHAP, i.e. whether the feature on
 *   average warms (↑) or cools (↓) that slice.
 * Every row is a button: clicking (or Enter/Space) selects the feature for the dependence
 * plot. Built as HTML rather than an SVG chart so rows are real, focusable controls and the
 * values are readable text (the list doubles as the chart's table view).
 */
import { memo, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { THEME, zoneColor } from "../../lib/colors.js";
import { fmt, isNum } from "../../lib/format.js";
import SegmentedToggle from "./SegmentedToggle.jsx";
import { intervalContains } from "../../lib/uncertainty.js";
import { FEATURE_GROUPS } from "./shapMath.js";

const GROUP_COLOR = Object.fromEntries(FEATURE_GROUPS.map((g) => [g.id, g.color]));

/** Rows { name, meanAbs, lo, hi, mean } for the active slice, or [] when unavailable. */
function sliceRows(shapGlobal, scope, sliceKey) {
  const names = shapGlobal?.features ?? [];
  const slice =
    scope === "global"
      ? shapGlobal?.global
      : scope === "epoch"
        ? shapGlobal?.by_epoch?.[sliceKey]
        : shapGlobal?.by_zone?.[sliceKey];
  if (!slice?.mean_abs) return [];
  return names
    .map((name, i) => ({
      name,
      meanAbs: slice.mean_abs[i],
      lo: scope === "global" ? slice.ci_lo?.[i] : null,
      hi: scope === "global" ? slice.ci_hi?.[i] : null,
      mean: scope === "global" ? null : slice.mean?.[i],
    }))
    .filter((r) => isNum(r.meanAbs));
}

function ImportanceRow({ row, rank, max, color, selected, meta, onSelect, ciLabel }) {
  const pct = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const hasCi = isNum(row.lo) && isNum(row.hi);
  const label = meta?.label ?? row.name;
  const SignIcon = isNum(row.mean) ? (row.mean >= 0 ? ArrowUpRight : ArrowDownRight) : null;
  const outside = hasCi && intervalContains(row.meanAbs, [row.lo, row.hi]) === false;
  const ciText = hasCi
    ? `, ${ciLabel} ${fmt(row.lo, 3)} to ${fmt(row.hi, 3)}${outside ? " (estimate outside the interval)" : ""}`
    : "";
  const signText = isNum(row.mean) ? `, mean SHAP ${fmt(row.mean, 3)} °C` : "";
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(row.name)}
        aria-pressed={selected}
        aria-label={`${label}: mean absolute SHAP ${fmt(row.meanAbs, 3)} °C${ciText}${signText}`}
        className={cn(
          "group grid w-full grid-cols-[1.25rem_minmax(0,7.5rem)_minmax(0,1fr)_3.25rem] items-center gap-2 rounded-md px-1.5 py-1",
          "text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan/70",
          selected ? "bg-cyan/10 shadow-glow-cyan" : "hover:bg-slate-800/60",
        )}
      >
        <span className="font-mono text-[10px] text-ink-faint">{rank}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: GROUP_COLOR[meta?.group] ?? THEME.inkFaint }}
          />
          <span className={cn("truncate text-xs", selected ? "font-semibold text-ink-strong" : "text-ink")}>
            {label}
          </span>
        </span>
        {/* bar track: bar grows from the baseline, CI whisker overlaid */}
        <span className="relative h-3.5">
          <motion.span
            className="absolute inset-y-0.5 left-0 rounded-r-[4px]"
            style={{ backgroundColor: color, opacity: selected ? 1 : 0.78 }}
            initial={false}
            animate={{ width: pct(row.meanAbs) }}
            transition={{ type: "spring", stiffness: 180, damping: 26 }}
          />
          {hasCi ? (
            <span
              aria-hidden="true"
              className="absolute top-1/2 h-2 -translate-y-1/2 border-x border-ink-strong/80"
              style={{ left: pct(row.lo), width: `calc(${pct(row.hi)} - ${pct(row.lo)})` }}
            >
              <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-ink-strong/80" />
            </span>
          ) : null}
        </span>
        <span className="flex items-center justify-end gap-0.5 font-mono text-[11px] tabular-nums text-ink">
          {SignIcon ? <SignIcon aria-hidden="true" className="h-3 w-3 text-ink-muted" /> : null}
          {fmt(row.meanAbs, 2)}
        </span>
      </button>
    </li>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.shapGlobal   shap_global.json (§4.5)
 * @param {Map<string, object>} props.metaByName
 * @param {Array} props.zonesMeta
 * @param {number|null} props.year          current epoch (default slice for "By epoch")
 * @param {Set<string>} props.groups        visible feature groups
 * @param {string} props.selectedFeature
 * @param {(name: string) => void} props.onSelect
 */
function ImportanceChart({ shapGlobal, metaByName, zonesMeta, year, groups, selectedFeature, onSelect, ciLabel = "95% CI" }) {
  const [scope, setScope] = useState("global");
  const epochKeys = useMemo(() => Object.keys(shapGlobal?.by_epoch ?? {}).sort(), [shapGlobal]);
  const zoneKeys = useMemo(() => Object.keys(shapGlobal?.by_zone ?? {}).sort((a, b) => a - b), [shapGlobal]);
  const [epochKey, setEpochKey] = useState(null);
  const [zoneKey, setZoneKey] = useState(null);

  // Default slices: the dashboard's current epoch, and the Heat Extreme Core (or first zone).
  const activeEpoch = epochKey ?? (epochKeys.includes(String(year)) ? String(year) : epochKeys.at(-1));
  const activeZone = zoneKey ?? (zoneKeys.includes("3") ? "3" : zoneKeys[0]);
  const sliceKey = scope === "epoch" ? activeEpoch : scope === "zone" ? activeZone : null;

  const rows = useMemo(() => {
    const all = sliceRows(shapGlobal, scope, sliceKey);
    return all
      .filter((r) => groups.has(metaByName.get(r.name)?.group ?? "other") || !metaByName.get(r.name)?.group)
      .sort((a, b) => b.meanAbs - a.meanAbs);
  }, [shapGlobal, scope, sliceKey, groups, metaByName]);

  const max = useMemo(() => Math.max(1e-6, ...rows.map((r) => Math.max(r.meanAbs, isNum(r.hi) ? r.hi : 0))), [rows]);
  const outsideCount = useMemo(
    () => rows.filter((r) => intervalContains(r.meanAbs, [r.lo, r.hi]) === false).length,
    [rows],
  );

  if (!shapGlobal?.features?.length) {
    return <p className="text-xs text-ink-muted">shap_global.json is not available in this bundle.</p>;
  }

  const barColor = scope === "zone" ? zoneColor(Number(activeZone), zonesMeta) : THEME.cyan;
  const scopeOptions = [
    { value: "global", label: "Global" },
    { value: "epoch", label: "By epoch", title: "Importance within one epoch" },
    { value: "zone", label: "By zone", title: "Importance within one governance zone" },
  ].filter((o) => o.value === "global" || (o.value === "epoch" ? epochKeys.length : zoneKeys.length));

  return (
    <div className="space-y-3">
      <SegmentedToggle
        label="Importance scope"
        options={scopeOptions}
        value={scope}
        onChange={setScope}
        layoutId="importance-scope"
      />
      {scope === "epoch" ? (
        <SegmentedToggle
          label="Epoch"
          options={epochKeys.map((k) => ({ value: k, label: k }))}
          value={activeEpoch}
          onChange={setEpochKey}
          layoutId="importance-epoch"
        />
      ) : null}
      {scope === "zone" ? (
        <SegmentedToggle
          label="Zone"
          options={zoneKeys.map((k) => {
            const z = zonesMeta?.find?.((m) => String(m.id) === k);
            return {
              value: k,
              label: z?.name?.split(" ")[0] ?? `Zone ${k}`,
              title: z?.name,
              dot: zoneColor(Number(k), zonesMeta),
            };
          })}
          value={activeZone}
          onChange={setZoneKey}
          layoutId="importance-zone"
        />
      ) : null}

      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        <span>Feature</span>
        <span>mean |SHAP| °C</span>
      </div>
      {rows.length ? (
        <ol className="space-y-0.5" aria-label="Features ranked by mean absolute SHAP">
          {rows.map((row, i) => (
            <ImportanceRow
              key={row.name}
              row={row}
              rank={i + 1}
              max={max}
              color={barColor}
              selected={row.name === selectedFeature}
              meta={metaByName.get(row.name)}
              onSelect={onSelect}
              ciLabel={ciLabel}
            />
          ))}
        </ol>
      ) : (
        <p className="text-xs text-ink-muted">No features match the selected groups.</p>
      )}
      <p className="text-[10px] leading-relaxed text-ink-faint">
        {scope === "global"
          ? `Whiskers: ${ciLabel} from ${shapGlobal.n_bootstrap ?? "?"} ${shapGlobal.bootstrap_mode ?? ""} bootstrap resamples.${
              outsideCount ? ` ${outsideCount} estimate${outsideCount === 1 ? " lies" : "s lie"} outside the interval (resampling bias).` : ""
            }`
          : "↑ / ↓ = mean SHAP warms / cools this slice on average. CIs are exported for the global ranking only."}
      </p>
    </div>
  );
}

export default memo(ImportanceChart);
