/**
 * What-if SCENARIO SIMULATOR (right column of the Non-Linear Threshold Explorer).
 *
 * The inputs edit the shared `scenario` object in DataContext
 *   { feature, delta, region: {type: "all"|"district"|"zone", ids}, coupled }
 * and DataContext re-runs `runScenario` (debounced) on the current epoch with the compact
 * in-browser tree model. This component renders the controls, the model-based result and an
 * additive, curve-only estimate for contrast (see ScenarioResults).
 *
 * Delta conventions (stored value → shown value):
 *   fractions   −0.50..+0.50 (fraction)   → "−50%..+50%" (percentage points of cell area)
 *   indices     −0.30..+0.30              → "−0.30..+0.30"
 *   landscape   ±50 % of the NCR median   → native units (e.g. m/ha)
 */
import { memo, useCallback, useEffect, useMemo } from "react";
import { FlaskConical, Map as MapIcon, RotateCcw, Sparkles } from "lucide-react";
import { useData } from "../../state/DataContext.jsx";
import { SCENARIO_PRESETS, FRACTION_FEATURES, selectRegion } from "../../lib/scenario.js";
import { zoneColor } from "../../lib/colors.js";
import { fmt, isNum } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../ui/Button.jsx";
import { InfoTip } from "../ui/InfoTip.jsx";
import { Select } from "../ui/Select.jsx";
import { Slider } from "../ui/Slider.jsx";
import { Switch } from "../ui/Switch.jsx";
import ScenarioResults from "./ScenarioResults.jsx";
import SegmentedToggle from "./SegmentedToggle.jsx";
import { additiveEstimate, buildCurve, clampDelta, deltaSpec, districtCellCounts } from "./shapMath.js";

const REGION_TYPES = [
  { value: "all", label: "All NCR" },
  { value: "district", label: "District" },
  { value: "zone", label: "Zone" },
];

/** True when two scenario objects describe the same run (used to highlight the active preset). */
function sameScenario(a, b) {
  if (!a || !b) return false;
  const ids = (s) => [...(s.region?.ids ?? [])].sort().join(",");
  return (
    a.feature === b.feature &&
    Math.abs(Number(a.delta) - Number(b.delta)) < 1e-9 &&
    (a.region?.type ?? "all") === (b.region?.type ?? "all") &&
    ids(a) === ids(b) &&
    Boolean(a.coupled) === Boolean(b.coupled)
  );
}

