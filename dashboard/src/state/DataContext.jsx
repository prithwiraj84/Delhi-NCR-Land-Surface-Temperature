/**
 * Global data + UI state for the dashboard (SPEC §5.1).
 *
 * Loading strategy
 *   1. manifest.json (404 / HTML fallback -> status "empty" with instructions).
 *   2. In parallel: the latest epoch (required) and every small asset (optional: a failure
 *      is logged as a warning and the asset stays null so views render fallbacks).
 *   3. The compact model is compiled once; the bundle is validated once, off the critical
 *      path, and the result feeds the header's validation indicator.
 *   4. Other epochs are fetched lazily on `setYear`; their neighbours are prefetched in the
 *      background so stepping through time is instant.
 *
 * Epoch switching is "stale-while-loading": `year` and `epoch` always describe the SAME
 * epoch; while a new one streams in, `pendingYear` holds the requested year and
 * `epochLoading` is true, so the map never flashes empty.
 *
 * Scenarios run only while someone looks at them (the Threshold Explorer is open or the map
 * shows the "scenario" layer). Recomputation is debounced (~120 ms) and executed by the
 * ScenarioEngine in a Web Worker (main-thread fallback), so sliders and the map stay
 * responsive; superseded replies are dropped. Every result carries the epoch it was computed
 * for and is exposed only while that epoch is current; a failed run clears the result.
 *
 * Validation runs on the first epoch plus every small asset once, then on each epoch loaded
 * later (when the browser is idle); `validation.epochsChecked` lists what has been checked.
 */
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clearDataCache, loadAsset, loadEpoch, loadManifest } from "../lib/data.js";
import { compileModel } from "../lib/model.js";
import { presetsFor, SCENARIO_PRESETS } from "../lib/scenario.js";
import { ScenarioEngine } from "../lib/scenarioEngine.js";
import { bootstrapInfo } from "../lib/uncertainty.js";
import { validateBundle, validateEpochs } from "../lib/validate.js";
import { currentScenarioResult, mergeValidation, scenarioIsActive, uncheckedYears } from "./contextLogic.js";

const DataContext = createContext(null);

const SCENARIO_DEBOUNCE_MS = 120;
export const VIEWS = Object.freeze(["twin", "thresholds", "zones", "performance"]);
export const MAP_LAYERS = Object.freeze(["lst_obs", "lst_pred", "resid_oof", "shap", "driver", "zones", "scenario"]);

/** manifest.files key -> state key for every optional small asset. */
const OPTIONAL_ASSETS = Object.freeze({
  shap_global: "shapGlobal",
  dependence: "dependence",
  zones: "zones",
  metrics: "metrics",
  districts: "districtsGeo",
  interactions: "interactions",
  coupling: "coupling",
  model: "modelRaw",
});

const EMPTY_ASSETS = Object.freeze(
  Object.fromEntries(Object.values(OPTIONAL_ASSETS).map((key) => [key, null])),
);

const INITIAL_LOAD = Object.freeze({
  status: "loading",
  error: null,
  manifest: null,
  assets: EMPTY_ASSETS,
  model: null,
  loadWarnings: [],
});

/** Most important feature: argmax of shap_global mean |SHAP|, else of the epoch's SHAP spread. */
function defaultShapFeature(manifest, shapGlobal, epoch) {
  const names = manifest?.features?.map((f) => f.name) ?? [];
  const meanAbs = shapGlobal?.global?.mean_abs;
  const order = shapGlobal?.features ?? names;
  if (Array.isArray(meanAbs) && meanAbs.length === order.length && meanAbs.length) {
    let best = 0;
    meanAbs.forEach((v, i) => {
      if (Number(v) > Number(meanAbs[best])) best = i;
    });
    if (names.includes(order[best])) return order[best];
  }
  const spread = epoch?.stats?.shapMaxAbs;
  if (spread) {
    const ranked = names.filter((n) => Number.isFinite(spread[n])).sort((a, b) => spread[b] - spread[a]);
    if (ranked.length) return ranked[0];
  }
  return names[0] ?? null;
}

