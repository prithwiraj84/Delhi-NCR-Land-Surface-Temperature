/**
 * Interactive Spatial Digital Twin (view "twin").
 *
 * deck.gl 9 renders the Delhi NCR thermal grid as ~55k extruded square prisms (one per
 * 1 km² cell) over a MapLibre CARTO Dark Matter basemap. The active layer (observed /
 * predicted LST, OOF residuals, SHAP of one feature, dominant driver, governance zones or
 * a what-if scenario delta) drives both colour and prism height. Hovering a cell shows its
 * additive TreeSHAP waterfall; clicking pins it and docks the full decomposition.
 *
 * State ownership:
 *   - shared (DataContext): year/epoch, mapLayer, shapFeature, selectedCell, scenarioResult
 *   - local: camera (controlled deck.gl viewState), render settings, hover, basemap health
 *
 * Performance: per-cell colours/elevations are memoised typed arrays keyed by
 * (layer, epoch, feature, scenario); sliders only change layer uniforms; hover state is
 * the only thing that re-renders on pointer moves and never invalidates layer attributes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import DeckGL from "@deck.gl/react";
import { FlyToInterpolator, LinearInterpolator, WebMercatorViewport } from "@deck.gl/core";
import { cellToLatLng } from "h3-js";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useData } from "../state/DataContext.jsx";
import { cn } from "../lib/cn.js";
import { featureLabel, fmtKm2 } from "../lib/format.js";
import Basemap, { BASEMAP_STYLE_NOLABELS_URL, BASEMAP_STYLE_URL } from "./map/Basemap.jsx";
import LayerControls from "./map/LayerControls.jsx";
import MapLegend from "./map/MapLegend.jsx";
import KpiChips from "./map/KpiChips.jsx";
import ScenarioChip from "./map/ScenarioChip.jsx";
import { CellDetailPanel, CellTooltip, HexTooltip } from "./map/CellInspector.jsx";
import {
  MAP_EFFECTS,
  createBoundaryLayer,
  createCellLayer,
  createHexLayer,
  createLabelLayer,
  createPinnedCellLayer,
} from "./map/layers.js";
import {
  buildCellAttributes,
  categoryShares,
  computeEpochKpis,
  identityKey,
  resolveMetric,
  summarizeDistricts,
  pickCell,
  PICK_MODES,
  zoneCategories,
} from "./map/mapMetrics.js";
import { useH3Aggregation } from "./map/useH3Aggregation.js";

/** Camera defaults (SPEC: centre from the manifest, oblique 3-D view). */
const INITIAL_ZOOM = 7.7;
const PITCH_3D = 50;
const INITIAL_BEARING = -12;
const FALLBACK_CENTER = [77.2, 28.6];

const DEFAULT_SETTINGS = {
  is3D: true,
  elevationScale: 1,
  opacity: 0.92,
  h3Enabled: false,
  h3Resolution: 6,
  showBoundaries: true,
  showLabels: true,
};

/**
 * Prism heights are metres, so on-screen relief doubles with every zoom level. Beyond the
 * initial zoom the extrusion is damped by 2^(-0.85·Δzoom) so a district close-up keeps a
 * readable relief instead of walls of 20 km columns (quantised to 0.1 zoom steps).
 */
function zoomElevationFactor(zoom) {
  const dz = Math.round((zoom - INITIAL_ZOOM) * 10) / 10;
  return dz > 0 ? Math.max(2 ** (-0.85 * dz), 0.03) : 1;
}

const CONTROLLER = { dragRotate: true, touchRotate: true, keyboard: true, inertia: 300 };

/**
 * mjolnir.js recognises a click as a "tap" only if pointerdown -> pointerup takes < 250 ms
 * of *processed* time. The pointerdown triggers a GPU picking pass over ~55k extruded
 * prisms; on integrated / software GPUs that pass (a synchronous readPixels) can block the
 * main thread for several hundred ms, so pointerup is handled late and the click - i.e.
 * "pin this cell" - is silently dropped (reproduced under SwiftShader: 516 ms). A 700 ms
 * window keeps pinning reliable; the unchanged 9 px movement threshold still separates
 * clicks from drags. Module-level constant so DeckGL sees a stable prop.
 */
