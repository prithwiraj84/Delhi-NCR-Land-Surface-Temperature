/**
 * MapEngine (UI_SPEC §6.5): owns what the persistent deck.gl stage draws.
 *
 * React boundary — the rule is "React never re-renders on scrub":
 *   - the engine subscribes to timeStore / viewStore / selectionStore / BundleStore with
 *     `subscribe` + `getState`, and redraws in ONE requestAnimationFrame loop that only runs while
 *     something changed or a choreography is animating;
 *   - it pushes layers with `deck.setProps({layers})` on the instance behind the DeckGL ref; when
 *     ThermalStage re-renders for other reasons it passes `engine.getLayers()` / `getViewState()`,
 *     so React and the engine never disagree;
 *   - React-visible state (legend, availability, path, perf, hover target) lives in `engineStore`
 *     and changes on content changes only.
 *
 * Paths: GPU (ThermalSlotsExtension: two value slots + uniforms, rebound on bracket change) or CPU
 * (`colorize.js` per frame, throttled to 30 Hz while dragging). CPU is forced by `?shader=off`,
 * a shader/layer error, or perf tier 3; categorical layers (driver, zones, AOA) and the compare
 * instances always use the CPU colour path.
 *
 * Choreographies (one mechanism, `mixFrame` / the `thermal` uniforms):
 *   time tween      value mix of the bracket frames (shape fade, mix = bracket.mix)
 *   Day ↔ Night     shape sweep east → west, 700 ms (150 ms fade Reduced, jump Off) + lighting blend
 *   content change  shape fade 400 ms (layer, variable, SSP, quantile); categorical 220 ms
 *   what-if ripple  shape radial from the affected cells' centroid, 800 ms
 *   height morph    heightMode change, 550 ms
 *   develop         grid ↔ 250 m raster: prisms sink 300 ms, raster fades in 400 ms
 */

import { FlyToInterpolator, LinearInterpolator, WebMercatorViewport } from "@deck.gl/core";
import { motionMatrix } from "../design/motion.js";
import { getMotionLevel } from "../design/useMotionLevel.js";
import { buildCellLocator } from "../data/cells.js";
import { rasterKey, rasterResourceKey, rasterValueAt } from "../data/rasters.js";
import { bracketAt, clampYear, frameAt, isExactBracket } from "../data/timeline.js";
import { getUrlCamera, onUrlCamera, reportCamera } from "../state/urlSync.js";
import { announce } from "../shell/announcer.js";
import { colorizeCategorical, colorizeSlots, HEIGHT_CAP_C, HEIGHT_MODE_CODES, heightChannel } from "./colorize.js";
import { engineStore as defaultEngineStore } from "./engineStore.js";
import ScreenSplitExtension from "./extensions/ScreenSplitExtension.js";
import ThermalSlotsExtension from "./extensions/ThermalSlotsExtension.js";
import { contentKey, createFrameSource } from "./frameData.js";
import { createRasterTexture } from "./layers/ThermalRasterLayer.js";
import ThermalRasterLayer from "./layers/ThermalRasterLayer.js";
import { createThermalColumns, FLAT_MATERIAL, MATERIAL } from "./layers/ThermalColumnLayer.js";
import { createLensLayers, lensMaskProps, lensRing } from "./layers/lens.js";
import { createBoundaryLayer, createLabelLayer, createReticleLayers, districtLabelData } from "./layers/overlays.js";
import { createSwathLayers } from "./layers/swath.js";
import { buildHexIndex, createH3Layer, h3ResolutionFor, hexMeans, hexModes, loadH3 } from "./layers/h3.js";
import { blendPresets, createStageLighting } from "./lighting.js";
import { thermalAtlas } from "./lut.js";
import { finiteMean, lonNormOf, maxDistance, mixValue, mixWeights, planarCoords, shapeCode, SHAPES, SWEEP_FEATHER, RADIAL_FEATHER } from "./mixFrame.js";
import { createPerfGovernor, tierEffects } from "./perfGovernor.js";
import { SLOT_NODATA } from "./shaders/thermal.glsl.js";

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

export const HOME_ZOOM = 7.7;
export const HOME_PITCH = 40;
export const HOME_BEARING = -12;
const FALLBACK_CENTER = [77.2, 28.6];
export const RASTER_AUTO_ZOOM = 9.5;
export const HOVER_INTERVAL_MS = 33;
export const CPU_SCRUB_INTERVAL_MS = 33;
/** Idle vsync probe (perf governor): rAF intervals measured while nothing renders. */
const VSYNC_PROBE_FRAMES = 24;
const VSYNC_PROBE_EVERY_MS = 30000;
const CAMERA_REPORT_MS = 400;
const BOOT_SWATH_MS = 2400;
const SWATH_SESSION_KEY = "ncr-thermal-ops:swath";

/**
 * mjolnir.js recognises a click only if pointerdown → pointerup takes < 250 ms of processed time;
 * the GPU picking pass over ~55k prisms can block the main thread for several hundred ms on
 * integrated/software GPUs, silently dropping "pin this cell" (v1 fix, reproduced under
 * SwiftShader at 516 ms). A 700 ms window keeps pinning reliable; the 9 px movement threshold
 * still separates clicks from drags.
 */
export const EVENT_RECOGNIZER_OPTIONS = Object.freeze({ click: Object.freeze({ time: 700 }) });
export const CONTROLLER = Object.freeze({ dragRotate: true, touchRotate: true, keyboard: true, inertia: 300 });

/** v1 relief damping: beyond the home zoom extrusion shrinks by 2^(−0.85·Δzoom) (0.1-zoom steps). */
export function zoomElevationFactor(zoom, home = HOME_ZOOM) {
  const dz = Math.round((zoom - home) * 10) / 10;
  return dz > 0 ? Math.max(2 ** (-0.85 * dz), 0.03) : 1;
}

const cubicInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sineInOut = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const raf = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16));
const cancelRaf = (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));

/** Float32 °C (NaN = nodata) → GPU slot buffer with the sentinel (cached per source array). */
const gpuValueCache = new WeakMap();
function gpuSlot(values) {
  let g = gpuValueCache.get(values);
  if (!g) {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 1) out[i] = Number.isNaN(values[i]) ? SLOT_NODATA : values[i];
    g = { value: out, size: 1 };
    gpuValueCache.set(values, g);
  }
  return g;
}

function parseFlags(search) {
  try {
    const q = new URLSearchParams(search ?? "");
    return { shaderOff: q.get("shader") === "off", perfHud: q.get("perf") === "1" };
  } catch (_error) {
    return { shaderOff: false, perfHud: false };
  }
}

// ---------------------------------------------------------------------------------------
// MapEngine
// ---------------------------------------------------------------------------------------

export class MapEngine {
  /**
   * @param {object} deps
   * @param {object} deps.bundle    vanilla BundleStore (E2)
   * @param {object} deps.time      timeStore hook (getState/subscribe)
   * @param {object} deps.view      viewStore hook
   * @param {object} deps.selection selectionStore hook
   * @param {object} [deps.store]   engine status store
   * @param {string} [deps.search]  location.search (flags `?shader=off`, `?perf=1`)
   * @param {Window} [deps.win]
   */
  constructor({ bundle, time, view, selection, store = defaultEngineStore, search = typeof location !== "undefined" ? location.search : "", win = typeof window !== "undefined" ? window : null }) {
    this.bundle = bundle;
    this.time = time;
    this.view = view;
    this.selection = selection;
    this.store = store;
    this.win = win;
    this.flags = parseFlags(search);
    this.deck = null;
    this.device = null;
    this.lut = null;
    this.gpuFailed = false;
    this.active = true;
    this.dimmed = false;
    this.mobile = false;
    this.scenario = null;
    this.layers = [];
    this.lighting = createStageLighting();
    this.effects = this.lighting.effects;
    this.frames = createFrameSource({ bundle, onUpdate: () => this.invalidate() });
    this.viewState = this._initialViewState();
    this.cellsRef = null;
    this.geo = null;
    this.current = null;
    this.transition = null;
    this.height = { mode: null, from: 0, start: 0, blend: 1 };
    this.develop = { value: 0, last: 0 };
    this.rasterTextures = new Map();
    this.cpuBuffers = { k: 0, colors: [null, null], elevations: [null, null], values: null };
    // Analyst H3 aggregation: lazily loaded modules, cell -> hexagon index, per-hexagon buffers.
    this.h3 = { status: "idle", mod: null, error: null, index: null, colors: null, elevations: null, means: null, codes: null, version: 0, key: null };
    this.columnData = null;
    this.columnKey = null;
    this.compareCache = { key: null, left: null, right: null };
    this.hoverInfo = null;
    this.hoverTimer = null;
    this.lastHoverAt = 0;
    this.pointer = null;
    this.lastCpuAt = 0;
    this.lastRenderAt = 0;
    this.animating = false;
    this.rafId = 0;
    this.cameraTimer = null;
    this.probeTimer = 0;
    this.probeClaimed = false;
    this.pendingExport = false;
    this.lastHeavy = 0;
    this.swath = null;
    this.prevPerfTier = view.getState().perfTier ?? 0;
    this.governor = createPerfGovernor({
      initialTier: view.getState().perfTier ?? 0,
      onChange: (tier) => {
        this.prevPerfTier = this.view.getState().perfTier ?? 0;
        this._autoTier = true;
        this.view.getState().setPerfTier?.(tier);
      },
    });
    this._autoTier = false;
    this.fps = { frames: 0, since: now(), value: null };

    const inv = () => this.invalidate();
    this.unsubs = [
      time.subscribe(inv),
      view.subscribe((s, prev) => {
        if (prev && s.perfTier !== prev.perfTier) {
          if (!this._autoTier) this.governor.setUserTier(s.perfTier);
          else this.governor.sync(s.perfTier);
          this._autoTier = false;
        }
        inv();
      }),
      selection.subscribe(inv),
      bundle.subscribe((s, prev) => {
        if (!prev || s.generation !== prev.generation || s.status !== prev.status || s.resources !== prev.resources) inv();
      }),
      onUrlCamera(() => {
        const cam = getUrlCamera();
        if (cam) this.flyTo(cam);
      }),
    ];
    if (win) {
      this.onWinFly = (e) => {
        const detail = e?.detail ?? {};
        // A view (Mission Control) answered an `H` press itself and is flying to its cell.
        if (detail.source === "probe-hottest") this.probeClaimed = true;
        this._onFlyEvent(detail);
      };
      this.onWinProbe = (e) => this._onProbeEvent(e?.detail);
      this.onWinExport = () => this.exportPng();
      // PerfChip Undo: back to the previous tier with a 30 s hold; the user's floor is unchanged
      // (only an explicit Settings choice sets it). Marked handled so the chip does not also
      // write the store (which would read as a user choice).
      this.onWinUndo = (e) => {
        const detail = e?.detail && typeof e.detail === "object" ? e.detail : {};
        // Nothing automatic to undo: the current tier is the user's own Settings / palette choice
        // (tier == floor). Leave the event unhandled, so the chip writes the store and the
        // view subscription treats it as a new user choice (it lowers the floor).
        if (this.governor.tier <= this.governor.floor) return;
        const to = Number.isInteger(detail.to) ? detail.to : Math.max(0, (this.view.getState().perfTier ?? 0) - 1);
        detail.handled = true;
        this.governor.undo(to, now());
        if ((this.view.getState().perfTier ?? 0) !== this.governor.tier) {
          this._autoTier = true;
          this.view.getState().setPerfTier?.(this.governor.tier);
        }
        this.invalidate();
      };
      win.addEventListener("ncr:fly-to", this.onWinFly);
      win.addEventListener("ncr:probe-hottest", this.onWinProbe);
      win.addEventListener("ncr:export-png", this.onWinExport);
      win.addEventListener("ncr:perf-undo", this.onWinUndo);
    }
    this.store.patch({ status: "loading", path: this.flags.shaderOff ? "cpu" : "gpu", pathReason: this.flags.shaderOff ? "?shader=off" : null });
  }

