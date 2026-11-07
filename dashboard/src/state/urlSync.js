/**
 * Two-way sync between the URL and the zustand stores (UI_SPEC_v2 §2.2).
 *
 *   #/control?y=2040&m=night&s=245&v=abs&l=lst&r=auto&h=anom&q=p50&c=48211&d=7&cmp=y:1990&cam=77.21,28.61,8.2,40,-12
 *
 * - The route is the hash path; the view state is the hash query, so the page query string
 *   (`?bundle=demo`, `?perf=1`, `?shader=off`, owned by the data layer / engine) is untouched.
 *   An anchor after the query (`#/sources#caveat-terra`) is preserved for in-view scrolling.
 * - URL -> stores on start and on every hashchange/popstate (shared links, back/forward). Only
 *   a back/forward to an entry this module wrote (history state `{ncrUrlSync: 1}`) resets the
 *   params it omits to their defaults; an in-app hash link (`#/control`) or a manual hash edit
 *   applies only the params it carries, so mode / SSP / layer / pin survive, and the URL is then
 *   re-normalised from the stores.
 * - stores -> URL: param changes use `history.replaceState`, debounced 250 ms; a route change
 *   uses `pushState` immediately so Back returns to the previous view. Nothing is written
 *   during playback (the final state is written once playback stops).
 * - Params equal to their static default are omitted (m=day, s=245, l=lst, h=anom, q=p50);
 *   `y`, `v` and `r` are always written because their defaults depend on the bundle/device.
 *
 * The codec (`parseLocation` / `formatLocation`) is pure and unit-tested; `startUrlSync`
 * wires it to the stores. Store fields follow the §7 shapes (timeStore.year/mode/ssp/compare,
 * viewStore.route/layer/shapFeature/variable/renderMode/heightMode/quantile, selectionStore
 * .pinnedIndex/districtId/zoneId). SSP ids are "ssp245" in stores and "245" in the URL.
 */
import { DEFAULT_ROUTE, normalizeRoute } from "../shell/routes.js";

export const YEAR_MIN = 1990;
export const YEAR_MAX = 2050;
export const URL_DEBOUNCE_MS = 250;
/** History state of the entries this module writes (marks a complete param set). */
const OWN_STATE = Object.freeze({ ncrUrlSync: 1 });

export const URL_ENUMS = Object.freeze({
  m: Object.freeze(["day", "night", "dtr"]),
  s: Object.freeze(["126", "245", "370", "585"]),
  v: Object.freeze(["abs", "anom", "suhi", "delta"]),
  l: Object.freeze(["lst", "pred", "resid", "driver", "zones", "whatif", "unc", "aoa"]),
  r: Object.freeze(["grid", "raster", "auto"]),
  h: Object.freeze(["flat", "anom", "abs"]),
  q: Object.freeze(["p05", "p50", "p95", "spread"]),
});

/** Static defaults that are omitted from the URL. */
export const URL_DEFAULTS = Object.freeze({ m: "day", s: "245", l: "lst", h: "anom", q: "p50" });

/** Param order in written URLs (stable, human-scannable). */
const PARAM_ORDER = Object.freeze(["y", "m", "s", "v", "l", "r", "h", "q", "c", "d", "z", "cmp", "cam"]);

const toInt = (v) => (/^-?\d+$/.test(String(v ?? "").trim()) ? Number.parseInt(v, 10) : null);

/** "ssp245" | "245" | 245 -> "245" (null when not a known SSP code). */
export function sspToUrl(ssp) {
  const code = String(ssp ?? "")
    .trim()
    .toLowerCase()
    .replace(/^ssp/, "");
  return URL_ENUMS.s.includes(code) ? code : null;
}

/** "245" -> "ssp245". */
export const sspFromUrl = (code) => (URL_ENUMS.s.includes(String(code)) ? `ssp${code}` : null);