const EVENT_RECOGNIZER_OPTIONS = { click: { time: 700 } };

/** Below this map width (px) the overlays switch to the stacked phone layout. */
const COMPACT_WIDTH_PX = 640;

/** Stable empty array for hooks that need an array before the manifest is ready. */
const EMPTY = [];

/** Initial camera for a manifest. */
function initialViewState(manifest) {
  const center = manifest?.study_area?.center;
  const [longitude, latitude] = Array.isArray(center) && center.length === 2 ? center : FALLBACK_CENTER;
  return {
    longitude,
    latitude,
    zoom: INITIAL_ZOOM,
    pitch: PITCH_3D,
    bearing: INITIAL_BEARING,
    minZoom: 5,
    maxZoom: 14,
    maxPitch: 70,
  };
}

/** Track the rendered size of the map container (tooltip clamping, fit-to-bounds). */
function useElementSize(ref) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setSize({ width: el.clientWidth || 1, height: el.clientHeight || 1 });
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Informative placeholder while the bundle or epoch is not available. */
function MapPlaceholder({ title, detail, busy = false }) {
  return (
    <div className="flex h-full min-h-[28rem] w-full flex-1 items-center justify-center rounded-2xl border border-panel-border bg-bg-raised/60">
      <div className="max-w-sm text-center">
        {busy ? (
          <LoaderCircle className="mx-auto mb-3 h-6 w-6 animate-spin text-cyan" aria-hidden="true" />
        ) : (
          <TriangleAlert className="mx-auto mb-3 h-6 w-6 text-amber" aria-hidden="true" />
        )}
        <p className="font-display text-base font-semibold text-ink-strong">{title}</p>
        {detail ? <p className="mt-1 text-sm text-ink-muted">{detail}</p> : null}
      </div>
    </div>
  );
}