  // -------------------------------------------------------------------------------------
  // Lifecycle and React wiring
  // -------------------------------------------------------------------------------------

  /** Attach the deck instance (from the DeckGL ref). */
  attach(deck) {
    if (this.deck === deck) return;
    this.deck = deck;
    this._gatePicking(deck);
    this.invalidate();
  }

  /**
   * Hover picking at ≤ 30 Hz: deck runs one hover picking pass per animation frame after a
   * pointermove (up to 60 Hz, each a full GPU picking render of ~55k prisms). The gate lets a
   * pending hover request through at most every HOVER_INTERVAL_MS; a deferred request stays queued
   * and is served on a later frame, so the last pointer position is always picked. Click picking
   * is separate and never delayed. No-op when the deck build has no `_pickAndCallback`.
   */
  _gatePicking(deck) {
    if (!deck || deck.__ncrPickGate || typeof deck._pickAndCallback !== "function") return;
    const original = deck._pickAndCallback;
    let last = -Infinity;
    deck._pickAndCallback = function gatedPickAndCallback(...args) {
      if (!this._pickRequest?.event) return original.apply(this, args);
      const t = now();
      if (t - last < HOVER_INTERVAL_MS) return undefined;
      last = t;
      this.__ncrHoverPicks = (this.__ncrHoverPicks ?? 0) + 1;
      return original.apply(this, args);
    };
    deck.__ncrPickGate = true;
  }

  /** The luma device became available (DeckGL `onDeviceInitialized`). */
  setDevice(device) {
    if (!device || this.device === device) return;
    this.disposeGpu();
    // Every cached deck layer / attribute buffer belongs to the old context (WebGL loss → Retry
    // builds a new device): reusing one would raise "does not belong to this context" and drop the
    // boundaries and labels. Rebuild them all on the new device.
    this._resetLayerCaches();
    this.device = device;
    try {
      const atlas = thermalAtlas();
      this.lut = device.createTexture({
        id: "thermal-lut-atlas",
        width: atlas.width,
        height: atlas.height,
        format: "rgba8unorm",
        data: atlas.data,
        mipLevels: 1,
        sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
      });
    } catch (error) {
      console.warn("[engine] LUT texture creation failed; using the CPU path", error);
      this.gpuFailed = true;
      this.lut = null;
    }
    this.invalidate();
  }

  /**
   * Forget the current device before a new one is created (WebGL-lost Retry): textures are
   * released and every cached layer is rebuilt on the next device.
   */
  resetGpu() {
    this.disposeGpu();
    this._resetLayerCaches();
    this.device = null;
    if (this.deck) this.deck = null;
  }

  /** Drop every cached layer instance and per-layer buffer (new GPU device). */
  _resetLayerCaches() {
    this._memo = {};
    this.layers = [];
    this.compareCache = { key: null, left: null, right: null, sides: {} };
    this.columnData = null;
    this.columnKey = null;
    this._columnMemo = null;
    this._auxKey = null;
    this.h3.key = null;
    this.h3.version += 1;
  }

  /** Release GPU textures (context lost / device change / unmount). */
  disposeGpu() {
    for (const { texture } of this.rasterTextures.values()) {
      try {
        texture.destroy();
      } catch (_error) {
        // already destroyed with the context
      }
    }
    this.rasterTextures.clear();
    try {
      this.lut?.destroy();
    } catch (_error) {
      // already destroyed with the context
    }
    this.lut = null;
  }

  /** Stage active (interactive + rendering) and dimmed (visible but paused) flags from AppShell. */
  setActive(active, { dimmed = false } = {}) {
    this.active = Boolean(active);
    this.dimmed = Boolean(dimmed);
    if (this.active && !this.dimmed) this.invalidate();
  }

  /** Context facts from React: mobile layout, current what-if result. */
  setExternal({ mobile, scenario } = {}) {
    let changed = false;
    if (mobile !== undefined && mobile !== this.mobile) {
      this.mobile = Boolean(mobile);
      changed = true;
    }
    if (scenario !== undefined && scenario !== this.scenario) {
      this.scenario = scenario;
      changed = true;
    }
    if (changed) this.invalidate();
  }

  destroy() {
    cancelRaf(this.rafId);
    this.rafId = 0;
    if (this._vsyncRaf) cancelRaf(this._vsyncRaf);
    this._vsyncRaf = 0;
    clearTimeout(this.hoverTimer);
    clearTimeout(this.cameraTimer);
    clearTimeout(this.probeTimer);
    this.unsubs.forEach((u) => u?.());
    this.unsubs = [];
    if (this.win) {
      this.win.removeEventListener("ncr:fly-to", this.onWinFly);
      this.win.removeEventListener("ncr:probe-hottest", this.onWinProbe);
      this.win.removeEventListener("ncr:export-png", this.onWinExport);
      this.win.removeEventListener("ncr:perf-undo", this.onWinUndo);
    }
    this.disposeGpu();
    this.frames.clear();
    this.deck = null;
    this.device = null;
  }

  getLayers() {
    return this.layers;
  }

  getViewState() {
    return this.viewState;
  }

  /** Schedule one engine frame (coalesced). */
  invalidate() {
    if (this.rafId || !this.active || this.dimmed) return;
    this.rafId = raf((t) => this._tick(t));
  }

  // -------------------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------------------

  _home() {
    const m = this.bundle.getState().manifest;
    const c = m?.study_area?.center;
    const [longitude, latitude] = Array.isArray(c) && c.length === 2 ? c.map(Number) : FALLBACK_CENTER;
    const flat = this.mobile || getMotionLevel() !== "full";
    return { longitude, latitude, zoom: HOME_ZOOM, pitch: flat ? 0 : HOME_PITCH, bearing: flat ? 0 : HOME_BEARING };
  }

  _initialViewState() {
    const cam = getUrlCamera();
    const base = { minZoom: 5, maxZoom: 14, maxPitch: 70 };
    if (cam && Number.isFinite(cam.longitude) && Number.isFinite(cam.latitude)) return { ...base, ...cam };
    this._cameraFromHome = true;
    return { ...base, ...this._home() };
  }

  /** DeckGL `onViewStateChange` (controlled view state owned by the engine). */
  handleViewStateChange = ({ viewState, interactionState }) => {
    const prevZoom = this.viewState?.zoom;
    this.viewState = viewState;
    this._cameraFromHome = false;
    this.deck?.setProps({ viewState });
    const zq = Math.round((viewState.zoom ?? 0) * 10);
    if (Math.round((prevZoom ?? 0) * 10) !== zq) this.invalidate();
    if (this.lensOn && this.pointer) this.invalidate();
    clearTimeout(this.cameraTimer);
    // Programmatic flights (fly-to, probe, briefing) only ever report `inTransition: true` frames —
    // deck.gl sends no closing view-state event — so they must still schedule the debounced
    // report (each frame re-arms the timer; it fires CAMERA_REPORT_MS after the last one).
    // Otherwise the camera store, URL `cam=` and the Render "auto" chip keep the pre-flight zoom.
    const busy = interactionState && (interactionState.isDragging || interactionState.isZooming || interactionState.isPanning || interactionState.isRotating);
    if (!busy) {
      this.cameraTimer = setTimeout(() => {
        reportCamera(this.viewState);
        this.store.patch({ camera: { zoom: Math.round(this.viewState.zoom * 10) / 10, pitch: Math.round(this.viewState.pitch ?? 0), bearing: Math.round(this.viewState.bearing ?? 0) } });
      }, CAMERA_REPORT_MS);
    }
    return viewState;
  };

  _setViewState(next) {
    this.viewState = { ...this.viewState, ...next };
    this.deck?.setProps({ viewState: this.viewState });
    this.invalidate();
  }

  /** Fly to a camera ({longitude, latitude, zoom?, pitch?, bearing?}) honouring the motion level. */
  flyTo(target) {
    if (!target || !Number.isFinite(target.longitude) || !Number.isFinite(target.latitude)) return;
    const mm = motionMatrix(getMotionLevel());
    const transition =
      mm.flight > 0
        ? mm.flightKind === "fly"
          ? { transitionDuration: mm.flight, transitionInterpolator: new FlyToInterpolator({ curve: 1.4 }) }
          : { transitionDuration: mm.flight, transitionInterpolator: new LinearInterpolator(["longitude", "latitude", "zoom", "pitch", "bearing"]) }
        : { transitionDuration: 0 };
    this._setViewState({ ...target, ...transition });
  }

  /** Back to the manifest home camera. */
  home() {
    this.flyTo(this._home());
  }

  /** Shift the visual centre when the inspector opens ({left, right, top, bottom} px). */
  setViewPadding(padding) {
    this._setViewState({ padding: padding ? { left: 0, right: 0, top: 0, bottom: 0, ...padding } : undefined });
  }

  _canvasSize() {
    const vp = this.deck?.getViewports?.()?.[0];
    return { width: vp?.width || this.win?.innerWidth || 1024, height: vp?.height || this.win?.innerHeight || 768 };
  }