/** Parse `cmp`: "y:1990" | "s:585" | "m:night" -> {kind, value} (null when malformed). */
export function parseCompare(raw) {
  const m = /^([ysm]):(.+)$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const [, k, v] = m;
  if (k === "y") {
    const y = toInt(v);
    return y !== null && y >= YEAR_MIN && y <= YEAR_MAX ? { kind: "year", value: y } : null;
  }
  if (k === "s") {
    const s = sspFromUrl(v);
    return s ? { kind: "ssp", value: s } : null;
  }
  return v === "night" || v === "day" ? { kind: "mode", value: v } : null;
}

/** Inverse of parseCompare. Accepts store-style compare objects ({kind, a, b}) too. */
export function formatCompare(compare) {
  if (!compare || !compare.kind) return null;
  const kind = { y: "year", year: "year", s: "ssp", ssp: "ssp", m: "mode", mode: "mode" }[compare.kind];
  const value = compare.value ?? compare.a;
  if (kind === "year") {
    const y = toInt(value);
    return y !== null ? `y:${y}` : null;
  }
  if (kind === "ssp") {
    const s = sspToUrl(value);
    return s ? `s:${s}` : null;
  }
  if (kind === "mode") return `m:${compare.b === "day" ? "day" : "night"}`;
  return null;
}

/** Parse `cam`: "lon,lat,zoom,pitch,bearing" -> {longitude, latitude, zoom, pitch, bearing}. */
export function parseCamera(raw) {
  const parts = String(raw ?? "")
    .split(",")
    .map((p) => Number(p));
  if (parts.length !== 5 || parts.some((p) => !Number.isFinite(p))) return null;
  const [longitude, latitude, zoom, pitch, bearing] = parts;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 85 || zoom < 0 || zoom > 24 || pitch < 0 || pitch > 85) return null;
  return { longitude, latitude, zoom, pitch, bearing };
}

/** Inverse of parseCamera (4 / 4 / 2 / 0 / 0 decimals, enough for ~10 m at zoom 12). */
export function formatCamera(cam) {
  if (!cam) return null;
  const { longitude, latitude, zoom, pitch = 0, bearing = 0 } = cam;
  if (![longitude, latitude, zoom].every(Number.isFinite)) return null;
  return [longitude.toFixed(4), latitude.toFixed(4), zoom.toFixed(2), Math.round(pitch), Math.round(bearing)].join(",");
}

/**
 * Parse a location hash into {route, params, anchor}. `params` holds only VALID decoded
 * values (invalid params are dropped, never thrown):
 *   year, mode, ssp ("ssp245"), variable, layer, shapFeature, renderMode, heightMode,
 *   quantile, cell, district, zone, compare {kind, value}, camera.
 * @param {string} hash e.g. window.location.hash
 */
