/**
 * DataProvider + useData() facade (UI_SPEC §7).
 *
 * v2 architecture: the bundle lives in the BundleStore (`src/data/bundleStore.js`, vanilla
 * zustand) and the UI state in the time / view / selection stores; v2 code uses the hooks in
 * `src/data/hooks.js`. This provider
 *   1. starts the bundle load (source from `?bundle=data|demo|fixture`, see data/bundle.js),
 *   2. configures the stores once the timeline is known (years, NOW, modes, scenarios, D2 default
 *      variable, default SHAP group),
 *   3. validates the loaded bundle off the critical path (v1: lib/validate.validateBundle on the
 *      raw v1 assets + validateV2 on the adapted structure; v2: validateV2 on what is loaded),
 *   4. keeps the v1 `useData()` contract so every v1 component keeps working: `epoch` is a v1
 *      epoch object (v2: synthesised from the XAI frame, keyed by SHAP group), `features` the
 *      matching feature metas, `zones`/`shapGlobal`/… the per-mode v1 shapes, `view`/`mapLayer`/
 *      `selectedCell` mapped onto the v2 stores, and the debounced worker scenario engine.
 *
 * Epoch switching stays "stale-while-loading": `year`/`epoch` always describe the same epoch;
 * while the next one streams in, `pendingYear` holds it and `epochLoading` is true.
 */
import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { compileModel } from "../lib/model.js";
import { presetsFor, SCENARIO_PRESETS } from "../lib/scenarioPresets.js";
import { ScenarioEngine } from "../lib/scenarioEngine.js";
import { bootstrapInfo } from "../lib/uncertainty.js";
import { withBundleParam } from "../data/bundle.js";
import { ASSET_FILES, bundleStore as defaultBundleStore } from "../data/bundleStore.js";
import { BundleStoreContext } from "../data/hooks.js";
import { xaiYears } from "../data/timeline.js";
import { assetForMode } from "../data/v1Adapter.js";
import { groupFeatureMetas } from "../data/xai.js";
import {
  currentScenarioResult,
  facadeMode,
  facadeYear,
  routeForView,
  scenarioIsActive,
  v1LayerFor,
  v1ManifestView,
  v2LayerFor,
  viewForRoute,
} from "./contextLogic.js";
import { useSelectionStore } from "./stores/selectionStore.js";
import { useTimeStore } from "./stores/timeStore.js";
import { useViewStore } from "./stores/viewStore.js";

const DataContext = createContext(null);

const SCENARIO_DEBOUNCE_MS = 120;
export const VIEWS = Object.freeze(["twin", "thresholds", "zones", "performance"]);
export const MAP_LAYERS = Object.freeze(["lst_obs", "lst_pred", "resid_oof", "shap", "driver", "zones", "scenario"]);
const ASSET_NAMES = Object.keys(ASSET_FILES);
const VALIDATED_KEY = /^(cells|series|rasterIndex|districts|asset:|model:|cube:(day|night):|zones:|xai:|epoch:)/;
/** Routes whose views read the v1 facade epoch (useData().epoch). */
const EPOCH_ROUTES = new Set(["drivers", "zones", "lab"]);

/** Run a callback when the browser is idle (falls back to a short timeout). */
/** Lazily imported validators (lib/validate.js + data/validateV2.js); one shared promise. */
let validationModule = null;
function loadValidation() {
  if (!validationModule) {
    validationModule = import("./contextLogicValidation.js").catch((error) => {
      validationModule = null; // a transient chunk-load failure may be retried on the next run
      throw error;
    });
  }
  return validationModule;
}

function whenIdle(callback, timeout = 1500) {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 50);
  return () => clearTimeout(handle);
}

/** Most important group/feature: argmax of shap_global mean |SHAP| (per-mode v1 shape). */
function defaultShapFeature(features, shapGlobal) {
  const names = features.map((f) => f.name);
  const meanAbs = shapGlobal?.global?.mean_abs;
  const order = shapGlobal?.features ?? shapGlobal?.groups ?? names;
  if (Array.isArray(meanAbs) && meanAbs.length === order.length && meanAbs.length) {
    let best = 0;
    meanAbs.forEach((v, i) => {
      if (Number(v) > Number(meanAbs[best])) best = i;
    });
    if (names.includes(order[best])) return order[best];
  }
  return names[0] ?? null;
}

