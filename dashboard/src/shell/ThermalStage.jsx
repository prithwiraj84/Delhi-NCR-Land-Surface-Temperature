/**
 * ThermalStage (UI_SPEC §1 principle 2, §6.5): the persistent deck.gl + MapLibre stage.
 *
 * AppShell mounts it once and keeps it across routes (`layout`: live / dimmed / dock-right /
 * dock-left / hidden; `active` = interactive + rendering; `dimmed` = visible but paused).
 *
 * The component is deliberately thin: the MapEngine (src/engine/MapEngine.js) owns layers, camera,
 * picking and the render loop through the DeckGL ref, so React renders this tree only when the
 * stage's own chrome changes (layout, bundle, basemap health, WebGL loss, perf tier, status chip)
 * — never per scrub tick. On every render it hands DeckGL the engine's CURRENT layers and view
 * state, so a React render can never roll the map back.
 *
 * States: live, dimmed-paused, compare, lens (engine-drawn), lite (CPU path), webgl-lost (Retry
 * card), basemap-unavailable (thermal layers keep rendering over --void).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Deck } from "@deck.gl/core";
import DeckGL from "@deck.gl/react";
import { useStore } from "zustand";
import { MonitorX, RotateCcw } from "lucide-react";
import { BASEMAP_STYLE_NOLABELS_URL, BASEMAP_STYLE_URL } from "../components/map/basemapStyles.js";
import Basemap from "../components/map/LazyBasemap.jsx";
import { useBundleStoreApi } from "../data/hooks.js";
import { CONTROLLER, EVENT_RECOGNIZER_OPTIONS, MapEngine, setMapEngine } from "../engine/MapEngine.js";
import { engineStore } from "../engine/engineStore.js";
import { tierEffects } from "../engine/perfGovernor.js";
import { useData } from "../state/DataContext.jsx";
import { useSelectionStore, useTimeStore, useViewStore } from "../state/stores/index.js";

/**
 * Deck subclass that keeps the engine the single source of layers AND camera. @deck.gl/react
 * forwards its render-time props to deck.setProps DURING render (those calls always carry
 * `parent`). React 19 can replay an uncommitted render (e.g. after the lazy basemap suspends)
 * frames later, and the replay would hand deck what was captured back then:
 *   - layers: reticle layers deck has since finalized ("initialization of ScatterplotLayer …
 *     assertion failed", then GL_INVALID_OPERATION floods);
 *   - viewState: an OLD camera, which yanked the map back during wheel zoom and pans (measured:
 *     40 wheel notches reached zoom 11.4 instead of 14, programmatic zooms were undone, and the
 *     250 m raster never switched on), i.e. the "laggy zoom".
 * Substituting the engine's CURRENT layers and view state at call time makes stale values
 * impossible; the engine's own setProps({layers} / {viewState}) calls (no `parent`) pass through.
 */
function deckClassFor(engine) {
  return class EngineDeck extends Deck {
    setProps(props) {
      if (props && "parent" in props) {
        props = { ...props };
        if ("layers" in props) props.layers = engine.getLayers() ?? props.layers;
        if ("viewState" in props) props.viewState = engine.getViewState() ?? props.viewState;
      }
      super.setProps(props);
    }
  };
}

const MOBILE_QUERY = "(max-width: 639.98px)";

function useMediaQuery(query) {
  const read = () => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  };
  const [match, setMatch] = useState(read);
  useEffect(() => {
    let mql = null;
    try {
      mql = window.matchMedia?.(query) ?? null;
    } catch {
      mql = null;
    }
    if (!mql) return undefined;
    const onChange = () => setMatch(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return match;
}

function usePerfHud() {
  const [on] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("perf") === "1";
    } catch {
      return false;
    }
  });
  return on;
}

/** Card shown when the WebGL context is lost (driver reset, GPU memory pressure, tab eviction). */
function WebGlLostCard({ onRetry }) {
  return (
    <div data-testid="webgl-lost" className="absolute inset-0 z-10 grid place-items-center bg-void/80 p-4">
      <div role="alert" className="pointer-events-auto max-w-sm rounded-panel border border-hairline bg-surface-2 p-5 text-sm text-ink shadow-lg">
        <div className="mb-2 flex items-center gap-2 font-display text-base font-semibold text-ink-strong">
          <MonitorX aria-hidden="true" className="h-5 w-5 text-warn" />
          The map lost its graphics context
        </div>
        <p className="mb-4 text-ink-muted">
          The browser reset WebGL (a GPU driver reset or memory pressure). Your year, layer and selection are kept; restarting the map
          rebuilds the graphics only.
        </p>
        <button type="button" onClick={onRetry} className="focus-ring inline-flex items-center gap-2 rounded-md border border-control bg-surface-3 px-3 py-1.5 font-medium text-ink-strong hover:bg-surface-1">
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          Restart the map
        </button>
      </div>
    </div>
  );
}