export function parseLocation(hash) {
  let text = String(hash ?? "").replace(/^#/, "");
  let anchor = null;
  const anchorAt = text.indexOf("#");
  if (anchorAt >= 0) {
    anchor = text.slice(anchorAt + 1) || null;
    text = text.slice(0, anchorAt);
  }
  const [pathPart, queryPart = ""] = text.split("?");
  const route = normalizeRoute(pathPart.replace(/^\/+/, "").split("/")[0]);
  const q = new URLSearchParams(queryPart);
  const params = {};

  const y = Number(q.get("y"));
  if (q.has("y") && Number.isFinite(y) && y >= YEAR_MIN && y <= YEAR_MAX) params.year = Math.round(y * 100) / 100;
  if (URL_ENUMS.m.includes(q.get("m"))) params.mode = q.get("m");
  if (q.has("s") && sspFromUrl(q.get("s"))) params.ssp = sspFromUrl(q.get("s"));
  if (URL_ENUMS.v.includes(q.get("v"))) params.variable = q.get("v");
  const l = q.get("l");
  if (l && /^shap:[A-Za-z0-9_.-]+$/.test(l)) {
    params.layer = "shap";
    params.shapFeature = l.slice(5);
  } else if (l === "shap") {
    params.layer = "shap";
  } else if (URL_ENUMS.l.includes(l)) params.layer = l;
  if (URL_ENUMS.r.includes(q.get("r"))) params.renderMode = q.get("r");
  if (URL_ENUMS.h.includes(q.get("h"))) params.heightMode = q.get("h");
  if (URL_ENUMS.q.includes(q.get("q"))) params.quantile = q.get("q");
  const c = toInt(q.get("c"));
  if (c !== null && c >= 0) params.cell = c;
  const d = q.get("d");
  if (d && /^[A-Za-z0-9_.-]{1,64}$/.test(d)) params.district = toInt(d) ?? d;
  const z = toInt(q.get("z"));
  if (z !== null && z >= 0 && z < 16) params.zone = z;
  const cmp = parseCompare(q.get("cmp"));
  if (cmp) params.compare = cmp;
  const cam = parseCamera(q.get("cam"));
  if (cam) params.camera = cam;

  return { route, params, anchor };
}

/**
 * Format {route, params, anchor} as a hash ("#/control?y=2025&v=abs&r=auto").
 * `params` uses the same keys parseLocation returns; unknown/invalid values are skipped.
 */
export function formatLocation({ route, params = {}, anchor = null } = {}) {
  const out = {};
  if (Number.isFinite(params.year)) out.y = String(Math.round(params.year * 100) / 100);
  if (URL_ENUMS.m.includes(params.mode)) out.m = params.mode;
  const s = sspToUrl(params.ssp);
  if (s) out.s = s;
  if (URL_ENUMS.v.includes(params.variable)) out.v = params.variable;
  if (params.layer === "shap") out.l = params.shapFeature ? `shap:${params.shapFeature}` : "shap";
  else if (URL_ENUMS.l.includes(params.layer)) out.l = params.layer;
  if (URL_ENUMS.r.includes(params.renderMode)) out.r = params.renderMode;
  if (URL_ENUMS.h.includes(params.heightMode)) out.h = params.heightMode;
  if (URL_ENUMS.q.includes(params.quantile)) out.q = params.quantile;
  if (Number.isInteger(params.cell) && params.cell >= 0) out.c = String(params.cell);
  if (params.district !== null && params.district !== undefined && params.district !== "") out.d = String(params.district);
  if (Number.isInteger(params.zone)) out.z = String(params.zone);
  const cmp = formatCompare(params.compare);
  if (cmp) out.cmp = cmp;
  const cam = formatCamera(params.camera);
  if (cam) out.cam = cam;

  for (const [k, v] of Object.entries(URL_DEFAULTS)) if (out[k] === v) delete out[k];

  // URLSearchParams would percent-encode ':' and ','; both are legal in a fragment and keep
  // shared links readable, so the query is assembled by hand (values are validated above).
  const query = PARAM_ORDER.filter((k) => out[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(out[k]).replace(/%3A/gi, ":").replace(/%2C/gi, ",")}`)
    .join("&");
  const path = `#/${normalizeRoute(route) ?? DEFAULT_ROUTE}`;
  return `${path}${query ? `?${query}` : ""}${anchor ? `#${anchor}` : ""}`;
}

// ---------------------------------------------------------------------------------------
// Store <-> params mapping
// ---------------------------------------------------------------------------------------

let urlCamera = null;
const cameraListeners = new Set();

/** Camera last read from / reported to the URL (engine reads it for the initial view). */
export const getUrlCamera = () => urlCamera;

/**
 * The map engine reports camera changes here (it owns the viewState; the stores do not).
 * The next debounced URL write includes it. Pass null to drop `cam` from the URL.
 */
export function reportCamera(viewState) {
  urlCamera = viewState
    ? {
        longitude: viewState.longitude,
        latitude: viewState.latitude,
        zoom: viewState.zoom,
        pitch: viewState.pitch ?? 0,
        bearing: viewState.bearing ?? 0,
      }
    : null;
  cameraListeners.forEach((fn) => fn());
}

/** Subscribe to camera arrivals from the URL (shared links / back-forward). */
export function onUrlCamera(listener) {
  cameraListeners.add(listener);
  return () => cameraListeners.delete(listener);
}

/** Current store state -> URL params. */
export function paramsFromStores({ time, view, selection }) {
  const t = time.getState();
  const v = view.getState();
  const s = selection.getState();
  return {
    year: t.year,
    mode: t.mode,
    ssp: t.ssp,
    variable: v.variable,
    layer: v.layer,
    shapFeature: v.layer === "shap" ? v.shapFeature : null,
    renderMode: v.renderMode,
    heightMode: v.heightMode,
    quantile: v.quantile,
    cell: s.pinnedIndex,
    district: s.districtId,
    zone: s.zoneId,
    compare: t.compare,
    camera: v.camera ?? urlCamera,
  };
}

function setVia(store, key, value) {
  const state = store.getState();
  if (Object.is(state[key], value)) return;
  const action = state[`set${key[0].toUpperCase()}${key.slice(1)}`];
  if (typeof action === "function") action(value);
  else store.setState({ [key]: value });
}

/**
 * Apply parsed URL params to the stores. `availableSsps` (ids like "ssp245") restricts `s`
 * to the scenarios the manifest actually has (§2.2 "only those in the manifest").
 */
export function applyParamsToStores({ route, params: parsed }, { time, view, selection }, { availableSsps = null, resetAbsent = false } = {}) {
  // Back/forward to a URL that omits a param means "its default" (defaults are never written).
  const params = resetAbsent
    ? {
        mode: URL_DEFAULTS.m,
        ssp: sspFromUrl(URL_DEFAULTS.s),
        layer: URL_DEFAULTS.l,
        heightMode: URL_DEFAULTS.h,
        quantile: URL_DEFAULTS.q,
        cell: null,
        district: null,
        zone: null,
        compare: null,
        ...parsed,
      }
    : parsed;
  if (route) setVia(view, "route", route);
  const t = time.getState();
  if (params.year !== undefined && params.year !== t.year) {
    if (typeof t.setYear === "function") t.setYear(params.year);
    else time.setState({ year: params.year, scrubT: params.year });
  }
  if (params.mode && params.mode !== t.mode) {
    if (typeof t.setMode === "function") t.setMode(params.mode);
    else time.setState({ mode: params.mode });
  }
  if (params.ssp && params.ssp !== t.ssp && (!availableSsps || availableSsps.includes(params.ssp))) {
    if (typeof t.setSsp === "function") t.setSsp(params.ssp);
    else time.setState({ ssp: params.ssp });
  }
  // timeStore compare kinds are "y" | "s" | "m" (COMPARE_KINDS); "off" is {kind: null}.
  if (params.compare) {
    const current = time.getState();
    let compare = null;
    if (params.compare.kind === "year") compare = { kind: "y", a: params.compare.value, b: current.year };
    else if (params.compare.kind === "ssp") compare = { kind: "s", a: params.compare.value, b: current.ssp };
    else compare = { kind: "m", a: "day", b: params.compare.value };
    if (formatCompare(current.compare) !== formatCompare(compare)) {
      if (typeof current.setCompare === "function") current.setCompare(compare);
      else time.setState({ compare });
    }
  } else if (params.compare === null && time.getState().compare?.kind) {
    const current = time.getState();
    if (typeof current.setCompare === "function") current.setCompare(null);
    else time.setState({ compare: null });
  }
  for (const key of ["variable", "layer", "renderMode", "heightMode", "quantile"]) {
    if (params[key] !== undefined) setVia(view, key, params[key]);
  }
  if (params.shapFeature) setVia(view, "shapFeature", params.shapFeature);
  if (params.cell !== undefined) setVia(selection, "pinnedIndex", params.cell);
  if (params.district !== undefined) setVia(selection, "districtId", params.district);
  if (params.zone !== undefined) setVia(selection, "zoneId", params.zone);
  if (params.camera) {
    urlCamera = params.camera;
    if ("camera" in view.getState()) setVia(view, "camera", params.camera);
    cameraListeners.forEach((fn) => fn());
  }
}

/**
 * Start syncing. Returns `stop()`. Safe to call once per app; a second call stops the first.
 * @param {{time, view, selection}} stores zustand hooks/stores (getState/setState/subscribe)
 * @param {{win?: Window, debounceMs?: number, getAvailableSsps?: () => string[]|null}} [options]
 */
let activeStop = null;
export function startUrlSync(stores, { win = typeof window !== "undefined" ? window : null, debounceMs = URL_DEBOUNCE_MS, getAvailableSsps = () => null } = {}) {
  if (!win) return () => {};
  activeStop?.();
  const { time, view, selection } = stores;
  let timer = null;
  let applying = false;
  let pendingWhilePlaying = false;
  let lastRoute = null;

  const current = () => parseLocation(win.location.hash);

  const write = (mode) => {
    timer = null;
    const loc = current();
    const route = view.getState().route ?? DEFAULT_ROUTE;
    const next = formatLocation({ route, params: paramsFromStores(stores), anchor: route === loc.route ? loc.anchor : null });
    if (next === win.location.hash && win.history?.state?.ncrUrlSync) return;
    try {
      // The state marker tells popstate that this entry holds a COMPLETE param set.
      if (mode === "push") win.history.pushState(OWN_STATE, "", next);
      else win.history.replaceState(OWN_STATE, "", next);
    } catch (error) {
      // Some embedded contexts (sandboxed iframes, file://) forbid history writes.
      console.warn("[urlSync] could not write the URL:", error);
    }
  };

  const schedule = () => {
    if (applying) return;
    if (time.getState().playing) {
      pendingWhilePlaying = true;
      return;
    }
    const route = view.getState().route;
    if (lastRoute !== null && route !== lastRoute) {
      lastRoute = route;
      if (timer) win.clearTimeout(timer);
      write("push");
      return;
    }
    lastRoute = route;
    if (timer) win.clearTimeout(timer);
    timer = win.setTimeout(() => write("replace"), debounceMs);
  };

  const applyFromUrl = (resetAbsent = false) => {
    const loc = current();
    applying = true;
    try {
      applyParamsToStores(loc, stores, { availableSsps: getAvailableSsps(), resetAbsent });
    } finally {
      applying = false;
    }
    lastRoute = view.getState().route;
  };

  // 1. URL -> stores (initial), then normalise the URL once (adds the route, drops junk).
  applyFromUrl();
  write("replace");

  // 2. stores -> URL
  const unsubs = [
    time.subscribe((state, prev) => {
      if (prev && prev.playing && !state.playing && pendingWhilePlaying) {
        pendingWhilePlaying = false;
        schedule();
        return;
      }
      if (prev && state.year === prev.year && state.mode === prev.mode && state.ssp === prev.ssp && state.compare === prev.compare) return;
      schedule();
    }),
    view.subscribe(schedule),
    selection.subscribe((state, prev) => {
      if (prev && state.pinnedIndex === prev.pinnedIndex && state.districtId === prev.districtId && state.zoneId === prev.zoneId) return;
      schedule();
    }),
  ];
  const offCamera = onUrlCamera(() => {
    if (!applying) schedule();
  });

  // 3. back/forward (popstate onto an entry we wrote: absent params mean their defaults) and
  //    in-app hash links / manual edits (hashchange, or popstate onto a browser-made entry:
  //    only the params present are applied, then the URL is re-normalised).
  let handledHash = null;
  const applyPartial = () => {
    applyFromUrl(false);
    if (timer) win.clearTimeout(timer);
    write("replace");
  };
  const onPopstate = (event) => {
    handledHash = win.location.hash;
    if (event?.state?.ncrUrlSync) applyFromUrl(true);
    else applyPartial();
  };
  const onHashchange = () => {
    // Browsers fire popstate before hashchange for the same fragment navigation.
    if (handledHash !== null && handledHash === win.location.hash) {
      handledHash = null;
      return;
    }
    handledHash = null;
    applyPartial();
  };
  win.addEventListener("hashchange", onHashchange);
  win.addEventListener("popstate", onPopstate);

  const stop = () => {
    if (timer) win.clearTimeout(timer);
    unsubs.forEach((u) => u());
    offCamera();
    win.removeEventListener("hashchange", onHashchange);
    win.removeEventListener("popstate", onPopstate);
    if (activeStop === stop) activeStop = null;
  };
  activeStop = stop;
  return stop;
}