function latestYear(manifest) {
  const years = (manifest?.epochs ?? []).map(Number).filter(Number.isFinite);
  return years.length ? Math.max(...years) : null;
}

/** Load all optional assets; failures become warnings instead of errors. */
async function loadOptionalAssets(manifest) {
  const keys = Object.keys(OPTIONAL_ASSETS);
  const settled = await Promise.allSettled(keys.map((key) => loadAsset(manifest, key)));
  const assets = { ...EMPTY_ASSETS };
  const warnings = [];
  settled.forEach((result, i) => {
    const key = keys[i];
    if (result.status === "fulfilled") {
      assets[OPTIONAL_ASSETS[key]] = result.value;
      if (result.value === null) warnings.push(`Optional asset "${key}" is not declared in the manifest.`);
    } else {
      const message = `Optional asset "${key}" failed to load: ${result.reason?.message ?? result.reason}`;
      console.warn(`[data] ${message}`);
      warnings.push(message);
    }
  });
  return { assets, warnings };
}

function compileOrWarn(modelRaw, warnings) {
  if (!modelRaw) return null;
  try {
    return compileModel(modelRaw);
  } catch (error) {
    const message = `Scenario model could not be compiled: ${error.message}`;
    console.warn(`[data] ${message}`);
    warnings.push(message);
    return null;
  }
}

/** Run a callback when the browser is idle (falls back to a short timeout). */
function whenIdle(callback) {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: 1500 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 50);
  return () => clearTimeout(handle);
}