/** Small non-live status chip: buffering, unavailable reasons, CPU fallback, basemap problems. */
function StageStatusChip({ status, reason, path, pathReason, basemapError }) {
  const lines = [];
  if (status === "buffering") lines.push(`⟳ ${reason ?? "streaming"}`);
  else if ((status === "unavailable" || status === "error") && reason) lines.push(reason);
  else if (reason && status === "ready") lines.push(reason);
  if (path === "cpu" && pathReason && pathReason !== "GPU not ready") lines.push(`CPU path · ${pathReason}`);
  if (basemapError) lines.push("Basemap unavailable · thermal layers unaffected");
  if (!lines.length) return null;
  return (
    <div data-testid="stage-status" className="pointer-events-none absolute bottom-40 left-1/2 z-[5] max-w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border border-hairline bg-surface-2/95 px-3 py-1.5 text-center font-sans text-[11px] text-ink-muted">
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

/**
 * ?perf=1 HUD. It subscribes to engineStore.perf / .raster ITSELF (perf changes every frame), so
 * only this small component re-renders per frame — never ThermalStage and its DeckGL / MapLibre
 * children (UI_SPEC §6.5). Updates are coalesced to ~4 Hz.
 */
function EngineHud({ path }) {
  const [snap, setSnap] = useState(() => ({ perf: engineStore.getState().perf, raster: engineStore.getState().raster }));
  useEffect(() => {
    let timer = null;
    const flush = () => {
      timer = null;
      const s = engineStore.getState();
      setSnap((prev) => (prev.perf === s.perf && prev.raster === s.raster ? prev : { perf: s.perf, raster: s.raster }));
    };
    const unsub = engineStore.subscribe((s, prev) => {
      if (s.perf === prev.perf && s.raster === prev.raster) return;
      if (!timer) timer = setTimeout(flush, 250);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
  const { perf, raster } = snap;
  return (
    <div data-testid="engine-hud" className="pointer-events-none absolute bottom-3 right-3 z-[5] rounded-md border border-hairline bg-surface-2/95 px-2 py-1 font-mono text-[11px] text-ink-muted">
      ENGINE {path.toUpperCase()} · T{perf.tier} · {perf.fps ?? "–"} fps · EMA {perf.ema ?? "–"} ms · GPU≈{perf.gpuMB} MB{raster?.visible ? ` · ${raster.key}` : ""}
    </div>
  );
}

export function ThermalStage({ layout = "live", active = true, dimmed = false }) {
  const api = useBundleStoreApi();
  const data = useData() ?? {};
  const scenarioResult = data.scenarioResult ?? null;
  const deckRef = useRef(null);
  const rootRef = useRef(null);
  const [engine, setEngine] = useState(null);
  const [deckKey, setDeckKey] = useState(0);
  const [lost, setLost] = useState(false);
  const [basemapError, setBasemapError] = useState(null);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const perfHud = usePerfHud();
  const labels = useViewStore((s) => s.analyst?.labels !== false);
  const perfTier = useViewStore((s) => s.perfTier ?? 0);
  const mode = useTimeStore((s) => s.mode);
  const status = useStore(engineStore, (s) => s.status);
  const reason = useStore(engineStore, (s) => s.reason);
  const path = useStore(engineStore, (s) => s.path);
  const pathReason = useStore(engineStore, (s) => s.pathReason);
  // perf (EMA/fps) and the raster key change every frame: only the ?perf=1 HUD component
  // subscribes to them, so the stage (and its DeckGL/MapLibre children) never re-renders per frame.

  // One engine per mount (created in an effect so StrictMode's double render cannot leak one).
  useEffect(() => {
    const e = new MapEngine({ bundle: api, time: useTimeStore, view: useViewStore, selection: useSelectionStore });
    setEngine(e);
    setMapEngine(e);
    // Dev/QA hook for the fps harness (UI_SPEC §14 "E3 owns the fps harness"): only with ?perf=1.
    if (perfHud) window.__NCR_ENGINE__ = e;
    return () => {
      setMapEngine(null);
      if (window.__NCR_ENGINE__ === e) delete window.__NCR_ENGINE__;
      e.destroy();
    };
  }, [api, perfHud]);

  useEffect(() => {
    engine?.setActive(active, { dimmed });
  }, [engine, active, dimmed]);

  useEffect(() => {
    engine?.setExternal({ mobile, scenario: scenarioResult });
  }, [engine, mobile, scenarioResult]);

  // Attach the deck instance once DeckGL has created it (child effects run before ours).
  useEffect(() => {
    if (!engine) return undefined;
    const deck = deckRef.current?.deck ?? null;
    if (deck) engine.attach(deck);
    return undefined;
  }, [engine, deckKey]);

  // Basemap dims to 70 % at night (UI_SPEC §4.5); applied to MapLibre's own canvas.
  const applyBasemapDim = useCallback(() => {
    const canvas = rootRef.current?.querySelector?.(".maplibregl-canvas");
    if (canvas) canvas.style.opacity = mode === "night" ? "0.7" : "1";
  }, [mode]);
  useEffect(applyBasemapDim, [applyBasemapDim]);

  // The device this stage currently owns: a loss reported by any other (retired) device —
  // the one replaced by Retry, or destroyed on unmount — is not a loss of the live map.
  const liveDeviceRef = useRef(null);
  useEffect(
    () => () => {
      liveDeviceRef.current = null;
    },
    [],
  );

  const onDeviceInitialized = useCallback(
    (device) => {
      if (!engine || !device) return;
      liveDeviceRef.current = device;
      engine.attach(deckRef.current?.deck ?? null);
      engine.setDevice(device);
      setLost(false);
      let reported = false;
      const onLost = (info) => {
        if (reported || liveDeviceRef.current !== device) return;
        reported = true;
        console.warn("[stage] WebGL context lost", info?.message ?? info?.type ?? info);
        engineStore.patch({ status: "webgl-lost", reason: "WebGL context lost" });
        setLost(true);
      };
      // luma resolves `device.lost` on a real loss (its reason is "destroyed" for both kinds), and
      // the canvas event covers drivers where the promise is late.
      device.lost?.then?.(onLost);
      const canvas = device.canvasContext?.canvas ?? deckRef.current?.deck?.getCanvas?.();
      canvas?.addEventListener?.("webglcontextlost", onLost, { once: true });
    },
    [engine],
  );

  const retry = useCallback(() => {
    liveDeviceRef.current = null;
    // Releases the textures AND every cached deck layer (boundaries, labels, columns, compare),
    // so the new DeckGL instance never receives a layer of the lost context.
    engine?.resetGpu();
    engineStore.patch({ status: "loading", reason: null });
    setLost(false);
    setDeckKey((k) => k + 1);
  }, [engine]);

  const onBasemapFailure = useCallback((error) => setBasemapError(error instanceof Error ? error.message : "Basemap unavailable"), []);
  const onBasemapReady = useCallback(() => {
    setBasemapError(null);
    applyBasemapDim();
  }, [applyBasemapDim]);

  const DeckClass = useMemo(() => (engine ? deckClassFor(engine) : undefined), [engine]);
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, tierEffects(perfTier).maxDpr) : 1;

  return (
    <div ref={rootRef} data-layout={layout} data-mode={mode} data-engine-status={status} data-engine-path={path} className="absolute inset-0 bg-void" aria-label="Thermal map" role="region">
      {engine && !lost && (
        <DeckGL
          key={deckKey}
          ref={deckRef}
          Deck={DeckClass}
          viewState={engine.getViewState()}
          onViewStateChange={engine.handleViewStateChange}
          controller={active ? CONTROLLER : false}
          layers={engine.getLayers()}
          effects={engine.effects}
          onHover={engine.handleHover}
          onClick={engine.handleClick}
          onAfterRender={engine.handleAfterRender}
          onDeviceInitialized={onDeviceInitialized}
          onError={engine.handleDeckError}
          getCursor={engine.getCursor}
          eventRecognizerOptions={EVENT_RECOGNIZER_OPTIONS}
          pickingRadius={2}
          useDevicePixels={dpr}
        >
          <Basemap mapStyle={labels ? BASEMAP_STYLE_NOLABELS_URL : BASEMAP_STYLE_URL} onFailure={onBasemapFailure} onReady={onBasemapReady} />
        </DeckGL>
      )}
      {lost && <WebGlLostCard onRetry={retry} />}
      {!lost && <StageStatusChip status={status} reason={reason} path={path} pathReason={pathReason} basemapError={basemapError} />}
      {perfHud && <EngineHud path={path} />}
    </div>
  );
}

export default ThermalStage;