function PresetButtons({ presets, scenario, onApply }) {
  if (!presets.length) return <p className="text-[11px] text-ink-faint">No preset applies to this bundle.</p>;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Scenario presets">
      {presets.map((preset) => {
        const active = sameScenario(preset.scenario, scenario);
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onApply(preset.scenario)}
            aria-pressed={active}
            title={preset.description}
            className={cn(
              "focus-ring rounded-lg border px-2.5 py-1.5 text-left text-[11px] leading-tight transition-colors",
              active
                ? "border-cyan/50 bg-cyan/10 text-ink-strong shadow-glow-cyan"
                : "border-panel-border bg-slate-950/40 text-ink-muted hover:border-cyan/30 hover:text-ink",
            )}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

/** Region picker: type toggle + id select (districts limited to those with cells this epoch). */
function RegionPicker({ region, districtOptions, zoneOptions, onChange }) {
  const type = region?.type ?? "all";
  const id = region?.ids?.[0];
  const options = type === "district" ? districtOptions : type === "zone" ? zoneOptions : [];
  const selectedMissing = type !== "all" && id !== undefined && !options.some((o) => o.value === String(id));

  const setType = (next) => {
    if (next === "all") onChange({ type: "all", ids: [] });
    else {
      const list = next === "district" ? districtOptions : zoneOptions;
      onChange({ type: next, ids: list.length ? [Number(list[0].value)] : [] });
    }
  };

  return (
    <div className="space-y-2">
      <SegmentedToggle
        label="Region type"
        options={REGION_TYPES}
        value={type}
        onChange={setType}
        layoutId="scenario-region"
      />
      {type !== "all" ? (
        <Select
          size="sm"
          label={type === "district" ? "District" : "Governance zone"}
          hideLabel
          value={id === undefined ? "" : String(id)}
          onValueChange={(v) => onChange({ type, ids: [Number(v)] })}
          options={
            selectedMissing
              ? [{ value: String(id), label: `id ${id} – no cells this epoch`, disabled: true }, ...options]
              : options
          }
        />
      ) : null}
    </div>
  );
}

function ScenarioSimulator({ metaByName }) {
  const {
    epoch,
    year,
    model,
    modelRaw,
    coupling,
    dependence,
    districts,
    zonesMeta,
    scenario,
    setScenario,
    scenarioResult,
    scenarioPending,
    scenarioError,
    setMapLayer,
    setView,
    presets,
  } = useData();

  // Only manifest-actionable features are offered (NDWI / NDBI are spectral diagnostics that
  // move through the land-cover coupling, not directly; SPEC §4.1 / §4.8).
  const actionable = useMemo(() => [...metaByName.values()].filter((m) => m.actionable), [metaByName]);
  const fallbackScenario = presets[0]?.scenario ?? SCENARIO_PRESETS[0].scenario;
  const current = scenario ?? fallbackScenario;
  const meta = metaByName.get(current.feature) ?? actionable[0] ?? null;
  const spec = useMemo(() => deltaSpec(meta), [meta]);
  const isFraction = FRACTION_FEATURES.includes(current.feature);

  // Ensure the shared scenario always exists (DataContext only runs a non-null scenario).
  useEffect(() => {
    if (!scenario) setScenario(fallbackScenario);
  }, [scenario, setScenario, fallbackScenario]);

  // A scenario on a feature the manifest does not mark actionable (e.g. carried over from an
  // older bundle) is replaced by the first actionable feature with a zero change.
  useEffect(() => {
    if (!scenario || !actionable.length) return;
    if (!actionable.some((m) => m.name === scenario.feature)) {
      setScenario({ ...scenario, feature: actionable[0].name, delta: 0 });
    }
  }, [scenario, actionable, setScenario]);

  const update = useCallback(
    (patch) => setScenario((prev) => ({ ...(prev ?? fallbackScenario), ...patch })),
    [setScenario, fallbackScenario],
  );

  const onFeatureChange = (name) => {
    const nextSpec = deltaSpec(metaByName.get(name));
    // Keep the sign and relative size of the current delta when the unit system changes.
    const relative = spec.max > 0 ? Number(current.delta) / spec.max : 0;
    update({ feature: name, delta: clampDelta(nextSpec, relative * nextSpec.max) });
  };

  // District options: only districts that have cells in the current epoch.
  const counts = useMemo(() => districtCellCounts(epoch), [epoch]);
  const districtOptions = useMemo(
    () =>
      (districts ?? [])
        .filter((d) => (counts.get(d.id) ?? 0) > 0)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ value: String(d.id), label: `${d.name} · ${counts.get(d.id)} cells` })),
    [districts, counts],
  );
  const zoneOptions = useMemo(
    () => (zonesMeta ?? []).map((z) => ({ value: String(z.id), label: z.name })),
    [zonesMeta],
  );

  // Additive curve-only estimate over the same changed cells (or the region, if no model).
  // Row indices are used only from a result computed for THIS scenario on THIS epoch
  // (DataContext hides results of other epochs).
  const curve = useMemo(() => buildCurve(dependence?.features?.[current.feature]), [dependence, current.feature]);
  const additive = useMemo(() => {
    if (!epoch) return { mean: NaN, count: 0 };
    const fresh = scenarioResult && scenarioResult.scenarioKey === scenario && scenarioResult.epochYear === epoch.year;
    let indices = fresh ? scenarioResult.indices : null;
    if (!indices) {
      try {
        indices = selectRegion(epoch, current.region);
      } catch (_error) {
        indices = new Int32Array(0);
      }
    }
    return additiveEstimate({
      curve,
      values: epoch.features?.[current.feature],
      indices,
      delta: Number(current.delta),
      meta,
    });
  }, [epoch, scenario, scenarioResult, curve, current.feature, current.region, current.delta, meta]);

  const fidelity = modelRaw?.fidelity ?? null;
  const featureOptions = actionable.map((m) => ({ value: m.name, label: m.label ?? m.name }));
  const regionZone = current.region?.type === "zone" ? current.region.ids?.[0] : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-cyan" />
          Presets
        </div>
        <PresetButtons
          presets={presets}
          scenario={current}
          onApply={(s) => setScenario({ ...s, region: { ...s.region, ids: [...s.region.ids] } })}
        />
      </div>

      <div className="space-y-3 rounded-xl border border-panel-border bg-slate-950/35 p-3">
        <Select
          size="sm"
          label="Actionable feature"
          value={current.feature}
          onValueChange={onFeatureChange}
          options={featureOptions}
        />

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span id="scenario-delta-label" className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              Change (Δ)
            </span>
            <span className="font-mono text-sm font-semibold text-ink-strong">
              {spec.format(Number(current.delta))}
            </span>
          </div>
          <Slider
            value={clampDelta(spec, Number(current.delta))}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            onValueChange={(v) => update({ delta: clampDelta(spec, v) })}
            aria-labelledby="scenario-delta-label"
            thumbLabel={`Change in ${meta?.label ?? current.feature}`}
            tone={Number(current.delta) < 0 ? "violet" : "cyan"}
          />
          <div className="flex justify-between font-mono text-[10px] text-ink-faint">
            <span>{spec.format(spec.min)}</span>
            <button
              type="button"
              onClick={() => update({ delta: 0 })}
              className="focus-ring inline-flex items-center gap-1 rounded px-1 text-ink-muted hover:text-ink"
              aria-label="Reset change to zero"
            >
              <RotateCcw aria-hidden="true" className="h-3 w-3" /> 0
            </button>
            <span>{spec.format(spec.max)}</span>
          </div>
          <p className="text-[11px] text-ink-muted">{spec.describe(Number(current.delta))}</p>
        </div>

        <RegionPicker
          region={current.region}
          districtOptions={districtOptions}
          zoneOptions={zoneOptions}
          onChange={(region) => update({ region })}
        />
        {regionZone !== null && regionZone !== undefined ? (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: zoneColor(regionZone, zonesMeta) }}
            />
            Zone membership is taken from the {year} epoch.
          </div>
        ) : null}

        <div className="flex items-start justify-between gap-2">
          <Switch
            checked={Boolean(current.coupled)}
            onCheckedChange={(checked) => update({ coupled: checked })}
            disabled={!isFraction}
            label="Coupled spectral response"
            description={
              isFraction
                ? coupling
                  ? "NDVI / NDWI / NDBI follow the land-cover change via OLS partial slopes."
                  : "Coupling table not exported – toggling has no effect."
                : "Applies to land-cover fractions only."
            }
          />
          <InfoTip
            label="How coupling works"
            side="left"
            content={
              <span>
                Land-cover fractions are compositional: adding Δ to one fraction removes Δ from the other land covers,
                including the implicit other-vegetation share (grass, shrub, wetland), in proportion to their current
                share, so every cell still sums to 100%; a cell can only give up the land it has. With coupling on,
                NDVI / NDWI / NDBI also shift by Σ slope × Δfraction (partial slopes from an OLS of each index on the
                five fractions, <span className="font-mono">scenario_coupling.json</span>), clamped to [−1, 1]. Off
                isolates the land-cover effect alone. NDWI and NDBI are spectral diagnostics: they are not offered as
                levers and move only through this coupling. Landscape metrics stay fixed.
              </span>
            }
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
            <FlaskConical aria-hidden="true" className="h-3.5 w-3.5 text-cyan" />
            Result · {year ?? "—"} epoch
          </div>
          {scenarioPending ? <span className="font-mono text-[10px] text-cyan-soft">computing…</span> : null}
        </div>
        {scenarioError ? (
          <p role="alert" className="rounded-lg border border-rose/40 bg-rose/10 p-2.5 text-xs text-ink">
            Scenario failed: {scenarioError.message}
          </p>
        ) : null}
        <ScenarioResults
          result={scenarioResult}
          additive={additive}
          featureLabel={meta?.label ?? current.feature}
          formatChange={spec.format}
          regionKind={current.region?.type ?? "all"}
          year={year}
          hasModel={Boolean(model)}
          stale={scenarioPending}
        />
      </div>

      {fidelity ? (
        <p className="rounded-lg border border-panel-border bg-slate-950/30 p-2.5 text-[11px] leading-snug text-ink-muted">
          <span className="font-medium text-ink">Surrogate model.</span> Scenarios run on a compact XGBoost surrogate
          (depth ≤ {fidelity.max_depth ?? "?"}, {fidelity.rounds ?? "?"} rounds) that reproduces the final model with R²{" "}
          {isNum(fidelity.r2_vs_final) ? fmt(fidelity.r2_vs_final, 3) : "—"} (RMSE{" "}
          {isNum(fidelity.rmse_vs_final) ? fmt(fidelity.rmse_vs_final, 2) : "—"} °C) and observations with R²{" "}
          {isNum(fidelity.r2_vs_obs) ? fmt(fidelity.r2_vs_obs, 3) : "—"}. Baseline and scenario use the same surrogate,
          so its error largely cancels in Δ.
        </p>
      ) : null}

      <Button
        variant="primary"
        className="w-full"
        disabled={!scenarioResult?.stats?.count}
        onClick={() => {
          setMapLayer("scenario");
          setView("twin");
        }}
      >
        <MapIcon aria-hidden="true" />
        Show on map
      </Button>
    </div>
  );
}

export default memo(ScenarioSimulator);