  /**
   * `ncr:fly-to` payloads (shell palette, Briefing, inspector): `{home: true}`, `{cellIndex}`,
   * `{districtId}`, `{bounds: [W, S, E, N]}` or an explicit camera `{longitude, latitude, zoom?, …}`.
   */
  _onFlyEvent({ home, districtId, cellIndex, bounds, longitude, latitude, zoom, pitch, bearing }) {
    if (home) {
      this.home();
      return;
    }
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
      this.flyTo({ longitude, latitude, ...(Number.isFinite(zoom) ? { zoom } : {}), ...(Number.isFinite(pitch) ? { pitch } : {}), ...(Number.isFinite(bearing) ? { bearing } : {}) });
      return;
    }
    const g = this.geo;
    if (Number.isInteger(cellIndex) && g && cellIndex >= 0 && cellIndex < g.cells.n) {
      this.flyTo({ longitude: g.cells.lon[cellIndex], latitude: g.cells.lat[cellIndex], zoom: Math.max(this.viewState.zoom, 10) });
      return;
    }
    let box = Array.isArray(bounds) && bounds.length === 4 ? bounds : null;
    if (!box && Number.isInteger(districtId) && g) box = g.labels.find((d) => d.id === districtId)?.bbox ?? null;
    if (!box) return;
    const { width, height } = this._canvasSize();
    try {
      const cam = new WebMercatorViewport({ width, height }).fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        { padding: Math.min(80, Math.floor(Math.min(width, height) / 5)), maxZoom: 11.5 },
      );
      this.flyTo({ longitude: cam.longitude, latitude: cam.latitude, zoom: cam.zoom });
    } catch (_error) {
      this.flyTo({ longitude: (box[0] + box[2]) / 2, latitude: (box[1] + box[3]) / 2, zoom: 10 });
    }
  }

  // -------------------------------------------------------------------------------------
  // Geometry of the current bundle
  // -------------------------------------------------------------------------------------

  _geometry() {
    const bs = this.bundle.getState();
    const cells = bs.resources.cells?.status === "ready" ? bs.resources.cells.data : null;
    if (!cells) return null;
    if (this.cellsRef === cells && this.geo) return this.geo;
    // New bundle (or first load): reset every cache tied to the old cell order.
    this.frames.clear();
    this._modePrefetched = false;
    this._memo = {};
    this.current = null;
    this.transition = null;
    this.columnData = null;
    this.columnKey = null;
    this._columnMemo = null;
    this.compareCache = { key: null, left: null, right: null };
    this.cpuBuffers = { k: 0, colors: [null, null], elevations: [null, null], values: null };
    this.h3.index = null;
    this._lastMix = null;
    this.h3.key = null;
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (let i = 0; i < cells.n; i += 1) {
      const lo = cells.lon[i];
      const la = cells.lat[i];
      if (lo < west) west = lo;
      if (lo > east) east = lo;
      if (la < south) south = la;
      if (la > north) north = la;
    }
    const bounds = [west, south, east, north];
    const planar = planarCoords(cells.lon, cells.lat, bounds);
    const lat0 = ((south + north) / 2) * (Math.PI / 180);
    this.cellsRef = cells;
    this.geo = {
      cells,
      bounds,
      lonNorm: lonNormOf(cells.lon, [west, east]),
      planar,
      planarParams: [west, south, Math.cos(lat0), north - south || 1],
      labels: districtLabelData(cells, bs.manifest?.districts ?? []),
      cellSizeM: Number(cells.grid?.res) || Number(bs.manifest?.study_area?.grid_res_m) || 1000,
      locator: null,
    };
    if (this._cameraFromHome) this.viewState = { ...this.viewState, ...this._home() };
    if (!this.swath && getMotionLevel() === "full" && !this._swathSeen()) this.swath = { start: null };
    return this.geo;
  }

  _swathSeen() {
    try {
      if (this.win?.sessionStorage?.getItem(SWATH_SESSION_KEY)) return true;
      this.win?.sessionStorage?.setItem(SWATH_SESSION_KEY, "1");
      return false;
    } catch (_error) {
      return true;
    }
  }

  _locator() {
    if (!this.geo) return null;
    if (!this.geo.locator) this.geo.locator = buildCellLocator(this.geo.cells);
    return this.geo.locator;
  }

  // -------------------------------------------------------------------------------------
  // Content description and target display
  // -------------------------------------------------------------------------------------

  _desc(t, v) {
    const mode = t.mode ?? "day";
    const cmp = t.compare;
    return {
      mode,
      layer: v.layer ?? "lst",
      variable: v.variable ?? "abs",
      q: v.quantile ?? "p50",
      ssp: t.ssp,
      shapFeature: v.layer === "shap" ? v.shapFeature : null,
      deltaRef: v.variable === "delta" ? (cmp?.kind === "y" && Number.isFinite(cmp.a) ? cmp.a : null) : null,
      scenario: v.layer === "whatif" ? this.scenario : null,
      // A primitive per what-if RUN (the result's scenarioKey is the scenario object, compared by
      // identity in the simulator; joined into a content key it would read "[object Object]" for
      // every run and the map would keep the first result).
      scenarioKey: v.layer === "whatif" ? (this.scenario ? String(this.scenario.runKey ?? this._seqFor(this.scenario)) : "none") : null,
      domainMode: v.domainMode ?? "fixed",
      // false = projected frames without the VSUP fog (legend switch); part of the content key.
      fog: v.uncertaintyFog !== false,
    };
  }

  /** Run number of a what-if result without `runKey` (fallback: one integer per result object). */
  _seqFor(result) {
    if (!this._resultSeq) this._resultSeq = { map: new WeakMap(), next: 0 };
    const s = this._resultSeq;
    if (!s.map.has(result)) {
      s.next += 1;
      s.map.set(result, `seq${s.next}`);
    }
    return s.map.get(result);
  }

  /**
   * Resolve the display of a description at a (fractional) time.
   * @returns {{status, reason?, display?}} display: {ck, desc, kind, A, B, mix, channel, bracket} or categorical {frame}
   */
  _target(desc, scrubT) {
    const tl = this.bundle.getState().timeline;
    const b = bracketAt(tl.years, clampYear(tl, scrubT));
    const ck = contentKey(desc);
    const categorical = desc.layer === "driver" || desc.layer === "zones" || desc.layer === "aoa";
    if (categorical || desc.layer === "whatif") {
      const year = isExactBracket(b) ? b.yA : b.mix > 0.5 ? b.yB : b.yA;
      const r = this.frames.frame(desc, year);
      if (r.status !== "ready") return r;
      if (r.frame.kind === "categorical") return { status: "ready", display: { ck, desc, kind: "categorical", frame: r.frame, year, bracket: b } };
      const channel = this.frames.channel(desc, r.frame);
      return { status: "ready", display: { ck, desc, kind: "continuous", A: r.frame, B: r.frame, mix: 0, channel, bracket: b, held: !isExactBracket(b) } };
    }
    const exact = isExactBracket(b);
    const rA = this.frames.frame(desc, b.yA);
    const rB = exact ? rA : this.frames.frame(desc, b.yB);
    if (rA.status === "loading" || rB.status === "loading") return { status: "loading" };
    if (rA.status === "ready" && rB.status === "ready") {
      return { status: "ready", display: { ck, desc, kind: "continuous", A: rA.frame, B: rB.frame, mix: exact ? 0 : b.mix, channel: this.frames.channel(desc, rA.frame), bracket: b } };
    }
    // One side missing (e.g. XAI exists only for one bracket frame): hold the available frame
    // instead of inventing an interpolation; the reason is surfaced.
    const ready = rA.status === "ready" ? rA : rB.status === "ready" ? rB : null;
    const missing = rA.status !== "ready" ? rA : rB;
    if (ready) return { status: "ready", reason: missing.reason, display: { ck, desc, kind: "continuous", A: ready.frame, B: ready.frame, mix: 0, channel: this.frames.channel(desc, ready.frame), bracket: b, held: true } };
    return { status: rA.status === "error" ? "error" : "unavailable", reason: rA.reason ?? rB.reason ?? "no data for this frame" };
  }

  /** CPU-mixed values of a continuous display (cached per display + mix). */
  _mixedValues(display) {
    if (display.kind !== "continuous") return null;
    const m = display.mix;
    if (display._mixCache && display._mixCache.m === m) return display._mixCache.values;
    // `_target` creates a new display object per frame: also reuse the last mix of the same two
    // frames (a paused interpolated year must not re-mix 55k cells and allocate every frame). The
    // array is never mutated afterwards, so transition snapshots may keep referencing it.
    const last = this._lastMix;
    if (last && last.a === display.A.values && last.b === display.B.values && last.m === m) {
      display._mixCache = { m, values: last.values };
      return last.values;
    }
    let values;
    if (display.A === display.B || m <= 0) values = display.A.values;
    else if (m >= 1) values = display.B.values;
    else {
      const a = display.A.values;
      const bv = display.B.values;
      values = new Float32Array(a.length);
      for (let i = 0; i < a.length; i += 1) values[i] = mixValue(a[i], bv[i], m);
    }
    display._mixCache = { m, values };
    this._lastMix = { a: display.A.values, b: display.B.values, m, values };
    return values;
  }

  /** Height reference of a display: the mixed NCR mean of the shown values (D3). */
  _heightRef(display) {
    if (display.kind !== "continuous") return 0;
    const a = Number.isFinite(display.A.mean) ? display.A.mean : finiteMean(display.A.values);
    const b = Number.isFinite(display.B.mean) ? display.B.mean : finiteMean(display.B.values);
    return a + (b - a) * display.mix;
  }

  /** Snapshot of a display for a transition source: continuous values or RGBA colours. */
  _snapshot(display) {
    if (!display) return null;
    if (display.kind === "categorical") {
      const colors = new Uint8Array(display.frame.codes.length * 4);
      colorizeCategorical({ codes: display.frame.codes, palette: display.frame.palette, outColors: colors });
      return { kind: "categorical", colors };
    }
    const side = display.mix >= 0.5 ? display.B : display.A;
    return { kind: "continuous", values: this._mixedValues(display), channel: display.channel, ref: this._heightRef(display), vsup: side.vsup, aoa: side.aoa, mode: display.desc.mode };
  }

  /** Choose the choreography for a content change. */
  _transitionFor(prev, next) {
    const level = getMotionLevel();
    const mm = motionMatrix(level);
    const modeOnly = prev.desc.mode !== next.desc.mode && prev.desc.layer === next.desc.layer && prev.desc.variable === next.desc.variable;
    const categorical = prev.kind === "categorical" || next.kind === "categorical";
    if (modeOnly && (prev.desc.mode === "day" || prev.desc.mode === "night") && (next.desc.mode === "day" || next.desc.mode === "night")) {
      if (mm.terminator <= 0) return null;
      return { shape: mm.terminatorKind === "sweep" ? SHAPES.sweep : SHAPES.fade, duration: mm.terminator, ease: sineInOut, lighting: true };
    }
    if (next.desc.layer === "whatif" && next.kind === "continuous" && prev.desc.layer !== "whatif") {
      if (mm.rippleMs <= 0) return null;
      return { shape: mm.ripple === "radial" ? SHAPES.radial : SHAPES.fade, duration: mm.rippleMs, ease: cubicInOut };
    }
    if (level === "off") return null;
    return { shape: SHAPES.fade, duration: categorical ? 220 : level === "reduced" ? 150 : 400, ease: cubicInOut };
  }

  /** Centroid (planar) of the cells a what-if changed, and the radius reaching every cell. */
  _rippleCentre(display) {
    const g = this.geo;
    const v = display.A.values;
    let sx = 0;
    let sy = 0;
    let k = 0;
    for (let i = 0; i < v.length; i += 1) {
      if (Number.isFinite(v[i]) && v[i] !== 0) {
        sx += g.planar.x[i];
        sy += g.planar.y[i];
        k += 1;
      }
    }
    const cx = k ? sx / k : 0.5;
    const cy = k ? sy / k : 0.5;
    return { cx, cy, radius: Math.max(1e-3, maxDistance(g.planar.x, g.planar.y, cx, cy)) };
  }

  // -------------------------------------------------------------------------------------
  // The frame loop
  // -------------------------------------------------------------------------------------

  _tick(t0) {
    this.rafId = 0;
    if (!this.deck || !this.active || this.dimmed) return;
    const tNow = now();
    let again = false;
    this._throttled = false;
    try {
      again = this._frame(tNow);
    } catch (error) {
      console.error("[engine] frame failed", error);
      this.store.patch({ status: "error", reason: error?.message ?? String(error) });
    }
    const workMs = now() - tNow;
    this._sampleFps(t0 ?? tNow);
    if (this._samplePerf(Number.isFinite(t0) ? t0 : tNow, workMs)) again = true;
    if (again) this.invalidate();
    else this._probeVsync();
  }

  /**
   * Idle vsync probe (UI_SPEC §6.6): once the loop goes idle, a short burst of empty rAF
   * callbacks measures the display refresh period for the perf governor, at most every 30 s.
   * The burst stops as soon as the engine schedules a frame again (those intervals would include
   * render work), so a GPU-bound map cannot teach the governor its slow interval as "vsync".
   */
  _probeVsync() {
    if (this._vsyncRaf || typeof requestAnimationFrame !== "function" || !this.active || this.dimmed) return;
    if (this.bundle.getState().status !== "ready") return; // boot: the engine is about to render
    const t = now();
    // A COMPLETED burst counts for 30 s; an aborted one (the engine rendered again) may retry at
    // the next idle, at most once a second.
    if (this._vsyncProbeAt !== undefined && t - this._vsyncProbeAt < VSYNC_PROBE_EVERY_MS) return;
    if (this._vsyncTryAt !== undefined && t - this._vsyncTryAt < 1000) return;
    this._vsyncTryAt = t;
    let last = null;
    let n = 0;
    const step = (ts) => {
      this._vsyncRaf = 0;
      if (!this.deck || !this.active || this.dimmed || this.rafId || this.animating) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (last !== null) this.governor.sampleVsync(ts - last);
      last = ts;
      n += 1;
      if (n <= VSYNC_PROBE_FRAMES) this._vsyncRaf = requestAnimationFrame(step);
      else this._vsyncProbeAt = now();
    };
    this._vsyncRaf = requestAnimationFrame(step);
  }

  /**
   * Perf governor sample (UI_SPEC §6.6): per-frame WORK = this engine frame + deck's CPU/GPU time
   * per frame (deck.metrics, when available), plus the rAF interval for the vsync estimate. Only
   * frames rendered while animating are sampled; a tick the engine skipped on purpose (30 Hz CPU
   * scrub throttle) is not a sample, and the interval that spans it is not reported.
   * @returns {boolean} true when the tier changed (redraw)
   */
  _samplePerf(t, workMs) {
    if (this._throttled) {
      this._intervalBroken = true;
      return false;
    }
    if (!this.animating) {
      this._lastWorkAt = 0;
      return false;
    }
    const m = this.deck?.metrics;
    const deckMs = (Number.isFinite(m?.cpuTimePerFrame) ? m.cpuTimePerFrame : 0) + (Number.isFinite(m?.gpuTimePerFrame) ? m.gpuTimePerFrame : 0);
    const interval = this._lastWorkAt && !this._intervalBroken ? t - this._lastWorkAt : null;
    this._lastWorkAt = t;
    this._intervalBroken = false;
    return Boolean(this.governor.sample(workMs + deckMs, t, interval));
  }

  _sampleFps(t) {
    const f = this.fps;
    f.frames += 1;
    if (t - f.since >= 1000) {
      f.value = Math.round((f.frames * 1000) / (t - f.since));
      f.frames = 0;
      f.since = t;
    }
  }

  /** Build and push the layers for this frame. Returns true while something is animating. */
  _frame(tNow) {
    const bs = this.bundle.getState();
    const g = this._geometry();
    if (bs.status !== "ready" || !bs.timeline || !g) {
      this.store.patch({ status: bs.status === "error" ? "error" : "loading", reason: bs.error?.message ?? null });
      return false;
    }
    const t = this.time.getState();
    const v = this.view.getState();
    const s = this.selection.getState();
    const level = getMotionLevel();
    const fx = tierEffects(v.perfTier ?? 0);
    const scrubT = Number.isFinite(t.scrubT) ? t.scrubT : bs.timeline.now;
    const desc = this._desc(t, v);
    const interacting = Boolean(t.dragging || t.playing);
    let animating = false;

    // ---- path ---------------------------------------------------------------------------
    const forceCpu = this.flags.shaderOff || this.gpuFailed || fx.forceCpu || !this.lut;
    const path = forceCpu ? "cpu" : "gpu";
    const pathReason = this.flags.shaderOff ? "?shader=off" : this.gpuFailed ? "shader unavailable on this device" : fx.forceCpu ? "performance tier 3" : !this.lut ? "GPU not ready" : null;

    // ---- target + transitions -----------------------------------------------------------
    const target = this._target(desc, scrubT);
    let status = "ready";
    let reason = target.reason ?? null;
    if (target.status === "ready") {
      const next = target.display;
      if (this.current && this.current.ck !== next.ck) {
        const choreo = this._transitionFor(this.current, next);
        this.transition = choreo ? { ...choreo, from: this._snapshot(this.transition ? this._transitionSnapshot() : this.current), start: tNow, fromMode: this.current.desc.mode, toMode: next.desc.mode } : null;
        if (this.transition?.shape === SHAPES.radial) this.transition.radial = this._rippleCentre(next);
      }
      this.current = next;
    } else if (target.status === "loading") {
      status = this.current ? "buffering" : "loading";
      reason = this.current ? `streaming ${desc.mode} ${Math.round(scrubT)}` : null;
      if (this.current && this.current.ck !== contentKey(desc)) {
        // Content changed but its data is still loading: keep the old picture (never blank).
      }
    } else {
      status = target.status;
      this.current = null;
      this.transition = null;
    }
    const display = this.current;

    // Transition progress.
    let tr = null;
    if (this.transition && display) {
      const p = Math.min(1, (tNow - this.transition.start) / this.transition.duration);
      if (p >= 1) this.transition = null;
      else {
        tr = { ...this.transition, p: this.transition.ease(p) };
        animating = true;
      }
    }

    // ---- height encoding (+ 550 ms morph) -------------------------------------------------
    const forceFlat = this.mobile || level !== "full" || fx.forceFlat2d;
    const wantHeight = forceFlat ? "flat" : v.heightMode ?? "anom";
    const hCode = HEIGHT_MODE_CODES[wantHeight] ?? 1;
    if (this.height.mode === null) this.height = { mode: hCode, from: hCode, start: tNow, blend: 1 };
    else if (this.height.mode !== hCode) {
      this.height = { mode: hCode, from: this.height.mode, start: tNow, blend: level === "full" ? 0 : 1 };
    }
    if (this.height.blend < 1) {
      this.height.blend = Math.min(1, (tNow - this.height.start) / 550);
      animating = animating || this.height.blend < 1;
    }
    const heightBlend = cubicInOut(this.height.blend);

    // ---- raster plan --------------------------------------------------------------------
    const raster = this._rasterPlan({ desc, t, v, fx, scrubT, display, interacting });
    const developTarget = raster.visible ? 1 : 0;
    const dev = this.develop;
    if (dev.value !== developTarget) {
      if (level === "off" || level === "reduced") dev.value = developTarget;
      else {
        // Clamped: the first frame after an idle gap must not jump the whole develop at once.
        const dt = Math.min(50, Math.max(0, tNow - (dev.last || tNow)));
        const rate = developTarget > dev.value ? dt / 400 : dt / 550;
        dev.value = developTarget > dev.value ? Math.min(1, dev.value + rate) : Math.max(0, dev.value - rate);
        animating = true;
      }
    }
    dev.last = tNow;

    // ---- lighting -----------------------------------------------------------------------
    const flatLight = fx.flatLighting;
    let preset = this.lighting.presetFor(desc.mode, flatLight);
    if (tr?.lighting && !flatLight) preset = blendPresets(this.lighting.presetFor(tr.fromMode), this.lighting.presetFor(tr.toMode), tr.p);
    this.lighting.apply(preset);

    // ---- CPU throttle while dragging ----------------------------------------------------
    // Compare always colours on the CPU (two instances), so the 30 Hz scrub throttle covers it too.
    const cpuNeeded = path === "cpu" || display?.kind === "categorical" || tr?.from?.kind === "categorical" || Boolean(t.compare?.kind);
    if (cpuNeeded && t.dragging && tNow - this.lastCpuAt < CPU_SCRUB_INTERVAL_MS && this.layers.length) {
      this._throttled = true; // a deliberate skip: not a perf sample (see _samplePerf)
      return true;
    }

    // ---- layers ---------------------------------------------------------------------------
    const zoomFactor = zoomElevationFactor(this.viewState.zoom ?? HOME_ZOOM);
    const extruded = !(hCode === 0 && this.height.from === 0 && heightBlend >= 1);
    const sink = 1 - Math.min(1, dev.value / 0.75);
    const elevationScale = zoomFactor * Math.max(0, sink);
    const pickable = !interacting;
    const opacity = v.analyst?.opacity ?? 0.92;
    const lensOn = Boolean(v.lens) && fx.lensAllowed && !this.mobile && !raster.visible;
    this.lensOn = lensOn;
    // The columns are masked out under the ring only while the ring is actually drawn AND there is
    // a 250 m raster to show inside it: with no pointer the mask layer does not exist (deck warns
    // "Could not find a mask layer" and luma "Binding mask_texture not found"), and in a v1 bundle
    // (no rasters) masking would just punch an empty hole — the ring + reason label still show.
    const lensMask = lensOn && Boolean(this.pointer) && Boolean(raster.lensLayer);
    const compareOn = Boolean(t.compare?.kind);
    const layers = [];
    this._memoUsed = new Set();

    if (raster.layer && dev.value > 0) layers.push(raster.layer(dev.value, null));

    let columnsDrawn = false;
    // Analyst ▸ H3 hexagons replaces the prisms with their hexagon aggregate (same LUT/domain);
    // until h3-js has loaded (or if it cannot) the prisms stay, with the reason in the status chip.
    if (v.analyst?.h3 && display && !compareOn && dev.value < 1) {
      const hex = this._h3Layer({ display, hCode, heightBlend, elevationScale, extruded, opacity, fx });
      if (hex.layer) {
        layers.push(hex.layer);
        columnsDrawn = true;
      } else if (!reason && hex.reason) reason = hex.reason;
    }
    if (display && !compareOn && dev.value < 1 && !columnsDrawn) {
      const columns = this._columnLayer({ display, tr, path, hCode, heightBlend, elevationScale, extruded, pickable, opacity, fx, s, desc, lensOn: lensMask });
      if (columns) {
        layers.push(columns);
        columnsDrawn = true;
        if (path === "cpu" || display.kind === "categorical" || tr) this.lastCpuAt = tNow;
      }
    }
    if (compareOn && display) {
      const cmpLayers = this._compareLayers({ t, v, desc, hCode, elevationScale, extruded, pickable, opacity });
      layers.push(...cmpLayers.layers);
      columnsDrawn = cmpLayers.layers.length > 0;
      if (cmpLayers.reason) reason = cmpLayers.reason;
      this.lastCpuAt = tNow;
    }
    // Lens: the raster shows inside the circle, the columns are masked out there.
    let lensReason = null;
    if (lensOn && this.pointer) {
      const vp = this.deck.getViewports?.()?.[0];
      const ring = lensRing(vp, this.pointer);
      if (raster.lensLayer) layers.push(raster.lensLayer());
      else lensReason = raster.reason ?? "250 m not available for this frame";
      // Rim tag: short status only (the full reason goes to the store → toolbar tooltip / announcer).
      // Day 250 m is observed Landsat and night 250 m is DMS-downscaled (SPEC §1.3), so the tag follows
      // the raster's own `downscaled` flag instead of always saying DOWNSCALED.
      const tag = lensReason ? "250 m · UNAVAILABLE" : raster.downscaled ? "250 m · DOWNSCALED" : "250 m · OBSERVED";
      layers.push(...createLensLayers({ ring, label: tag }));
    }

    if (v.analyst?.boundaries !== false && bs.resources.districts?.status === "ready") {
      layers.push(this._memoLayer("boundaries", [bs.resources.districts.data, s.districtId ?? null], () => createBoundaryLayer(bs.resources.districts.data, { highlightId: s.districtId ?? null })));
    }
    if (v.analyst?.labels !== false && g.labels.length) layers.push(this._memoLayer("labels", [g.labels], () => createLabelLayer(g.labels)));
    if (columnsDrawn || raster.visible) layers.push(...createReticleLayers({ pinned: this._reticle(s.pinnedIndex, display, hCode, elevationScale), hover: interacting ? null : this._reticle(s.hoverIndex, display, hCode, elevationScale), cellSizeM: g.cellSizeM }));

    // Boot swath (once per session, Full motion).
    if (this.swath && display) {
      if (this.swath.start === null) this.swath.start = tNow;
      const p = (tNow - this.swath.start) / BOOT_SWATH_MS;
      if (p >= 1 || level !== "full") this.swath = null;
      else {
        layers.push(...createSwathLayers({ bounds: g.bounds, t: p }));
        animating = true;
      }
    }

    // A memoised overlay left out of this frame (e.g. boundaries toggled off) is finalized by
    // deck: forget it, so turning it back on builds a fresh instance instead of re-adding a
    // finalized one ("initialization … assertion failed").
    for (const name of Object.keys(this._memo ?? {})) if (!this._memoUsed.has(name)) delete this._memo[name];
    // Same for the memoised column layer: a frame without it (compare, H3 hexagons, a fully
    // developed raster) lets deck finalize it, so it must not be handed back afterwards.
    if (this._columnMemo && !layers.includes(this._columnMemo.layer)) this._columnMemo = null;
    this.layers = layers;
    this.animating = animating || interacting;
    this.deck.setProps({ layers, effects: this.effects });

    // After the first paint, prefetch the other mode's observation cube on idle so the first
    // Day ↔ Night sweep does not wait on a download (UI_SPEC §10 "night on first toggle or idle").
    if (display && !this._modePrefetched) {
      this._modePrefetched = true;
      const keys = bs.timeline.modeIds.filter((m) => m !== desc.mode).map((m) => `cube:${m}:obs`);
      const run = () => bs.prefetch?.(keys);
      if (keys.length) {
        if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 4000 });
        else setTimeout(run, 500);
      }
    }

    // ---- status for React -----------------------------------------------------------------
    this.store.patch({
      status,
      reason,
      path,
      pathReason,
      // The legend describes what is DRAWN: while new content streams in, the previous display
      // (and its own description) stays on screen, so its desc — not the requested one — is used.
      // Nothing drawn because the requested content does not exist (e.g. surface UHI at a
      // projected year): the legend says why instead of showing a scale (T-F4-02/22).
      legend: !display && (status === "unavailable" || status === "error") ? this._unavailableLegend(desc, status, reason) : this._legend(display, display?.desc ?? desc, wantHeight),
      raster: { visible: raster.visible, available: raster.available, reason: raster.reason, preview: raster.preview, key: raster.key },
      lens: { on: lensOn, available: Boolean(raster.lensLayer), reason: lensReason },
      compare: { on: compareOn, kind: t.compare?.kind ?? null, splitPx: t.compare?.splitPx ?? null, labels: this.compareCache.labels ?? null },
      perf: { tier: v.perfTier ?? 0, ema: this.governor.ema === null ? null : Math.round(this.governor.ema * 10) / 10, fps: this.fps.value, gpuMB: this._gpuMB(), auto: this.governor.tier > this.governor.floor },
    });
    return this.animating;
  }

  /** Reuse an overlay layer instance while its inputs are identical (deck then skips diffing it). */
  _memoLayer(name, deps, build) {
    this._memo = this._memo ?? {};
    this._memoUsed?.add(name);
    const prev = this._memo[name];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) return prev.layer;
    const layer = build();
    this._memo[name] = { deps, layer };
    return layer;
  }

  // -------------------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------------------

  _cpuBuffers(n) {
    const b = this.cpuBuffers;
    if (!b.colors[0] || b.colors[0].length !== n * 4) {
      b.colors = [new Uint8Array(n * 4), new Uint8Array(n * 4)];
      b.elevations = [new Float32Array(n), new Float32Array(n)];
      b.values = new Float32Array(n);
    }
    b.k = 1 - b.k;
    return { colors: b.colors[b.k], elevations: b.elevations[b.k], values: b.values };
  }

  _transitionSnapshot() {
    // A transition interrupted by another content change: snapshot what is on screen now — the
    // continuous side with the larger weight (a colour cross-fade has no single value field).
    const tr = this.transition;
    if (!tr || !this.current) return this.current;
    const p = Math.min(1, (now() - tr.start) / tr.duration);
    return p >= 0.5 || tr.from?.kind !== "continuous" ? this.current : { kind: "continuous", desc: { mode: tr.fromMode }, A: { values: tr.from.values, vsup: tr.from.vsup, aoa: tr.from.aoa, mean: tr.from.ref }, B: { values: tr.from.values, vsup: tr.from.vsup, aoa: tr.from.aoa, mean: tr.from.ref }, mix: 0, channel: tr.from.channel };
  }

  _weightsFor(tr, n) {
    const g = this.geo;
    if (tr.shape === SHAPES.sweep) return mixWeights(n, SHAPES.sweep, { lonNorm: g.lonNorm, sweepPos: tr.p, feather: SWEEP_FEATHER }, this._weightBuf);
    if (tr.shape === SHAPES.radial) return mixWeights(n, SHAPES.radial, { mix: tr.p, x: g.planar.x, y: g.planar.y, cx: tr.radial.cx, cy: tr.radial.cy, radius: tr.radial.radius, feather: RADIAL_FEATHER }, this._weightBuf);
    return tr.p;
  }

  /**
   * Column layer, memoised on its real inputs (display data + channel + mix, path, height state,
   * brush, lens, pickability, opacity, lighting): a frame where only the hover / pin changed reuses
   * the SAME layer instance and CPU buffers, so only the reticle layers are rebuilt and the CPU path
   * never recolours 55k cells for a pointer move. Transitions are never memoised (they animate).
   */
  _columnLayer(args) {
    const { display, tr, path, hCode, heightBlend, elevationScale, extruded, pickable, opacity, fx, s, lensOn } = args;
    const n = this.geo.cells.n;
    const brush = s.brushMask && s.brushMask.length === n ? s.brushMask : null;
    const cat = display.kind === "categorical";
    const deps = [cat ? display.frame : display.A, cat ? null : display.B, cat ? null : display.mix, cat ? null : display.channel, display.ck, path, hCode, this.height.from, heightBlend, elevationScale, extruded, pickable, opacity, fx.flatLighting, brush, lensOn, this.lut];
    const m = this._columnMemo;
    if (!tr && m && m.deps.length === deps.length && m.deps.every((d, i) => d === deps[i])) return m.layer;
    const layer = this._buildColumnLayer(args);
    this._columnMemo = tr || !layer ? null : { deps, layer };
    return layer;
  }

  _buildColumnLayer({ display, tr, path, hCode, heightBlend, elevationScale, extruded, pickable, opacity, fx, s, lensOn }) {
    const g = this.geo;
    const n = g.cells.n;
    const hatchOn = true;
    const maskOn = Boolean(s.brushMask && s.brushMask.length === n);
    const brush = maskOn ? s.brushMask : null;
    const common = {
      cells: g.cells,
      cellSizeM: g.cellSizeM,
      extruded,
      elevationScale,
      pickable,
      opacity,
      material: fx.flatLighting ? FLAT_MATERIAL : MATERIAL,
      rim: fx.flatLighting ? 0 : 0.25,
      ...(lensOn ? lensMaskProps(true) : {}),
    };
    const heightOf = (ch, ref) => heightChannel({ lo: ch.lo, hi: ch.hi, ref, cap: HEIGHT_CAP_C });
    const categoricalInvolved = display.kind === "categorical" || tr?.from?.kind === "categorical";

    // ---- categorical / mixed-kind cross-fades: CPU colours ------------------------------
    if (categoricalInvolved) {
      const buf = this._cpuBuffers(n);
      let targetColors;
      if (display.kind === "categorical") {
        targetColors = tr ? new Uint8Array(n * 4) : buf.colors;
        colorizeCategorical({ codes: display.frame.codes, palette: display.frame.palette, outColors: targetColors, brush, maskOn });
      } else {
        targetColors = tr ? new Uint8Array(n * 4) : buf.colors;
        const ch = display.channel;
        colorizeSlots({ valuesA: display.A.values, valuesB: display.B.values, weight: display.mix, channelA: ch, channelB: ch, valueMix: true, vsupA: display.A.vsup, vsupB: display.B.vsup, aoaA: display.A.aoa, aoaB: display.B.aoa, hatchOn, brush, maskOn, outColors: targetColors });
      }
      if (tr) {
        const from = tr.from.kind === "categorical" ? tr.from.colors : null;
        if (from) {
          const w = this._weightsFor(tr, n);
          for (let i = 0; i < n; i += 1) {
            const m = typeof w === "number" ? w : w[i];
            const o = i * 4;
            for (let c = 0; c < 4; c += 1) buf.colors[o + c] = from[o + c] + (targetColors[o + c] - from[o + c]) * m + 0.5;
          }
        } else {
          // continuous → categorical: colour the snapshot, then cross-fade.
          const fromColors = new Uint8Array(n * 4);
          colorizeSlots({ valuesA: tr.from.values, valuesB: tr.from.values, weight: 0, channelA: tr.from.channel, channelB: tr.from.channel, valueMix: true, vsupA: tr.from.vsup, aoaA: tr.from.aoa, hatchOn, outColors: fromColors });
          for (let i = 0; i < n * 4; i += 1) buf.colors[i] = fromColors[i] + (targetColors[i] - fromColors[i]) * tr.p + 0.5;
        }
      }
      return createThermalColumns({ ...common, id: "thermal-columns-cpu", extruded: false, attributes: { getFillColor: { value: buf.colors, size: 4, normalized: true } } });
    }

    // ---- continuous ---------------------------------------------------------------------
    let A;
    let B;
    let chA;
    let chB;
    let refA;
    let refB;
    let weight;
    let valueMix;
    let shape = SHAPES.fade;
    let radial = null;
    if (tr) {
      const targetValues = this._mixedValues(display);
      const side = display.mix >= 0.5 ? display.B : display.A;
      A = { values: tr.from.values, vsup: tr.from.vsup, aoa: tr.from.aoa };
      B = { values: targetValues, vsup: side.vsup, aoa: side.aoa };
      chA = tr.from.channel;
      chB = display.channel;
      refA = tr.from.ref;
      refB = this._heightRef(display);
      valueMix = chA.rampIndex === chB.rampIndex && chA.lo === chB.lo && chA.hi === chB.hi;
      if (valueMix) refA = refA + (refB - refA) * tr.p;
      shape = tr.shape;
      radial = tr.radial ?? null;
      weight = tr.p;
    } else {
      A = display.A;
      B = display.B;
      chA = chB = display.channel;
      refA = refB = this._heightRef(display);
      valueMix = true;
      weight = display.mix;
    }
    const heightSpec = { mode: hCode, from: this.height.from, blend: heightBlend, A: heightOf(chA, refA), B: heightOf(chB, refB) };

    if (path === "gpu") {
      const aux = this._aux(A, B, brush, n);
      const thermal = {
        slotA: [chA.lo, chA.hi, refA, chA.rampIndex],
        slotB: [chB.lo, chB.hi, refB, chB.rampIndex],
        shape: [shape === SHAPES.fade || shape === SHAPES.radial ? weight : 0, shape === SHAPES.sweep ? weight : 0, shape === SHAPES.radial ? RADIAL_FEATHER : SWEEP_FEATHER, shape],
        lonRange: [g.bounds[0], g.bounds[2], valueMix ? 1 : 0, 0],
        radial: radial ? [radial.cx, radial.cy, radial.radius, 0] : [0, 0, 1, 0],
        planar: g.planarParams,
        height: [hCode, this.height.from, heightBlend, HEIGHT_CAP_C],
        elev: [heightSpec.A.perUnit, heightSpec.A.perUnitAbs, heightSpec.B.perUnitAbs, 1],
        fx: [1, hatchOn ? 1 : 0, maskOn ? 1 : 0, 0],
      };
      return createThermalColumns({
        ...common,
        id: "thermal-columns-gpu",
        gpu: true,
        extensions: [GPU_SLOTS, ...(lensOn ? lensMaskProps(true).extensions : [])],
        attributes: { getValueA: gpuSlot(A.values), getValueB: gpuSlot(B.values), getThermalAux: aux },
        thermal,
        thermalLut: this.lut,
      });
    }

    const buf = this._cpuBuffers(n);
    const w = shape === SHAPES.fade ? weight : this._weightsFor({ shape, p: weight, radial }, n);
    if (typeof w !== "number") this._weightBuf = w;
    colorizeSlots({ valuesA: A.values, valuesB: B.values, weight: w, channelA: chA, channelB: chB, valueMix, vsupA: A.vsup, vsupB: B.vsup, aoaA: A.aoa, aoaB: B.aoa, hatchOn, brush, maskOn, outColors: buf.colors, outValues: buf.values, outElevations: buf.elevations, height: heightSpec });
    return createThermalColumns({ ...common, id: "thermal-columns-cpu", attributes: { getFillColor: { value: buf.colors, size: 4, normalized: true }, getElevation: { value: buf.elevations, size: 1 } } });
  }

  /**
   * H3 hexagon aggregate of the current display (Analyst toggle; layers/h3.js).
   * Returns `{layer}` when drawable, else `{layer: null, reason}` while h3-js loads / if it failed.
   * The per-hexagon colours are recomputed only when the display, its mix or the height encoding
   * changes, so a paused map costs nothing per frame.
   */
  _h3Layer({ display, hCode, heightBlend, elevationScale, extruded, opacity, fx }) {
    const st = this.h3;
    if (st.status === "idle") {
      st.status = "loading";
      loadH3()
        .then((mod) => {
          st.mod = mod;
          st.status = "ready";
        })
        .catch((error) => {
          console.warn("[engine] H3 aggregation unavailable", error);
          st.error = error;
          st.status = "error";
        })
        .finally(() => this.invalidate());
    }
    if (st.status === "loading") return { layer: null, reason: "loading H3 aggregation" };
    if (st.status !== "ready") return { layer: null, reason: "H3 aggregation unavailable (h3-js failed to load)" };

    const g = this.geo;
    const resolution = h3ResolutionFor(g.cellSizeM);
    if (!st.index || st.index.cells !== g.cells || st.index.resolution !== resolution) {
      try {
        st.index = buildHexIndex(g.cells, resolution, st.mod.latLngToCell);
      } catch (error) {
        console.warn("[engine] H3 index failed", error);
        st.status = "error";
        return { layer: null, reason: "H3 aggregation unavailable (indexing failed)" };
      }
      const nHex = st.index.hexIds.length;
      st.colors = new Uint8Array(nHex * 4);
      st.elevations = new Float32Array(nHex);
      st.means = new Float32Array(nHex);
      st.codes = new Int16Array(nHex);
      st.key = null;
    }
    const idx = st.index;
    const nHex = idx.hexIds.length;
    // `_target` builds a new display object every frame, so the cache is keyed on the frame DATA
    // (frame objects are cached by the frame source) plus everything that changes the colours.
    const ch = display.channel;
    const key = `${display.ck}|${display.kind === "continuous" ? `${display.mix}|${ch.rampIndex}|${ch.lo}|${ch.hi}` : display.frame.palette.length}|${hCode}|${this.height.from}|${heightBlend}`;
    const srcA = display.kind === "continuous" ? display.A : display.frame;
    const srcB = display.kind === "continuous" ? display.B : null;
    if (st.key !== key || st.srcA !== srcA || st.srcB !== srcB) {
      if (display.kind === "categorical") {
        hexModes(display.frame.codes, idx.cellHex, nHex, display.frame.palette.length, st.codes);
        colorizeCategorical({ codes: st.codes, palette: display.frame.palette, outColors: st.colors });
        st.elevations.fill(0);
      } else {
        hexMeans(this._mixedValues(display), idx.cellHex, nHex, st.means);
        const hc = heightChannel({ lo: ch.lo, hi: ch.hi, ref: this._heightRef(display), cap: HEIGHT_CAP_C });
        colorizeSlots({
          valuesA: st.means,
          valuesB: st.means,
          weight: 0,
          channelA: ch,
          channelB: ch,
          valueMix: true,
          hatchOn: false,
          outColors: st.colors,
          outElevations: st.elevations,
          height: { mode: hCode, from: this.height.from, blend: heightBlend, A: hc, B: hc },
        });
      }
      st.key = key;
      st.srcA = srcA;
      st.srcB = srcB;
      st.version += 1;
    }
    const layer = createH3Layer({
      H3HexagonLayer: st.mod.H3HexagonLayer,
      index: idx,
      colors: st.colors,
      elevations: st.elevations,
      version: st.version,
      extruded: extruded && display.kind === "continuous",
      elevationScale,
      opacity,
      material: fx.flatLighting ? FLAT_MATERIAL : MATERIAL,
    });
    return { layer };
  }

  /** Aux bytes (VSUP A, VSUP B, AOA bits, brush) — rebuilt only when a slot or the brush changes. */
  _aux(A, B, brush, n) {
    const key = this._auxKey;
    if (key && key.a === A.vsup && key.b === B.vsup && key.oa === A.aoa && key.ob === B.aoa && key.brush === brush && key.n === n) return key.wrapper;
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i += 1) {
      const o = i * 4;
      out[o] = A.vsup ? A.vsup[i] : 0;
      out[o + 1] = B.vsup ? B.vsup[i] : 0;
      out[o + 2] = (A.aoa && A.aoa[i] ? 1 : 0) | (B.aoa && B.aoa[i] ? 2 : 0);
      out[o + 3] = brush ? (brush[i] ? 1 : 0) : 1;
    }
    const wrapper = { value: out, size: 4 };
    this._auxKey = { a: A.vsup, b: B.vsup, oa: A.aoa, ob: B.aoa, brush, n, wrapper };
    return wrapper;
  }

  _gpuError(error) {
    if (this.gpuFailed) return;
    console.warn("[engine] GPU slot path failed; falling back to the CPU path", error);
    this.gpuFailed = true;
    this.invalidate();
  }

  /** deck `onError`: a failing GPU layer switches the engine to the CPU path. */
  handleDeckError = (error, layer) => {
    if (layer?.id === "thermal-columns-gpu" || layer?.id?.startsWith?.("thermal-raster")) {
      if (layer.id.startsWith("thermal-raster")) {
        this.rasterFailed = true;
        this.invalidate();
      } else this._gpuError(error);
      return;
    }
    console.warn("[engine] deck error", layer?.id, error?.message ?? String(error), error);
  };

  // -------------------------------------------------------------------------------------
  // Compare (two CPU instances + ScreenSplitExtension)
  // -------------------------------------------------------------------------------------

  /** The two sides of a compare state: {left: {desc, year}, right: {desc, year}, labels}. */
  _compareSides(t, desc) {
    const tl = this.bundle.getState().timeline;
    const cmp = t.compare;
    const ssp = (id) => tl.scenarios.find((s) => s.id === id)?.label ?? id;
    if (cmp.kind === "y") {
      const a = Number.isFinite(cmp.a) ? cmp.a : tl.first;
      const b = Number.isFinite(cmp.b) ? cmp.b : Number.isFinite(t.scrubT) ? t.scrubT : tl.last;
      return { left: { desc, year: a }, right: { desc, year: b }, labels: [`${Math.round(a)} · ${desc.mode}`, `${Math.round(b)} · ${desc.mode}`] };
    }
    if (cmp.kind === "s") {
      const year = Number.isFinite(t.scrubT) && t.scrubT > tl.now ? t.scrubT : tl.last;
      const a = cmp.a ?? tl.scenarioIds[0];
      const b = cmp.b ?? tl.scenarioIds[tl.scenarioIds.length - 1];
      return { left: { desc: { ...desc, ssp: a }, year }, right: { desc: { ...desc, ssp: b }, year }, labels: [`${Math.round(year)} · ${ssp(a)}`, `${Math.round(year)} · ${ssp(b)}`] };
    }
    const year = Number.isFinite(t.scrubT) ? t.scrubT : tl.now;
    return { left: { desc: { ...desc, mode: "day" }, year }, right: { desc: { ...desc, mode: "night" }, year }, labels: [`${Math.round(year)} · Day`, `${Math.round(year)} · Night`] };
  }

  _compareLayers({ t, desc, hCode, elevationScale, extruded, pickable, opacity }) {
    const g = this.geo;
    const sides = this._compareSides(t, desc);
    const split = Number.isFinite(t.compare.splitPx) ? t.compare.splitPx / Math.max(1, this._canvasSize().width) : 0.5;
    this._compareSplit = split;
    const brushMask = this.selection.getState().brushMask ?? null;
    const layers = [];
    let reason = null;
    const cc = this.compareCache;
    if (!cc.sides) cc.sides = {};
    if (!cc.buffers) cc.buffers = {};
    let pending = false;
    // Each side is cached on its OWN content (content key @ year, height mode, brush) AND its
    // colour channel: a fixed side is never recoloured while the other one scrubs, and a ready
    // side is kept while the other one loads, but a side coloured with a provisional channel
    // (e.g. the per-frame Δ scale while the cross-frame Δ domain waits for an SSP cube) is rebuilt
    // as soon as the final channel exists, so both sides always match the legend (D22 a/c).
    // Colours go into per-side double buffers (a new array identity per recolour, so deck
    // re-uploads, without allocating 55k × 4 bytes per frame).
    const build = (name, side) => {
      const key = `${contentKey(side.desc)}@${side.year}|${hCode}`;
      const prev = cc.sides[name];
      const finalChannel = prev?.display?.kind === "continuous" ? this.frames.cachedChannel(side.desc) : null;
      if (prev && prev.key === key && prev.brush === brushMask && (!finalChannel || prev.display.channel === finalChannel)) return prev;
      const r = this._target(side.desc, side.year);
      if (r.status !== "ready") {
        const why = r.reason ?? (r.status === "loading" ? "loading" : "unavailable");
        if (r.status === "loading") pending = true;
        // Stale-while-loading: keep the side that is on screen until the new one is ready.
        return r.status === "loading" && prev?.colors ? { ...prev, stale: true } : { key: null, reason: why };
      }
      const d = r.display;
      const n = g.cells.n;
      let bufs = cc.buffers[name];
      if (!bufs || bufs.colors[0].length !== n * 4) {
        bufs = { k: 0, colors: [new Uint8Array(n * 4), new Uint8Array(n * 4)], elevations: [new Float32Array(n), new Float32Array(n)] };
        cc.buffers[name] = bufs;
      }
      bufs.k = 1 - bufs.k;
      const colors = bufs.colors[bufs.k];
      const elevations = bufs.elevations[bufs.k];
      if (d.kind === "categorical") {
        colorizeCategorical({ codes: d.frame.codes, palette: d.frame.palette, outColors: colors });
        elevations.fill(0);
        return { key, brush: brushMask, colors, elevations, flat: true, display: d };
      }
      const ref = this._heightRef(d);
      const hc = heightChannel({ lo: d.channel.lo, hi: d.channel.hi, ref, cap: HEIGHT_CAP_C });
      colorizeSlots({ valuesA: d.A.values, valuesB: d.B.values, weight: d.mix, channelA: d.channel, channelB: d.channel, valueMix: true, vsupA: d.A.vsup, vsupB: d.B.vsup, aoaA: d.A.aoa, aoaB: d.B.aoa, outColors: colors, outElevations: elevations, height: { mode: hCode, A: hc, B: hc } });
      return { key, brush: brushMask, colors, elevations, flat: false, display: d };
    };
    cc.sides.left = build("left", sides.left);
    cc.sides.right = build("right", sides.right);
    cc.left = cc.sides.left;
    cc.right = cc.sides.right;
    cc.labels = sides.labels;
    if (pending) setTimeout(() => this.invalidate(), 50);
    const { left, right } = cc;
    const mk = (side, id, keep) =>
      side?.colors
        ? createThermalColumns({
            cells: g.cells,
            cellSizeM: g.cellSizeM,
            id,
            extruded: extruded && !side.flat,
            elevationScale,
            pickable,
            opacity,
            extensions: [SPLIT],
            splitEnabled: true,
            splitSide: keep,
            splitX: split,
            attributes: { getFillColor: { value: side.colors, size: 4, normalized: true }, getElevation: { value: side.elevations, size: 1 } },
          })
        : null;
    const l = mk(left, "thermal-compare-left", "left");
    const r = mk(right, "thermal-compare-right", "right");
    if (l) layers.push(l);
    if (r) layers.push(r);
    if (!l || !r) reason = `compare: ${left?.reason ?? right?.reason ?? "unavailable"}`;
    return { layers, reason, split };
  }

  // -------------------------------------------------------------------------------------
  // Raster (250 m / 500 m preview) + lens
  // -------------------------------------------------------------------------------------

  _rasterPlan({ desc, t, v, fx, scrubT, display, interacting }) {
    const none = (reason, available = false) => ({ visible: false, available, reason, preview: false, key: null, layer: null, lensLayer: null });
    const bs = this.bundle.getState();
    const tl = bs.timeline;
    const wantMode = v.renderMode ?? "auto";
    const zoom = this.viewState.zoom ?? HOME_ZOOM;
    const lensWanted = Boolean(v.lens) && fx.lensAllowed && !this.mobile;
    const wantRaster = wantMode === "raster" || (wantMode === "auto" && !this.mobile && zoom >= RASTER_AUTO_ZOOM);
    if (!wantRaster && !lensWanted) return none(null, true);
    if (this.rasterFailed) return none("raster shader unavailable on this device");
    if (!this.device || !this.lut) return none("GPU not ready");
    if (tl.schema === "v1") return none("250 m rasters are unavailable in a v1 bundle — rerun notebook v2");
    if (desc.layer !== "lst" || desc.mode === "dtr" || desc.q !== "p50" || !(desc.variable === "abs" || desc.variable === "anom")) return none("250 m shows absolute or anomaly LST (p50) only");
    if (fx.rasterOnPauseOnly && interacting) return none("raster paused during playback (performance tier 3)");
    if (!display || display.kind !== "continuous") return none(null);
    const b = bracketAt(tl.years, clampYear(tl, scrubT));
    const years = isExactBracket(b) ? [b.yA] : [b.yA, b.yB];
    for (const y of years) {
      const fr = frameAt(tl, y);
      if (!fr?.raster?.[desc.mode]) return none(`${y}: not downscaled`);
    }
    if (bs.resources.rasterIndex?.status && bs.resources.rasterIndex.status !== "ready" && bs.resources.rasterIndex.status !== "loading") return none(bs.resources.rasterIndex.reason ?? "no raster index");
    const wantPreview = Boolean(t.playing);
    // Stale-while-loading across play/pause: while the wanted variant (500 m preview during
    // playback, full 250 m on pause) loads, draw the other variant if it is ready; hide only when
    // neither is.
    const tex = years.map((y) => {
      const key = rasterKey(desc.mode, y);
      const want = this._rasterTexture(key, wantPreview);
      if (want.status !== "loading") return want;
      const other = this._rasterTexture(key, !wantPreview, { load: false });
      return other.status === "ready" ? other : want;
    });
    if (tex.some((x) => x.status === "loading")) return { ...none(null, true), reason: "250 m loading" };
    const bad = tex.find((x) => x.status !== "ready");
    if (bad) return none(bad.reason ?? "raster unavailable");
    const [A, B] = tex.length === 2 ? tex : [tex[0], tex[0]];
    const preview = Boolean(A.preview);
    this._prefetchRasters(desc.mode, b, wantPreview);
    const mix = isExactBracket(b) ? 0 : b.mix;
    const ch = display.channel;
    const offset = (y) => {
      if (desc.variable !== "anom") return 0;
      // The SAME level the 1 km anomaly columns subtract (cube frame level, else the mean).
      const f = this.frames.frame({ ...desc, variable: "abs" }, y);
      if (f.status !== "ready") return 0;
      return Number.isFinite(f.frame.level) ? -f.frame.level : -f.frame.mean;
    };
    const offA = offset(years[0]);
    const offB = offset(years[years.length - 1]);
    const uniforms = {
      boundsLL: A.data.bounds,
      decodeA: [A.data.lo, A.data.hi, offA, 0],
      decodeB: [B.data.lo, B.data.hi, offB, 0],
      channel: [ch.lo, ch.hi, ch.rampIndex, 1],
      channelB: [ch.lo, ch.hi, ch.rampIndex, 0],
      shape: [mix, 0, SWEEP_FEATHER, SHAPES.fade],
      lonRange: [this.geo.bounds[0], this.geo.bounds[2], 0, 0],
      fx: [1, fx.isotherms && !interacting ? 1 : 0, 1, 0],
    };
    const make = (id, opacity, extra) =>
      new ThermalRasterLayer({
        id,
        bounds: A.data.bounds,
        _imageCoordinateSystem: "lnglat",
        textureA: A.texture,
        textureB: B.texture,
        thermalLut: this.lut,
        thermalRaster: { ...uniforms, fx: [uniforms.fx[0], uniforms.fx[1], opacity, 0] },
        pickable: false,
        ...(extra ?? {}),
      });
    return {
      visible: wantRaster,
      available: true,
      reason: null,
      preview,
      key: `${rasterKey(desc.mode, years[0])}${preview ? " (500 m preview)" : ""}`,
      downscaled: Boolean(A.data.downscaled),
      layer: wantRaster ? (opacity) => make("thermal-raster", opacity) : null,
      lensLayer: lensWanted && !wantRaster ? () => make("thermal-raster-lens", 1, lensMaskProps(false)) : null,
      // The value as DRAWN: the same decode offsets as the shader (anomaly = absolute − level).
      readout: (lon, lat) => {
        const va = rasterValueAt(A.data, lon, lat);
        const vb = rasterValueAt(B.data, lon, lat);
        if (!va) return null;
        return {
          value: mixValue(va.value + offA, vb ? vb.value + offB : NaN, mix),
          outsideAoa: va.outsideAoa,
          downscaled: Boolean(A.data.downscaled),
          variable: desc.variable,
          preview,
          interpolated: mix > 0 && mix < 1,
        };
      },
    };
  }

  /** Prefetch the rasters of the frames next to the bracket (±1, current mode) on idle. */
  _prefetchRasters(mode, b, preview) {
    const tl = this.bundle.getState().timeline;
    const keys = [b.iA - 1, b.iB + 1]
      .filter((i) => i >= 0 && i < tl.frames.length && tl.frames[i].raster?.[mode])
      .map((i) => rasterResourceKey(rasterKey(mode, tl.frames[i].year), preview))
      .filter((k) => !this.bundle.getState().resources[k]);
    if (!keys.length || this._prefetchKey === keys.join()) return;
    this._prefetchKey = keys.join();
    const run = () => this.bundle.getState().prefetch?.(keys);
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 120);
  }

  /**
   * Texture of a raster resource (created on first use, dropped when E2's LRU evicts it). A ready
   * raster that is drawn is touched in the BundleStore LRU, so the frames on screen are never the
   * ones evicted. `load: false` only peeks (no download is started).
   */
  _rasterTexture(key, preview, { load = true } = {}) {
    const bs = this.bundle.getState();
    const rk = rasterResourceKey(key, preview);
    // Drop textures whose resource left the BundleStore (LRU eviction / bundle switch).
    for (const [k, entry] of this.rasterTextures) {
      if (bs.resources[k]?.status !== "ready" || bs.resources[k].data !== entry.data) {
        try {
          entry.texture.destroy();
        } catch (_error) {
          // context gone
        }
        this.rasterTextures.delete(k);
      }
    }
    const res = bs.resources[rk];
    if (!res || res.status === "idle") {
      if (!load) return { status: "idle" };
      Promise.resolve(bs.ensure(rk)).finally(() => this.invalidate());
      // Prefetch the neighbours of the current mode for smooth stepping (±1 frame).
      return { status: "loading" };
    }
    if (res.status !== "ready") return { status: res.status, reason: res.reason };
    let entry = this.rasterTextures.get(rk);
    if (!entry) {
      try {
        entry = { texture: createRasterTexture(this.device, res.data), data: res.data };
        this.rasterTextures.set(rk, entry);
      } catch (error) {
        console.warn("[engine] raster texture creation failed", error);
        return { status: "error", reason: "raster texture could not be created" };
      }
    }
    bs.touch?.(rk);
    return { status: "ready", texture: entry.texture, data: res.data, preview: Boolean(preview) };
  }

  _gpuMB() {
    const n = this.geo?.cells.n ?? 0;
    let bytes = n * (12 + 8 + 4 + 4 + 4 + 4 + 4);
    for (const { data } of this.rasterTextures.values()) bytes += data.width * data.height * 4;
    if (this.lut) bytes += thermalAtlas().data.length;
    return Math.round((bytes / (1024 * 1024)) * 10) / 10;
  }

  // -------------------------------------------------------------------------------------
  // Readouts, reticles, legend
  // -------------------------------------------------------------------------------------

  /**
   * Readout of one cell as currently displayed (for the HoverCard / inspector):
   * {index, value, valueA, valueB, yA, yB, mix, interpolated, category, outsideAoa, kind}.
   */
  readCell(index) {
    const d = this.current;
    if (!d || !Number.isInteger(index) || index < 0 || !this.geo || index >= this.geo.cells.n) return null;
    return this._readDisplay(d, index);
  }

  /** Readout of one cell of a display (main view or one compare side). */
  _readDisplay(d, index) {
    const what = { layer: d.desc.layer, variable: d.desc.variable, q: d.desc.q, mode: d.desc.mode, ssp: d.desc.ssp, deltaRef: d.desc.deltaRef ?? null, shapFeature: d.desc.shapFeature ?? null };
    if (d.kind === "categorical") {
      const code = d.frame.codes[index];
      return { index, kind: "categorical", year: d.year, category: code >= 0 ? d.frame.categories[code] ?? null : null, interpolated: false, ...what };
    }
    const a = d.A.values[index];
    const b = d.B.values[index];
    const side = d.mix >= 0.5 ? d.B : d.A;
    return {
      index,
      kind: "continuous",
      value: mixValue(a, b, d.mix),
      valueA: a,
      valueB: b,
      yA: d.bracket?.yA ?? d.A.year,
      yB: d.bracket?.yB ?? d.B.year,
      year: d.mix >= 0.5 ? d.B.year : d.A.year,
      mix: d.mix,
      interpolated: d.mix > 0 && d.mix < 1,
      held: Boolean(d.held),
      outsideAoa: side.aoa ? Boolean(side.aoa[index]) : null,
      vsup: side.vsup ? side.vsup[index] - 1 : null,
      unit: d.channel?.unit ?? "°C",
      tier: side.tier ?? null,
      ...what,
    };
  }

  /**
   * Compare readout of one cell: both sides as drawn, the side under screen x (px), and B − A.
   * @returns {{left, right, under: "left"|"right", labels, diff}|null}
   */
  readCompare(index, x = null) {
    const cc = this.compareCache;
    if (!cc?.left?.display && !cc?.right?.display) return null;
    if (!Number.isInteger(index) || index < 0 || !this.geo || index >= this.geo.cells.n) return null;
    const left = cc.left?.display ? this._readDisplay(cc.left.display, index) : null;
    const right = cc.right?.display ? this._readDisplay(cc.right.display, index) : null;
    const splitPx = Number.isFinite(this._compareSplit) ? this._compareSplit * this._canvasSize().width : this._canvasSize().width / 2;
    const under = Number.isFinite(x) && x >= splitPx ? "right" : "left";
    const diff = left?.kind === "continuous" && right?.kind === "continuous" ? right.value - left.value : NaN;
    return { left, right, under, labels: cc.labels ?? null, diff };
  }

  /** CPU raster readout at lon/lat (no GPU picking), null when no raster is loaded. */
  readRaster(lon, lat) {
    const t = this.time.getState();
    const v = this.view.getState();
    if (!this.current) return null;
    const plan = this._rasterPlan({ desc: this._desc(t, v), t, v, fx: tierEffects(v.perfTier ?? 0), scrubT: t.scrubT, display: this.current, interacting: false });
    return plan.readout ? plan.readout(lon, lat) : null;
  }

  _reticle(index, display, hCode, elevationScale) {
    const g = this.geo;
    if (!Number.isInteger(index) || index < 0 || index >= g.cells.n) return null;
    let z = 0;
    if (display?.kind === "continuous" && hCode !== 0) {
      const ref = this._heightRef(display);
      const hc = heightChannel({ lo: display.channel.lo, hi: display.channel.hi, ref, cap: HEIGHT_CAP_C });
      const val = mixValue(display.A.values[index], display.B.values[index], display.mix);
      if (!Number.isNaN(val)) z = (hCode === 1 ? Math.min(Math.max(val - ref, 0), HEIGHT_CAP_C) * hc.perUnit : Math.max(val - hc.lo, 0) * hc.perUnitAbs) * elevationScale;
    }
    return { index, lon: g.cells.lon[index], lat: g.cells.lat[index], z };
  }

  /**
   * The legend of what is DRAWN (engineStore.legend, D22 a). Categories are memoised per frame
   * object, so the store's shallow compare sees the same array and the legend does not re-render
   * on every frame while a categorical layer plays.
   */
  _legend(display, desc, heightMode) {
    if (!display) return null;
    return this._drawnLegend(display, desc, heightMode);
  }

  /** Legend of content that is not drawn: no ramp or domain, the engine's reason as the note. */
  _unavailableLegend(desc, status, reason) {
    return { layer: desc.layer, kind: "unavailable", ramp: null, lo: null, hi: null, unit: null, stretched: false, crossFrame: false, domainYear: null, variable: desc.variable, mode: desc.mode, heightMode: "flat", categories: null, note: reason ?? (status === "error" ? "this layer failed to load" : "not available for this frame"), held: false };
  }

  _drawnLegend(display, desc, heightMode) {
    if (display.kind === "categorical") {
      // Per frame object (fast path), then per content signature: the zone frames of different
      // years carry equal categories and must yield the SAME array.
      if (!this._legendCats) this._legendCats = { byFrame: new WeakMap(), bySig: new Map() };
      let categories = this._legendCats.byFrame.get(display.frame);
      if (!categories) {
        const sig = display.frame.categories.map((c) => `${c.id}\u0001${c.label}\u0001${c.color}`).join("\u0002");
        categories = this._legendCats.bySig.get(sig);
        if (!categories) {
          categories = Object.freeze(display.frame.categories.map((c) => Object.freeze({ id: c.id, label: c.label, color: c.color })));
          if (this._legendCats.bySig.size > 32) this._legendCats.bySig.clear();
          this._legendCats.bySig.set(sig, categories);
        }
        this._legendCats.byFrame.set(display.frame, categories);
      }
      return { layer: desc.layer, kind: "categorical", ramp: null, lo: null, hi: null, unit: null, stretched: false, crossFrame: false, domainYear: null, variable: desc.variable, mode: desc.mode, heightMode: "flat", categories, note: null, held: false };
    }
    const ch = display.channel;
    return {
      layer: desc.layer,
      kind: ch.kind,
      ramp: ch.ramp,
      lo: ch.lo,
      hi: ch.hi,
      unit: ch.unit,
      stretched: ch.stretched,
      crossFrame: Boolean(ch.crossFrame),
      domainYear: ch.domainYear ?? null,
      variable: desc.variable,
      mode: desc.mode,
      heightMode,
      categories: null,
      note: display.A.note ?? null,
      held: Boolean(display.held),
    };
  }

  // -------------------------------------------------------------------------------------
  // Picking: hover (30 Hz, off while playing/dragging) and click (pin)
  // -------------------------------------------------------------------------------------

  /** DeckGL `onHover`. */
  handleHover = (info) => {
    this.hoverInfo = info;
    if (this.lensOn) {
      this.pointer = Number.isFinite(info?.x) && info.x >= 0 ? [info.x, info.y] : null;
      this.invalidate();
    }
    const elapsed = now() - this.lastHoverAt;
    if (elapsed >= HOVER_INTERVAL_MS) this._processHover();
    else if (!this.hoverTimer) this.hoverTimer = setTimeout(() => this._processHover(), HOVER_INTERVAL_MS - elapsed);
  };

  /** Index of the cell under a picking info (columns by index; rasters through the locator). */
  _indexOf(info) {
    if (!info) return null;
    if (info.layer && info.layer.id.startsWith("thermal-") && info.layer.id.includes("columns") && Number.isInteger(info.index) && info.index >= 0) return info.index;
    if (info.layer?.id?.startsWith("thermal-compare") && Number.isInteger(info.index) && info.index >= 0) return info.index;
    const c = info.coordinate;
    if ((this.develop.value > 0.5 || this.lensOn) && Array.isArray(c)) {
      const k = this._locator()?.nearest(c[0], c[1]);
      return Number.isInteger(k) && k >= 0 ? k : null;
    }
    return null;
  }

  _processHover() {
    this.hoverTimer = null;
    this.lastHoverAt = now();
    const t = this.time.getState();
    if (t.playing || t.dragging) {
      if (this.selection.getState().hoverIndex !== null) this.selection.getState().setHover?.(null);
      this.store.patch({ hover: null });
      return;
    }
    const info = this.hoverInfo;
    const index = this._indexOf(info);
    this.selection.getState().setHover?.(index);
    const c = info?.coordinate;
    this.store.patch({ hover: index === null ? null : { index, x: Math.round(info.x), y: Math.round(info.y), lon: c?.[0] ?? null, lat: c?.[1] ?? null } });
  }

  /** DeckGL `onClick`: pin / unpin the cell. */
  handleClick = (info) => {
    const index = this._indexOf(info);
    if (index === null) return;
    this.selection.getState().togglePin?.(index);
  };

  getCursor = ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab");

  /** `H`: pin, fly to and announce the hottest displayed cell. */
  /**
   * `ncr:probe-hottest` arbitration. Mission Control (E4) handles `H` itself when it is mounted
   * (pin + district + `ncr:fly-to {source: "probe-hottest"}` + announcement); a second engine
   * probe would announce twice and, mid-tween, could pin a DIFFERENT cell (the view ranks the
   * bracket frame, the engine the mixed scrub values). The engine therefore waits one macrotask —
   * every synchronous listener of the same dispatch has run by then — and probes only if no view
   * claimed the event, either with `detail.handled = true` or through its probe fly-to. This
   * keeps `H` working while the lazily loaded Control route has not mounted yet.
   */
  _onProbeEvent(detail) {
    this.probeClaimed = false;
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = 0;
      const claimed = this.probeClaimed || Boolean(detail && typeof detail === "object" && detail.handled);
      this.probeClaimed = false;
      if (!claimed) this.probeHottest({ quietIfNotReady: true });
    }, 0);
  }

  /**
   * Pin + fly to the hottest cell of what is DRAWN (the mixed scrub values), announcing it.
   * `quietIfNotReady`: as the fallback handler, stay silent while nothing is drawn yet (the view
   * that owns the frame announces "still loading"); a drawn categorical layer still explains why.
   */
  probeHottest({ quietIfNotReady = false } = {}) {
    const d = this.current;
    if (!d && quietIfNotReady) return null;
    if (!d || d.kind !== "continuous" || !this.geo) {
      announce("No continuous layer to probe: switch to LST.");
      return null;
    }
    const values = this._mixedValues(d);
    let best = -1;
    let bestV = -Infinity;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] > bestV) {
        bestV = values[i];
        best = i;
      }
    }
    if (best < 0) return null;
    this.selection.getState().pin?.(best);
    this._onFlyEvent({ cellIndex: best });
    const year = d.bracket && !isExactBracket(d.bracket) ? `≈${Math.round(this.time.getState().scrubT)}` : String(d.A.year);
    announce(`Hottest cell pinned: ${bestV.toFixed(1)} ${d.channel.unit} (${d.desc.layer === "lst" ? d.desc.variable : d.desc.layer}, ${d.desc.mode}, ${year}).`);
    return best;
  }

  // -------------------------------------------------------------------------------------
  // Render callbacks: perf sampling + PNG export
  // -------------------------------------------------------------------------------------

  /** DeckGL `onAfterRender`. */
  handleAfterRender = () => {
    // Perf sampling lives in _tick (work time, not the render interval: UI_SPEC §6.6).
    if (this.pendingExport) {
      this.pendingExport = false;
      this._capture();
    }
  };

  /** `ncr:export-png`: capture the next rendered frame (deck canvas over the basemap). */
  exportPng() {
    this.pendingExport = true;
    this.deck?.redraw?.("export-png");
    this.invalidate();
  }

  _capture() {
    try {
      const canvas = this.deck?.getCanvas?.() ?? this.deck?.canvas;
      if (!canvas || !this.win?.document) return;
      const out = this.win.document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#05070D";
      ctx.fillRect(0, 0, out.width, out.height);
      const basemap = canvas.parentElement?.parentElement?.querySelector?.(".maplibregl-canvas");
      if (basemap) {
        try {
          ctx.drawImage(basemap, 0, 0, out.width, out.height);
        } catch (_error) {
          // A tainted or cleared basemap canvas is skipped; the thermal layers still export.
        }
      }
      ctx.drawImage(canvas, 0, 0);
      const t = this.time.getState();
      const a = this.win.document.createElement("a");
      a.download = `ncr-thermal-${Math.round(t.scrubT ?? 0)}-${t.mode}.png`;
      a.href = out.toDataURL("image/png");
      a.click();
      announce("Map view exported as PNG.");
    } catch (error) {
      console.warn("[engine] PNG export failed", error);
    }
  }
}

/** Shared extension instances (deck compares extensions by identity). */
const GPU_SLOTS = new ThermalSlotsExtension();
const SPLIT = new ScreenSplitExtension();

/** Module registry so other streams (Control chrome, inspector) can reach the live engine. */
let liveEngine = null;
const engineListeners = new Set();

export function setMapEngine(engine) {
  liveEngine = engine;
  engineListeners.forEach((fn) => fn(engine));
}

/** The engine of the mounted ThermalStage (null when unmounted). */
export const getMapEngine = () => liveEngine;

/** Subscribe to engine (un)mounts; returns an unsubscribe function. */
export function onMapEngine(fn) {
  engineListeners.add(fn);
  return () => engineListeners.delete(fn);
}

export { shapeCode };