/** Ready data of one resource key (subscribes to that key only; entries are immutable). */
function useReadyData(store, key) {
  return useStore(store, (s) => {
    const e = key ? s.resources[key] : null;
    return e?.status === "ready" ? e.data : null;
  });
}

/** Signature of the ready facade epochs of a mode (a primitive, so unrelated loads do not re-render). */
function readyEpochSignature(resources, mode) {
  const years = [];
  for (const [key, e] of Object.entries(resources)) {
    const m = /^epoch:(\d+):(day|night)$/.exec(key);
    if (m && m[2] === mode && e?.status === "ready") years.push(m[1]);
  }
  return years.sort().join(",");
}

/**
 * Re-render isolation: the provider subscribes to individual resource keys and to primitive
 * signatures, never to the whole `resources` map or to live byte progress, so background loads
 * (raster prefetch during playback, XAI idle prefetch) do not re-render every useData() consumer.
 * Live progress stays available through `useBundleStatus()`; the facade's `progress` is live
 * during boot and frozen at the boot snapshot afterwards.
 *
 * @param {{children: React.ReactNode, store?: object, autoLoad?: boolean, search?: string}} props
 *   `store` injects a BundleStore (tests); `search` overrides `location.search` for the source.
 */
export function DataProvider({ children, store = defaultBundleStore, autoLoad = true, search = undefined }) {
  const status = useStore(store, (s) => s.status);
  const error = useStore(store, (s) => s.error);
  const manifest = useStore(store, (s) => s.manifest);
  const manifestV2 = useStore(store, (s) => s.manifestV2);
  const schema = useStore(store, (s) => s.schema);
  const timeline = useStore(store, (s) => s.timeline);
  const progress = useStore(store, (s) => (s.status === "ready" && s.bootProgress ? s.bootProgress : s.progress));
  const source = useStore(store, (s) => s.source);
  const validation = useStore(store, (s) => s.validation);
  const warnings = useStore(store, (s) => s.warnings);
  const groupsMeta = useStore(store, (s) => s.groupsMeta);

  const timeYear = useTimeStore((s) => s.year);
  const timeMode = useTimeStore((s) => s.mode);
  // Playback / scrubbing: heavy facade work (epoch synthesis, re-validation) waits for the pause.
  const moving = useTimeStore((s) => Boolean(s.playing || s.dragging));
  const route = useViewStore((s) => s.route);
  const layer = useViewStore((s) => s.layer);
  const shapFeature = useViewStore((s) => s.shapFeature);
  const pinnedIndex = useSelectionStore((s) => s.pinnedIndex);

  const [scenario, setScenario] = useState(() => SCENARIO_PRESETS[0].scenario);
  const [scenarioResult, setScenarioResult] = useState(null);
  const [scenarioError, setScenarioError] = useState(null);
  const [scenarioPending, setScenarioPending] = useState(false);
  const engineRef = useRef(null);
  const scenarioRunRef = useRef(0);
  const shownEpochRef = useRef({ key: null, epoch: null });

  // ---- load --------------------------------------------------------------------------------
  useEffect(() => {
    if (!autoLoad) return;
    const s = store.getState();
    if (s.status === "idle") s.load(search !== undefined ? { search } : {});
  }, [store, autoLoad, search]);

  // ---- configure the stores from the timeline ------------------------------------------------
  useEffect(() => {
    if (status !== "ready" || !timeline) return;
    useTimeStore.getState().configure(timeline);
    useViewStore.getState().configure({ harmonised: timeline.harmonised });
  }, [status, timeline]);

  // ---- small assets (v1 loaded them at boot; v2 lazily, here when idle) ------------------------
  const mode = facadeMode(timeMode);
  useEffect(() => {
    if (status !== "ready") return undefined;
    return whenIdle(() => store.getState().prefetch([...ASSET_NAMES.map((n) => `asset:${n}`), `model:${mode}`]));
  }, [store, status, mode]);

  const shapGlobalRaw = useReadyData(store, "asset:shapGlobal");
  const dependenceRaw = useReadyData(store, "asset:dependence");
  const zonesRaw = useReadyData(store, "asset:zones");
  const metricsRaw = useReadyData(store, "asset:metrics");
  const interactionsRaw = useReadyData(store, "asset:interactions");
  const coupling = useReadyData(store, "asset:coupling");
  const districtsGeo = useReadyData(store, "districts");
  const modelRaw = useReadyData(store, `model:${mode}`);
  const shapGlobal = useMemo(() => assetForMode("shapGlobal", shapGlobalRaw, mode), [shapGlobalRaw, mode]);
  const dependence = useMemo(() => assetForMode("dependence", dependenceRaw, mode), [dependenceRaw, mode]);
  const zones = useMemo(() => assetForMode("zones", zonesRaw, mode), [zonesRaw, mode]);
  const metrics = useMemo(() => assetForMode("metrics", metricsRaw, mode), [metricsRaw, mode]);
  const interactions = useMemo(() => assetForMode("interactions", interactionsRaw, mode), [interactionsRaw, mode]);
  const model = useMemo(() => {
    if (!modelRaw) return null;
    try {
      return compileModel(modelRaw);
    } catch (e) {
      console.warn(`[data] ${mode} scenario model could not be compiled: ${e.message}`);
      return null;
    }
  }, [modelRaw, mode]);

  // ---- features / manifest views ----------------------------------------------------------------
  const features = useMemo(() => (schema === "v2" ? groupFeatureMetas(manifest) : manifest?.features ?? []), [schema, manifest]);
  const featureIndex = useMemo(() => Object.fromEntries(features.map((f, i) => [f.name, i])), [features]);
  const v1Manifest = useMemo(() => v1ManifestView(manifest, { schema, mode, timeline, groupFeatures: features }), [manifest, schema, mode, timeline, features]);
  const zonesMeta = useMemo(() => v1Manifest?.zones ?? [], [v1Manifest]);

  // Default SHAP feature/group once the global importance is known.
  useEffect(() => {
    if (status !== "ready" || !features.length) return;
    const current = useViewStore.getState().shapFeature;
    if (current && featureIndex[current] !== undefined) return;
    useViewStore.getState().setShapFeature(defaultShapFeature(features, shapGlobal));
  }, [status, features, featureIndex, shapGlobal]);

  // ---- epochs (facade) ------------------------------------------------------------------------
  // A v1-shaped epoch is synthesised from the XAI frame only for its consumers (the Drivers,
  // Zones and Model Lab routes and an active scenario run), and never while the timeline plays or
  // is dragged: on the Control route every played frame would otherwise build a 55k-cell epoch
  // on the main thread (long tasks). v1 bundles preload their epochs at boot, so this gate only
  // decides when an existing one is shown.
  const epochYears = useMemo(() => (timeline ? xaiYears(timeline, mode) : []), [timeline, mode]);
  const wantedYear = facadeYear(epochYears, timeYear);
  const wantedKey = wantedYear !== null ? `epoch:${wantedYear}:${mode}` : null;
  const wantedEntry = useStore(store, (s) => (wantedKey ? s.resources[wantedKey] ?? null : null));
  const scenarioActiveNow = scenarioIsActive(viewForRoute(route), v1LayerFor(layer));
  const epochConsumers = EPOCH_ROUTES.has(route) || scenarioActiveNow;
  const epochWanted = epochConsumers && !moving;
  useEffect(() => {
    if (status === "ready" && epochWanted && wantedKey && (!wantedEntry || wantedEntry.status === "idle")) store.getState().ensure(wantedKey);
  }, [store, status, epochWanted, wantedKey, wantedEntry]);
  if (wantedEntry?.status === "ready" && shownEpochRef.current.key !== wantedKey) {
    shownEpochRef.current = { key: wantedKey, epoch: wantedEntry.data, year: wantedYear, mode };
  }
  const shown = shownEpochRef.current.mode === mode ? shownEpochRef.current : { key: null, epoch: null, year: null };
  const epoch = shown.epoch;
  const year = epoch ? shown.year : null;
  const epochLoading = (epochConsumers || wantedEntry?.status === "loading") && Boolean(wantedKey) && wantedEntry?.status !== "ready" && wantedEntry?.status !== "error" && wantedEntry?.status !== "unavailable";
  const epochErrorReason = wantedEntry?.status === "error" ? wantedEntry.reason : null;
  const epochError = useMemo(() => (epochErrorReason ? new Error(epochErrorReason) : null), [epochErrorReason]);
  const pendingYear = epochLoading ? wantedYear : null;
  const epochSignature = useStore(store, (s) => readyEpochSignature(s.resources, mode));
  const epochs = useMemo(() => {
    const out = {};
    const res = store.getState().resources;
    for (const y of epochSignature ? epochSignature.split(",") : []) out[y] = res[`epoch:${y}:${mode}`]?.data ?? null;
    return out;
  }, [store, epochSignature, mode]);

  // Prefetch the neighbouring epochs when idle (stepping through time stays instant).
  useEffect(() => {
    if (status !== "ready" || year === null || !epochWanted) return undefined;
    const i = epochYears.indexOf(year);
    const keys = [epochYears[i - 1], epochYears[i + 1]].filter((y) => y !== undefined).map((y) => `epoch:${y}:${mode}`);
    return whenIdle(() => store.getState().prefetch(keys));
  }, [store, status, year, epochYears, mode, epochWanted]);

  const setYear = useCallback((y) => {
    const target = Number(y);
    if (Number.isFinite(target)) useTimeStore.getState().setYear(target);
  }, []);
  const getEpoch = useCallback((y) => store.getState().ensureData(`epoch:${Number(y)}:${mode}`), [store, mode]);

  // Carry the pinned cell across epochs: canonical cell order makes indices identical; only a
  // v1 epoch with a different cell set (never produced by the notebook) would need remapping.
  const selectedCell = pinnedIndex !== null && epoch && pinnedIndex < epoch.n ? pinnedIndex : null;
  const setSelectedCell = useCallback((index) => {
    const value = typeof index === "function" ? index(useSelectionStore.getState().pinnedIndex) : index;
    useSelectionStore.getState().pin(value === undefined ? null : value);
  }, []);

  // ---- view / layer mapping ------------------------------------------------------------------------
  const view = viewForRoute(route);
  const setView = useCallback((v) => {
    const r = routeForView(v);
    if (r) useViewStore.getState().setRoute(r);
  }, []);
  const mapLayer = v1LayerFor(layer);
  const setMapLayer = useCallback((l) => {
    const v2 = v2LayerFor(l);
    if (v2) useViewStore.getState().setLayer(v2);
  }, []);
  const setShapFeature = useCallback((f) => useViewStore.getState().setShapFeature(f), []);

  // ---- validation (idle; re-run when new frames/cubes arrive) ---------------------------------------
  // Only resources the validators inspect trigger a re-run (rasters and raw feature files do not,
  // so playback prefetch never re-validates the bundle).
  const readyCount = useStore(store, (s) => {
    let n = 0;
    for (const [key, e] of Object.entries(s.resources)) if (e?.status === "ready" && VALIDATED_KEY.test(key)) n += 1;
    return n;
  });
  // While playing, new frames keep landing: validate once after the pause instead of per frame.
  const validatedCountRef = useRef(-1);
  useEffect(() => {
    if (status !== "ready" || moving) return undefined;
    if (validatedCountRef.current === readyCount) return undefined;
    let cancelled = false;
    const crashed = (e) =>
      store.getState().setValidation({ ok: false, errors: [`Validation crashed: ${e?.message ?? e}`], warnings: [], epochsChecked: [] });
    const cancelIdle = whenIdle(() => {
      // The validators (~40 kB of contract checks) are loaded on first use, off the boot path.
      loadValidation()
        .then(({ validateLoadedBundle }) => {
          if (cancelled) return;
          validatedCountRef.current = readyCount;
          const result = validateLoadedBundle(store.getState());
          if (result.errors.length) console.warn("[validate] bundle contract errors:", result.errors);
          store.getState().setValidation({ ...result, warnings: [...store.getState().warnings, ...result.warnings] });
        })
        .catch((e) => {
          if (!cancelled) crashed(e);
        });
    }, 3000);
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [store, status, readyCount, moving]);

  // ---- scenario engine (only while visible; debounced; worker; superseded replies dropped) ---------
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
        .run({ epoch, model, modelRaw, coupling, manifest: v1Manifest, scenario })
        .then((res) => {
          if (cancelled || runId !== scenarioRunRef.current) return;
          startTransition(() => {
            // scenarioKey: the scenario object (the simulator compares it by identity);
            // runKey: a primitive per run, which the map engine keys its what-if frames on.
            setScenarioResult(res ? { ...res, scenarioKey: scenario, runKey: runId } : null);
            setScenarioError(null);
            setScenarioPending(false);
          });
        })
        .catch((e) => {
          if (cancelled || runId !== scenarioRunRef.current) return;
          console.warn("[scenario] failed", e);
          setScenarioResult(null);
          setScenarioError(e);
          setScenarioPending(false);
        });
    }, SCENARIO_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [epoch, model, scenario, scenarioActive, coupling, modelRaw, v1Manifest]);

  // ---- reload / bundle switch ------------------------------------------------------------------------
  const resetUi = useCallback(() => {
    shownEpochRef.current = { key: null, epoch: null };
    useSelectionStore.getState().clear();
    useTimeStore.getState().reset();
    setScenarioResult(null);
    setScenarioError(null);
  }, []);
  const reload = useCallback(() => {
    resetUi();
    store.getState().reload();
  }, [store, resetUi]);
  const setBundleSource = useCallback(
    (id) => {
      resetUi();
      const query = withBundleParam(typeof location !== "undefined" ? location.search : "", id);
      store.getState().load({ search: query });
    },
    [store, resetUi],
  );

  const exposedScenarioResult = currentScenarioResult(scenarioResult, year);
  const uncertainty = useMemo(() => bootstrapInfo(v1Manifest, shapGlobal), [v1Manifest, shapGlobal]);
  const presets = useMemo(() => presetsFor(v1Manifest, zones), [v1Manifest, zones]);
  const facadeStatus = status === "idle" ? "loading" : status;

  const value = useMemo(
    () => ({
      // v1 contract (SPEC_v1 §5.1)
      status: facadeStatus,
      error: error ? Object.assign(new Error(error.message), error) : null,
      manifest,
      features,
      featureIndex,
      districts: manifest?.districts ?? [],
      zonesMeta,
      year,
      setYear,
      pendingYear,
      epoch,
      epochs,
      epochLoading,
      epochError,
      getEpoch,
      shapGlobal,
      dependence,
      zones,
      metrics,
      districtsGeo,
      interactions,
      coupling,
      model,
      modelRaw,
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
      loadWarnings: warnings,
      reload,
      // v2 additions
      schema,
      mode,
      timeline,
      manifestV2,
      v1Manifest,
      groupsMeta,
      progress,
      source,
      bundleStore: store,
      setBundleSource,
    }),
    [
      facadeStatus, error, manifest, features, featureIndex, zonesMeta, year, setYear, pendingYear, epoch, epochs,
      epochLoading, epochError, getEpoch, shapGlobal, dependence, zones, metrics, districtsGeo, interactions, coupling,
      model, modelRaw, view, setView, mapLayer, setMapLayer, shapFeature, setShapFeature, selectedCell, setSelectedCell,
      scenario, exposedScenarioResult, scenarioError, scenarioPending, scenarioActive, presets, uncertainty, validation,
      warnings, reload, schema, mode, timeline, manifestV2, v1Manifest, groupsMeta, progress, source, store, setBundleSource,
    ],
  );

  return (
    <BundleStoreContext.Provider value={store}>
      <DataContext.Provider value={value}>{children}</DataContext.Provider>
    </BundleStoreContext.Provider>
  );
}

/** Access the shared data/UI state (v1 facade + v2 additions). Must be used inside <DataProvider>. */
// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its provider (SPEC_v1 5.1)
export function useData() {
  const context = useContext(DataContext);
  if (!context) throw new Error("useData() must be used inside <DataProvider>.");
  return context;
}
