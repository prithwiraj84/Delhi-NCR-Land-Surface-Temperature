/**
 * Centre panel of the explorer: feature / colour pickers, the dependence plot, its legend,
 * and a table view of the binned curve (the chart's accessible twin).
 *
 * Scatter source
 * - When the colour feature is the exported interaction partner (`scatter.color_feature`,
 *   the strongest SHAP-interaction partner), the pooled all-epoch sample from
 *   dependence.json is drawn.
 * - When the reader picks any other colour feature (select or interaction-matrix click),
 *   partner values for the exported sample do not exist, so a deterministic ≤1,500-cell
 *   sample is drawn live from the current epoch instead (and labelled as such).
 */
import { memo, useCallback, useMemo } from "react";
import { scaleSequential } from "d3-scale";
import { interpolateLab, piecewise } from "d3-interpolate";
import { EmptyState } from "../common/EmptyState.jsx";
import { zoneColor } from "../../lib/colors.js";
import { fmt, fmtFeatureValue, fmtInt, isNum } from "../../lib/format.js";
import { Select } from "../ui/Select.jsx";
import DependenceChart from "./DependenceChart.jsx";
import SegmentedToggle from "./SegmentedToggle.jsx";
import { FEATURE_GROUPS, SEMANTIC, buildEpochScatter, buildExportScatter, robustExtent } from "./shapMath.js";