export function DataProvider({ children }) {
  const [load, setLoad] = useState(INITIAL_LOAD);
  const [reloadToken, setReloadToken] = useState(0);
  const [epochs, setEpochs] = useState({});
  const [year, setYearState] = useState(null);
  const [pendingYear, setPendingYear] = useState(null);
  const [epochError, setEpochError] = useState(null);
  const [view, setView] = useState("twin");
  const [mapLayer, setMapLayer] = useState("lst_obs");
  const [shapFeature, setShapFeature] = useState(null);
  const [selectedCell, setSelectedCell] = useState(null);
  const [scenario, setScenario] = useState(() => SCENARIO_PRESETS[0].scenario);
  const [scenarioResult, setScenarioResult] = useState(null);
  const [scenarioError, setScenarioError] = useState(null);
  const [scenarioPending, setScenarioPending] = useState(false);
  const [validation, setValidation] = useState(null);

  const { manifest, assets, model } = load;
  const epoch = year !== null ? epochs[year] ?? null : null;
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const requestedYearRef = useRef(null);
  const engineRef = useRef(null);
  const scenarioRunRef = useRef(0);

  // ---- initial load (re-run on reload) ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoad(INITIAL_LOAD);
      setValidation(null);
      let manifestJson;
      try {
        manifestJson = await loadManifest();
      } catch (error) {
        if (!cancelled) setLoad({ ...INITIAL_LOAD, status: error?.status === "empty" ? "empty" : "error", error });
        return;
      }
      const latest = latestYear(manifestJson);
      if (latest === null) {
        if (!cancelled) setLoad({ ...INITIAL_LOAD, status: "error", error: new Error("manifest.epochs is empty.") });
        return;
      }
      try {
        const [latestEpoch, optional] = await Promise.all([loadEpoch(manifestJson, latest), loadOptionalAssets(manifestJson)]);
        if (cancelled) return;
        const warnings = [...optional.warnings];
        const compiled = compileOrWarn(optional.assets.modelRaw, warnings);
        setEpochs({ [latest]: latestEpoch });
        setYearState(latest);
        setPendingYear(null);
        setShapFeature(defaultShapFeature(manifestJson, optional.assets.shapGlobal, latestEpoch));
        setLoad({
          status: "ready",
          error: null,
          manifest: manifestJson,
          assets: optional.assets,
          model: compiled,
          loadWarnings: warnings,
        });
      } catch (error) {
        if (!cancelled) setLoad({ ...INITIAL_LOAD, status: "error", error, manifest: manifestJson });
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // ---- bundle validation, off the critical path ------------------------------------------
  // First pass: manifest, every small asset and the first loaded epoch.
  useEffect(() => {
    if (load.status !== "ready" || validation) return undefined;
    const firstYear = Object.keys(epochs)[0];
    return whenIdle(() => {
      try {
        const result = validateBundle({
          manifest,
          epochs: firstYear ? { [firstYear]: epochs[firstYear] } : {},
          model: assets.modelRaw,
          dependence: assets.dependence,
          zones: assets.zones,
          metrics: assets.metrics,
          shapGlobal: assets.shapGlobal,
          interactions: assets.interactions,
          coupling: assets.coupling,
          districts: assets.districtsGeo,
        });
        const warnings = [...load.loadWarnings, ...result.warnings];
        if (result.errors.length) console.warn("[validate] bundle contract errors:", result.errors);
        setValidation({ ...result, warnings });
      } catch (error) {
        setValidation({
          ok: false,
          errors: [`Validation crashed: ${error.message}`],
          warnings: load.loadWarnings,
          epochsChecked: [],
        });
      }
    });
  }, [load, validation, manifest, assets, epochs]);

  // Later passes: every epoch loaded (or prefetched) after the first one.
  useEffect(() => {
    if (load.status !== "ready" || !validation) return undefined;
    const years = uncheckedYears(validation, epochs);
    if (!years.length) return undefined;
    return whenIdle(() => {
      let next;
      try {
        next = validateEpochs({ manifest, epochs: Object.fromEntries(years.map((y) => [y, epochs[y]])) });
      } catch (error) {
        next = { ok: false, errors: [`Validation of epochs ${years.join(", ")} crashed: ${error.message}`], warnings: [], epochsChecked: years };
      }
      if (next.errors.length) console.warn("[validate] epoch contract errors:", next.errors);
      setValidation((prev) => mergeValidation(prev, next));
    });
  }, [load.status, validation, epochs, manifest]);

  // ---- epochs ----------------------------------------------------------------------------
  const getEpoch = useCallback(
    async (y) => {
      if (!manifest) throw new Error("getEpoch: manifest not loaded yet");
      const loaded = await loadEpoch(manifest, y);
      setEpochs((prev) => (prev[y] === loaded ? prev : { ...prev, [y]: loaded }));
      return loaded;
    },
    [manifest],
  );

  /** Switch epochs atomically, carrying the pinned cell across by cell_id. */
  const commitYear = useCallback((y, nextEpoch) => {
    const previous = epochRef.current;
    setYearState(y);
    setPendingYear(null);
    setEpochError(null);
    setSelectedCell((cell) => {
      if (cell === null || cell === undefined || !previous || previous === nextEpoch) return cell;
      const cellId = previous.cell_id[cell];
      return nextEpoch.index.get(cellId) ?? null;
    });
  }, []);

  const setYear = useCallback(
    (y) => {
      const target = Number(y);
      if (!manifest || !manifest.epochs.map(Number).includes(target)) return;
      requestedYearRef.current = target;
      if (epochs[target]) {
        commitYear(target, epochs[target]);
        return;
      }
      setPendingYear(target);
      getEpoch(target)
        .then((loaded) => {
          if (requestedYearRef.current === target) commitYear(target, loaded);
        })
        .catch((error) => {
          console.warn(`[data] epoch ${target} failed to load`, error);
          if (requestedYearRef.current === target) {
            setPendingYear(null);
            setEpochError(error);
          }
        });
    },
    [manifest, epochs, getEpoch, commitYear],
  );

  // Prefetch the neighbouring epochs of the current one when the browser is idle.
  useEffect(() => {
    if (!manifest || year === null) return undefined;
    const years = manifest.epochs.map(Number);
    const i = years.indexOf(year);
    const neighbours = [years[i - 1], years[i + 1]].filter((y) => y !== undefined && !epochs[y]);
    if (!neighbours.length) return undefined;
    return whenIdle(() => {
      neighbours.forEach((y) =>
        getEpoch(y).catch((error) => console.warn(`[data] prefetch of epoch ${y} failed`, error)),
      );
    });
  }, [manifest, year, epochs, getEpoch]);

  // ---- scenario (only while visible; debounced; worker; superseded replies dropped) ----------
  const scenarioActive = scenarioIsActive(view, mapLayer);
  useEffect(() => {
    const engine = new ScenarioEngine();
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    if (!epoch || !model || !scenario) {
      setScenarioResult(null);
      setScenarioPending(false);
      return undefined;
    }
    if (!scenarioActive) {
      setScenarioPending(false);
      return undefined;
    }
    scenarioRunRef.current += 1;
    const runId = scenarioRunRef.current;
    let cancelled = false;
    setScenarioPending(true);
    const handle = setTimeout(() => {
      const engine = engineRef.current ?? new ScenarioEngine({ workerFactory: null });
      engine
        .run({ epoch, model, modelRaw: assets.modelRaw, coupling: assets.coupling, manifest, scenario })
        .then((result) => {
          if (cancelled || runId !== scenarioRunRef.current) return;
          startTransition(() => {
            setScenarioResult(result ? { ...result, scenarioKey: scenario } : null);
            setScenarioError(null);
            setScenarioPending(false);
          });
        })
        .catch((error) => {
          if (cancelled || runId !== scenarioRunRef.current) return;
          console.warn("[scenario] failed", error);
          setScenarioResult(null);
          setScenarioError(error);
          setScenarioPending(false);
        });
    }, SCENARIO_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [epoch, model, scenario, scenarioActive, assets.coupling, assets.modelRaw, manifest]);

  const reload = useCallback(() => {
    clearDataCache();
    setEpochs({});
    setYearState(null);
    setPendingYear(null);
    setSelectedCell(null);
    setScenarioResult(null);
    setScenarioError(null);
    setReloadToken((t) => t + 1);
  }, []);

  const exposedScenarioResult = currentScenarioResult(scenarioResult, year);
  const uncertainty = useMemo(() => bootstrapInfo(manifest, assets.shapGlobal), [manifest, assets.shapGlobal]);
  const presets = useMemo(() => presetsFor(manifest, assets.zones), [manifest, assets.zones]);

  const features = useMemo(() => manifest?.features ?? [], [manifest]);
  const featureIndex = useMemo(() => Object.fromEntries(features.map((f, i) => [f.name, i])), [features]);

  const value = useMemo(
    () => ({
      status: load.status,
      error: load.error,
      manifest,
      features,
      featureIndex,
      districts: manifest?.districts ?? [],
      zonesMeta: manifest?.zones ?? [],
      year,
      setYear,
      pendingYear,
      epoch,
      epochs,
      epochLoading: pendingYear !== null,
      epochError,
      getEpoch,
      shapGlobal: assets.shapGlobal,
      dependence: assets.dependence,
      zones: assets.zones,
      metrics: assets.metrics,
      districtsGeo: assets.districtsGeo,
      interactions: assets.interactions,
      coupling: assets.coupling,
      model,
      modelRaw: assets.modelRaw,
      view,
      setView,
      mapLayer,
      setMapLayer,
      shapFeature,
      setShapFeature,
      selectedCell,
      setSelectedCell,
      scenario,
      setScenario,
      scenarioResult: exposedScenarioResult,
      scenarioError,
      scenarioPending,
      scenarioActive,
      presets,
      uncertainty,
      validation,
      loadWarnings: load.loadWarnings,
      reload,
    }),
    [
      load,
      manifest,
      features,
      featureIndex,
      year,
      setYear,
      pendingYear,
      epoch,
      epochs,
      epochError,
      getEpoch,
      assets,
      model,
      view,
      mapLayer,
      shapFeature,
      selectedCell,
      scenario,
      exposedScenarioResult,
      scenarioError,
      scenarioPending,
      scenarioActive,
      presets,
      uncertainty,
      validation,
      reload,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

/** Access the shared data/UI state. Must be used inside <DataProvider>. */
// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its provider (SPEC 5.1)
export function useData() {
  const context = useContext(DataContext);
  if (!context) throw new Error("useData() must be used inside <DataProvider>.");
  return context;
}