/** The twin itself; mounted only once the manifest and an epoch are available. */
function TwinMap({ data }) {
  const {
    manifest,
    districts,
    zonesMeta,
    epoch,
    epochLoading,
    districtsGeo,
    mapLayer,
    setMapLayer,
    shapFeature,
    setShapFeature,
    selectedCell,
    setSelectedCell,
    scenario,
    scenarioResult,
    setView,
  } = data;

  const containerRef = useRef(null);
  const bounds = useElementSize(containerRef);
  const homeView = useMemo(() => initialViewState(manifest), [manifest]);
  const [viewState, setViewState] = useState(homeView);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [hover, setHover] = useState(null);
  const [basemapError, setBasemapError] = useState(null);
  const [flyTarget, setFlyTarget] = useState("");
  // Phones: the overlays cannot sit side by side, so the controls start collapsed and,
  // when expanded, act as a drawer that temporarily hides the other overlays.
  const [controlsOpen, setControlsOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= COMPACT_WIDTH_PX,
  );
  const compact = bounds.width > 1 && bounds.width < COMPACT_WIDTH_PX;
  const drawerMode = compact && controlsOpen;

  // Height of the bottom-left stack (legend + notices). On wide maps the controls panel
  // (top-left) and the legend share the left edge; on short viewports (e.g. 1440x900) the
  // panel used to run underneath the legend, hiding "Fly to district". Bounding the panel
  // by the measured legend height makes it scroll internally instead.
  const [legendStackEl, setLegendStackEl] = useState(null);
  const [legendStackH, setLegendStackH] = useState(0);
  useEffect(() => {
    if (!legendStackEl || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => setLegendStackH(Math.ceil(entry.contentRect.height)));
    ro.observe(legendStackEl);
    return () => ro.disconnect();
  }, [legendStackEl]);

  const updateSettings = useCallback((patch) => setSettings((s) => ({ ...s, ...patch })), []);

  /* ------------------------------ derived data ------------------------------------ */
  const featureNames = useMemo(() => (manifest.features ?? EMPTY).map((f) => f.name), [manifest]);
  const labelOf = useCallback((name) => featureLabel(manifest, name), [manifest]);
  const activeShapFeature = featureNames.includes(shapFeature) ? shapFeature : featureNames[0];
  const districtList = districts ?? manifest.districts ?? EMPTY;
  const zoneList = zonesMeta ?? manifest.zones ?? null;
  const layerScenario = mapLayer === "scenario" ? scenarioResult : null;

  const metric = useMemo(
    () =>
      resolveMetric({
        layer: mapLayer,
        epoch,
        shapFeature: activeShapFeature,
        scenarioResult: layerScenario,
        featureNames,
        zonesMeta: zoneList,
        labelOf,
      }),
    [mapLayer, epoch, activeShapFeature, layerScenario, featureNames, zoneList, labelOf],
  );
  const attributes = useMemo(() => buildCellAttributes(metric, epoch.n), [metric, epoch.n]);
  const shares = useMemo(
    () => (metric.kind === "categorical" ? categoryShares(metric, epoch.n) : EMPTY),
    [metric, epoch.n],
  );
  const districtSummaries = useMemo(() => summarizeDistricts(epoch, districtList), [epoch, districtList]);
  const kpis = useMemo(() => computeEpochKpis(epoch, districtList), [epoch, districtList]);
  const districtsById = useMemo(() => new Map(districtList.map((d) => [d.id, d])), [districtList]);
  const zoneById = useMemo(() => new Map(zoneCategories(zoneList).map((z) => [z.key, z])), [zoneList]);

  const h3 = useH3Aggregation({
    epoch,
    metric,
    enabled: settings.h3Enabled,
    resolution: settings.h3Resolution,
  });
  const showHexes = settings.h3Enabled && h3.status === "ready";

  // DataContext re-maps selectedCell by cell_id when the epoch changes; guard the bounds anyway.
  const pinnedIndex =
    Number.isInteger(selectedCell) && selectedCell >= 0 && selectedCell < epoch.n ? selectedCell : null;

  /* ------------------------------ interaction ------------------------------------- */
  const handleHover = useCallback((info) => {
    if (!info.picked || !info.layer) {
      setHover(null);
      return;
    }
    if (info.layer.id === "thermal-cells" && info.index >= 0) {
      setHover({ kind: "cell", index: info.index, x: info.x, y: info.y });
    } else if (info.layer.id.startsWith("h3-hexes") && info.index >= 0) {
      // Store the index, not the object: hexes are re-aggregated when the layer changes
      // and the tooltip must show the current metric for the hexagon under the pointer.
      setHover({ kind: "hex", index: info.index, x: info.x, y: info.y });
    } else {
      setHover(null);
    }
  }, []);

  // Read through a ref so the click handler (a layer prop) stays stable across resizes.
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const handleCellClick = useCallback(
    (info) => {
      if (info.index < 0) return;
      setSelectedCell(info.index);
      // On phones the pinned-cell panel needs the space the controls drawer occupies.
      if (compactRef.current) setControlsOpen(false);
    },
    [setSelectedCell],
  );

  /** Clicking a hexagon zooms into it so the underlying cells become inspectable. */
  const handleHexClick = useCallback((info) => {
    if (!info.object?.hex) return;
    const [latitude, longitude] = cellToLatLng(info.object.hex);
    setViewState((vs) => ({
      ...vs,
      longitude,
      latitude,
      zoom: Math.max(vs.zoom + 1.5, 9.5),
      transitionDuration: 900,
      transitionInterpolator: new FlyToInterpolator(),
    }));
  }, []);

  const resetView = useCallback(() => {
    setFlyTarget("");
    setViewState({
      ...homeView,
      pitch: settings.is3D ? PITCH_3D : 0,
      bearing: settings.is3D ? INITIAL_BEARING : 0,
      transitionDuration: 1100,
      transitionInterpolator: new FlyToInterpolator(),
    });
  }, [homeView, settings.is3D]);

  const toggle3D = useCallback(() => {
    const next = !settings.is3D;
    updateSettings({ is3D: next });
    setViewState((vs) => ({
      ...vs,
      pitch: next ? PITCH_3D : 0,
      bearing: next ? (vs.bearing === 0 ? INITIAL_BEARING : vs.bearing) : 0,
      transitionDuration: 700,
      transitionInterpolator: new LinearInterpolator(["pitch", "bearing"]),
    }));
  }, [settings.is3D, updateSettings]);

  const flyToDistrict = useCallback(
    (idText) => {
      setFlyTarget(idText);
      const target = districtSummaries.find((d) => String(d.id) === idText);
      if (!target) return;
      const [minLon, minLat, maxLon, maxLat] = target.bbox;
      let camera;
      try {
        camera = new WebMercatorViewport({ width: bounds.width, height: bounds.height }).fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: Math.min(80, Math.floor(Math.min(bounds.width, bounds.height) / 5)), maxZoom: 11.5 },
        );
      } catch (_error) {
        // Degenerate bounds (single-cell district, zero-size container): centre on it instead.
        camera = { longitude: target.lon, latitude: target.lat, zoom: 10 };
      }
      setViewState((vs) => ({
        ...vs,
        longitude: camera.longitude,
        latitude: camera.latitude,
        zoom: camera.zoom,
        transitionDuration: "auto",
        transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }),
      }));
    },
    [districtSummaries, bounds.width, bounds.height],
  );

  /** Keyboard / screen-reader path to a cell: pin it, fly to it and announce it. */
  const [announcement, setAnnouncement] = useState("");
  const inspectCell = useCallback(
    (mode) => {
      const district = flyTarget === "" ? null : Number(flyTarget);
      const index = pickCell(epoch, { mode, district, featureNames });
      const label = PICK_MODES.find((m) => m.id === mode)?.label ?? mode;
      const scope = district === null ? "the NCR" : districtsById.get(district)?.name ?? `district ${district}`;
      if (index === null) {
        setAnnouncement(`No cell with data in ${scope}.`);
        return;
      }
      setSelectedCell(index);
      if (compactRef.current) setControlsOpen(false);
      setViewState((vs) => ({
        ...vs,
        longitude: epoch.lon[index],
        latitude: epoch.lat[index],
        zoom: Math.max(vs.zoom, 10),
        transitionDuration: 800,
        transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }),
      }));
      const obs = epoch.lst_obs[index];
      setAnnouncement(
        `Pinned the ${label.toLowerCase()} cell in ${scope}${Number.isFinite(obs) ? `: observed LST ${obs.toFixed(1)} °C` : ""}. Details are in the pinned cell panel.`,
      );
    },
    [epoch, flyTarget, featureNames, districtsById, setSelectedCell],
  );

  const onViewStateChange = useCallback(({ viewState: next }) => setViewState(next), []);
  const closePinned = useCallback(() => setSelectedCell(null), [setSelectedCell]);
  const openThresholds = useCallback(() => setView("thresholds"), [setView]);
  const clearHover = useCallback(() => setHover(null), []);
  const onBasemapFailure = useCallback((error) => {
    setBasemapError(error instanceof Error ? error.message : "Basemap unavailable");
  }, []);
  const onBasemapReady = useCallback(() => setBasemapError(null), []);

  // Hover indices refer to one epoch/layer mode; drop them when either changes.
  useEffect(() => setHover(null), [epoch, showHexes]);

  /* ------------------------------ deck.gl layers ---------------------------------- */
  const attributesKey = identityKey(attributes);
  const effectiveElevationScale = settings.elevationScale * zoomElevationFactor(viewState.zoom);
  const layers = useMemo(() => {
    const list = [];
    const common = {
      extruded: settings.is3D,
      elevationScale: effectiveElevationScale,
      opacity: settings.opacity,
    };
    if (showHexes) {
      list.push(
        createHexLayer({ ...common, hexes: h3.hexes, resolution: settings.h3Resolution, onClick: handleHexClick }),
      );
    } else {
      list.push(createCellLayer({ ...common, epoch, attributes, attributesKey, onClick: handleCellClick }));
    }
    if (settings.showBoundaries && districtsGeo) list.push(createBoundaryLayer(districtsGeo));
    if (settings.showLabels && districtSummaries.length) list.push(createLabelLayer(districtSummaries));
    if (pinnedIndex !== null && !showHexes) {
      list.push(
        createPinnedCellLayer({
          epoch,
          index: pinnedIndex,
          elevation: attributes.elevations[pinnedIndex],
          extruded: settings.is3D,
          elevationScale: effectiveElevationScale,
        }),
      );
    }
    return list;
  }, [
    settings,
    effectiveElevationScale,
    showHexes,
    h3.hexes,
    epoch,
    attributes,
    attributesKey,
    districtsGeo,
    districtSummaries,
    pinnedIndex,
    handleCellClick,
    handleHexClick,
  ]);

  const getCursor = useCallback(
    ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
    [],
  );

  // Scenario summary: top-right on wide maps, above the legend on phones.
  const scenarioChip =
    mapLayer === "scenario" ? (
      <ScenarioChip
        scenario={scenario}
        result={metric.available ? scenarioResult : null}
        manifest={manifest}
        districtsById={districtsById}
        zoneById={zoneById}
        onOpenThresholds={openThresholds}
        className={compact ? "w-[min(20rem,calc(100vw-2.5rem))]" : undefined}
      />
    ) : null;

  const cellArea = fmtKm2((epoch.cell_size_m / 1000) ** 2);
  const legendFootnote = showHexes
    ? `H3 res ${settings.h3Resolution} · ${metric.kind === "categorical" ? "mode" : "mean"} per hexagon`
    : `${cellArea} prisms · ${settings.is3D ? "height ∝ value" : "flat 2-D"}`;

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[32rem] w-full flex-1 overflow-hidden rounded-2xl border border-panel-border bg-bg"
      onMouseLeave={clearHover}
    >
      <DeckGL
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        controller={CONTROLLER}
        layers={layers}
        effects={MAP_EFFECTS}
        onHover={handleHover}
        eventRecognizerOptions={EVENT_RECOGNIZER_OPTIONS}
        getCursor={getCursor}
        pickingRadius={2}
        useDevicePixels
      >
        <Basemap
          mapStyle={settings.showLabels ? BASEMAP_STYLE_NOLABELS_URL : BASEMAP_STYLE_URL}
          onFailure={onBasemapFailure} onReady={onBasemapReady} />
      </DeckGL>

      {/* Subtle glowing grid overlay (decorative, never intercepts the pointer). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(34,211,238,0.9) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.9) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse at center, transparent 35%, black 100%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, transparent 35%, black 100%)",
        }}
      />

      {/* Top-left: controls. */}
      <div
        className="pointer-events-none absolute left-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] flex-col gap-2"
        style={!compact && legendStackH > 0 ? { maxHeight: `calc(100% - ${legendStackH + 36}px)` } : undefined}
      >
        <LayerControls
          layer={mapLayer}
          onLayerChange={setMapLayer}
          featureNames={featureNames}
          shapFeature={activeShapFeature}
          onShapFeatureChange={setShapFeature}
          labelOf={labelOf}
          settings={settings}
          onSettingsChange={updateSettings}
          h3Status={h3.status}
          districtOptions={districtSummaries}
          flyTarget={flyTarget}
          onFlyToDistrict={flyToDistrict}
          onResetView={resetView}
          onToggle3D={toggle3D}
          onInspectCell={inspectCell}
          open={controlsOpen}
          onOpenChange={setControlsOpen}
          // Phones: collapsed, the header shares the top edge with the epoch pill, so it is
          // narrower; expanded (drawer mode) the right-hand overlays are hidden.
          className={compact ? (controlsOpen ? "w-56" : "w-[12.5rem]") : undefined}
        />
      </div>

      {/* Top-right: epoch KPIs, scenario summary (desktop) and the pinned cell panel.
          Hidden while the phone controls drawer is open (it would cover the drawer). */}
      <div
        className={cn(
          "pointer-events-none absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] flex-col items-end gap-2",
          drawerMode && "hidden",
        )}
      >
        <KpiChips year={epoch.year} kpis={kpis} loading={epochLoading} compact={compact} />
        {!compact ? scenarioChip : null}
        <AnimatePresence>
          {pinnedIndex !== null ? (
            <CellDetailPanel
              key="pinned"
              epoch={epoch}
              index={pinnedIndex}
              manifest={manifest}
              featureNames={featureNames}
              metric={metric}
              districtsById={districtsById}
              zoneById={zoneById}
              onClose={closePinned}
              className={compact ? "w-[calc(100vw-2.5rem)] max-h-[70vh]" : undefined}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {/* Bottom-left: (phone: scenario summary) + legend + status notices. */}
      <div
        ref={setLegendStackEl}
        className={cn(
          "pointer-events-none absolute bottom-3 left-3 z-20 flex flex-col gap-2",
          (drawerMode || (compact && pinnedIndex !== null)) && "hidden",
        )}
      >
        {compact ? scenarioChip : null}
        <AnimatePresence>
          {basemapError ? (
            <motion.p
              key="basemap"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              role="status"
              className="pointer-events-auto flex max-w-xs items-center gap-2 rounded-lg border border-amber/30 bg-bg/80 px-2.5 py-1.5 text-[11px] text-ink-muted backdrop-blur"
            >
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden="true" />
              Basemap unavailable; data layers shown on the dark background.
            </motion.p>
          ) : null}
          {settings.h3Enabled && h3.status !== "ready" ? (
            <motion.p
              key="h3"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              role="status"
              className="flex max-w-xs items-center gap-2 rounded-lg border border-panel-border bg-bg/80 px-2.5 py-1.5 text-[11px] text-ink-muted backdrop-blur"
            >
              {h3.status === "error" ? (
                <>
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden="true" />
                  H3 aggregation failed ({h3.error?.message ?? "unknown error"}); showing cells.
                </>
              ) : (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan" aria-hidden="true" />
                  Indexing {epoch.n.toLocaleString("en-US")} cells to H3 res {settings.h3Resolution}…
                </>
              )}
            </motion.p>
          ) : null}
        </AnimatePresence>
        <div className="pointer-events-auto">
          <MapLegend metric={metric} shares={shares} footnote={legendFootnote} />
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {/* Pointer-following tooltip (never on top of the pinned cell's own panel logic). */}
      {hover?.kind === "cell" && hover.index < epoch.n ? (
        <CellTooltip
          epoch={epoch}
          index={hover.index}
          x={hover.x}
          y={hover.y}
          bounds={bounds}
          manifest={manifest}
          featureNames={featureNames}
          metric={metric}
          districtsById={districtsById}
          zoneById={zoneById}
        />
      ) : null}
      {hover?.kind === "hex" && showHexes && h3.hexes[hover.index] ? (
        <HexTooltip
          hex={h3.hexes[hover.index]}
          x={hover.x}
          y={hover.y}
          bounds={bounds}
          metric={metric}
          resolution={settings.h3Resolution}
        />
      ) : null}
    </div>
  );
}

/**
 * View entry point (no props). Guards the loading / empty / error states that the App
 * shell may not have caught, then mounts the twin once an epoch is available.
 */
export default function MapContainer() {
  const data = useData();
  const { status, error, manifest, epoch, epochLoading } = data;

  if (status === "error") {
    return <MapPlaceholder title="Could not load the data bundle" detail={error?.message ?? String(error ?? "")} />;
  }
  if (status === "empty") {
    return (
      <MapPlaceholder
        title="No data bundle found"
        detail="Run the Kaggle notebook and copy outputs/web/* into dashboard/public/data/."
      />
    );
  }
  if (status !== "ready" || !manifest) {
    return <MapPlaceholder title="Loading the thermal digital twin…" busy />;
  }
  if (!epoch) {
    return (
      <MapPlaceholder
        title={epochLoading ? "Loading epoch…" : "Epoch data unavailable"}
        detail={epochLoading ? "Streaming ~55k cells with their SHAP decomposition." : "Select another epoch."}
        busy={epochLoading}
      />
    );
  }
  return <TwinMap data={data} />;
}