/** Single-hue violet ramp for the partner feature; the low end stays visible on the dark panel. */
const PARTNER_STOPS = ["#5b3fd1", "#a78bfa", "#f3e8ff"];
const PARTNER_RAMP = piecewise(interpolateLab, PARTNER_STOPS);
const PARTNER_CSS = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((t) => PARTNER_RAMP(t)).join(", ")})`;
const MISSING_COLOR = "rgba(100, 116, 139, 0.55)";

/** Feature <select> options grouped by manifest group (optgroups). */
function groupedOptions(metaList, exclude) {
  const known = new Set(FEATURE_GROUPS.map((g) => g.id));
  const toOption = (m) => ({ value: m.name, label: m.label ?? m.name });
  const groups = FEATURE_GROUPS.map((g) => ({
    label: g.label,
    options: metaList.filter((m) => m.group === g.id && m.name !== exclude).map(toOption),
  }));
  groups.push({
    label: "Other",
    options: metaList.filter((m) => !known.has(m.group) && m.name !== exclude).map(toOption),
  });
  return groups.filter((g) => g.options.length);
}

function MarkLegend({ ciLabel }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted" aria-label="Chart marks">
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ backgroundColor: SEMANTIC.curve }} />
        binned mean
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2.5 w-4 rounded-sm bg-white/15" />
        bootstrap {ciLabel} band
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-violet" />
        cell SHAP
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-3 w-px" style={{ backgroundColor: SEMANTIC.zero }} />
        <span aria-hidden="true" className="h-3 w-px" style={{ backgroundColor: SEMANTIC.breakpoint }} />
        <span aria-hidden="true" className="h-3 w-px" style={{ backgroundColor: SEMANTIC.saturation }} />
        thresholds (shaded: {ciLabel})
      </li>
    </ul>
  );
}

function ColorLegend({ colorMode, colorMeta, extent, zonesMeta }) {
  if (colorMode === "zone") {
    return (
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted" aria-label="Zone colours">
        {(zonesMeta ?? []).map((z) => (
          <li key={z.id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: zoneColor(z.id, zonesMeta) }}
            />
            {z.name}
          </li>
        ))}
      </ul>
    );
  }
  if (!extent) return <p className="text-[11px] text-ink-faint">No partner values available for this sample.</p>;
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-muted">
      <span className="truncate">{colorMeta?.label ?? "Partner"}</span>
      <span className="font-mono text-ink-faint">{fmtFeatureValue(colorMeta, extent[0])}</span>
      <span aria-hidden="true" className="h-2 w-28 rounded-full" style={{ background: PARTNER_CSS }} />
      <span className="font-mono text-ink-faint">{fmtFeatureValue(colorMeta, extent[1])}</span>
      <span className="text-ink-faint">(p2–p98)</span>
    </div>
  );
}

/** Table view of the binned curve (collapsed by default). */
function CurveTable({ curve, meta, ciLabel }) {
  return (
    <details className="group rounded-lg border border-panel-border bg-slate-950/30 text-xs">
      <summary className="focus-ring cursor-pointer select-none rounded-lg px-3 py-2 text-ink-muted hover:text-ink">
        Table view · {curve.length} quantile bins
      </summary>
      <div className="max-h-64 overflow-auto px-3 pb-3">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
          <caption className="sr-only">Binned mean SHAP of {meta?.label} with bootstrap {ciLabel}</caption>
          <thead className="sticky top-0 bg-slate-950/95 text-ink-muted">
            <tr>
              <th scope="col" className="py-1 text-left font-medium">
                {meta?.label ?? "x"}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                mean °C
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {ciLabel === "95% CI" ? "95% band" : "range"}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                n
              </th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {curve.map((r) => (
              <tr key={r.x} className="border-t border-panel-border/60">
                <td className="py-0.5">{fmtFeatureValue(meta, r.x)}</td>
                <td className="py-0.5 text-right">{fmt(r.mean, 2)}</td>
                <td className="py-0.5 text-right text-ink-muted">
                  {r.band ? `${fmt(r.lo, 2)} – ${fmt(r.hi, 2)}` : "—"}
                </td>
                <td className="py-0.5 text-right text-ink-muted">{isNum(r.count) ? fmtInt(r.count) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * @param {object} props
 * @param {string} props.feature
 * @param {object|null} props.dep          dependence.json entry for `feature`
 * @param {Array} props.curve              buildCurve(dep)
 * @param {Map<string, object>} props.metaByName
 * @param {object|null} props.epoch
 * @param {number|null} props.year
 * @param {Array} props.zonesMeta
 * @param {string|null} props.colorFeature  effective colour (partner) feature
 * @param {"partner"|"zone"} props.colorMode
 * @param {(name: string) => void} props.onFeatureChange
 * @param {(name: string) => void} props.onColorFeatureChange
 * @param {(mode: string) => void} props.onColorModeChange
 * @param {string} [props.ciLabel]         "95% CI" or "replicate range"
 */
function DependencePanel({
  feature,
  dep,
  curve,
  metaByName,
  epoch,
  year,
  zonesMeta,
  colorFeature,
  colorMode,
  onFeatureChange,
  onColorFeatureChange,
  onColorModeChange,
  ciLabel = "95% CI",
}) {
  const meta = metaByName.get(feature) ?? null;
  const colorMeta = colorFeature ? (metaByName.get(colorFeature) ?? null) : null;
  const exportPartner = dep?.scatter?.color_feature ?? null;
  const useExport = Boolean(dep?.scatter?.x?.length) && (colorMode === "zone" || colorFeature === exportPartner);

  const points = useMemo(
    () => (useExport ? buildExportScatter(dep.scatter) : buildEpochScatter(epoch, feature, colorFeature)),
    [useExport, dep, epoch, feature, colorFeature],
  );

  const extent = useMemo(() => robustExtent(points.map((p) => (p.c === null ? NaN : p.c))), [points]);
  const partnerScale = useMemo(
    () => (extent ? scaleSequential(PARTNER_RAMP).domain(extent).clamp(true) : null),
    [extent],
  );

  const colorOf = useCallback(
    (row) => {
      if (colorMode === "zone") return isNum(row?.zone) ? zoneColor(row.zone, zonesMeta) : MISSING_COLOR;
      return partnerScale && isNum(row?.c) ? partnerScale(row.c) : MISSING_COLOR;
    },
    [colorMode, zonesMeta, partnerScale],
  );

  const zoneName = useCallback(
    (id) => (isNum(id) ? (zonesMeta?.find?.((z) => z.id === id)?.name ?? `Zone ${id}`) : "—"),
    [zonesMeta],
  );

  const metaList = useMemo(() => [...metaByName.values()], [metaByName]);
  const featureOptions = useMemo(() => groupedOptions(metaList, null), [metaList]);
  const colorOptions = useMemo(() => groupedOptions(metaList, feature), [metaList, feature]);

  const sampleNote = useExport
    ? `${fmtInt(points.length)} cells · pooled sample across epochs`
    : `${fmtInt(points.length)} cells · live sample from the ${year ?? "current"} epoch`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          size="sm"
          label="Feature"
          value={feature ?? ""}
          onValueChange={onFeatureChange}
          options={featureOptions}
          className="w-52"
        />
        <Select
          size="sm"
          label="Colour by"
          value={colorFeature ?? ""}
          onValueChange={onColorFeatureChange}
          options={colorOptions}
          disabled={colorMode === "zone"}
          className="w-52"
        />
        <SegmentedToggle
          label="Scatter colour mode"
          options={[
            { value: "partner", label: "Partner value" },
            { value: "zone", label: "Zone" },
          ]}
          value={colorMode}
          onChange={onColorModeChange}
          layoutId="dependence-colour-mode"
          className="mb-px"
        />
      </div>

      {!dep && !points.length ? (
        <EmptyState
          compact
          title="No dependence data for this feature"
          description="dependence.json is missing or does not contain this feature, and no epoch sample is loaded."
        />
      ) : (
        <>
          <div className="relative rounded-xl border border-panel-border bg-slate-950/40 p-2">
            {/* faint measurement grid behind the plot, for the instrument-panel look */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-xl opacity-60"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(34,211,238,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.04) 1px, transparent 1px)",
                backgroundSize: "24px 24px",
              }}
            />
            <div
              className="relative"
              role="img"
              aria-label={`SHAP dependence of ${meta?.label ?? feature}: ${sampleNote}`}
            >
              <DependenceChart
                meta={meta}
                curve={curve}
                points={points}
                colorOf={colorOf}
                colorMode={colorMode}
                colorMeta={colorMeta}
                zoneName={zoneName}
                threshold={dep?.threshold ?? null}
                ciLabel={ciLabel}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MarkLegend ciLabel={ciLabel} />
            <span className="font-mono text-[10px] text-ink-faint">{sampleNote}</span>
          </div>
          <ColorLegend colorMode={colorMode} colorMeta={colorMeta} extent={extent} zonesMeta={zonesMeta} />
          {!dep ? (
            <p className="text-[11px] text-amber-soft">
              No binned curve exported for this feature – showing the raw sample only.
            </p>
          ) : null}
          {curve.length ? <CurveTable curve={curve} meta={meta} ciLabel={ciLabel} /> : null}
        </>
      )}
    </div>
  );
}

export default memo(DependencePanel);
