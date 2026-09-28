/**
 * Web-bundle loading (SPEC §4 / §5).
 *
 * - `loadManifest()` distinguishes "no bundle yet" (HTTP 404, or an HTML page served by an
 *   SPA fallback) -> DataLoadError(status "empty") from every other failure -> status "error".
 * - `loadEpoch()` converts the columnar JSON into typed arrays once (lon/lat Float64Array,
 *   cell_id Int32Array, district Int16Array, zone Int8Array, everything else Float32Array with
 *   null -> NaN), attaches `index` (cell_id -> row) and robust colour-scale `stats`, and caches
 *   the result per URL. The raw JSON is dropped after conversion so only the compact typed
 *   representation stays in memory (~4 B/value instead of ~16+ B for JS numbers in arrays).
 * - Concurrent calls for the same resource share one in-flight promise; failed requests are
 *   evicted from the cache so a retry can succeed.
 * - Large files may be gzip-compressed on disk (SPEC §4: `epoch_<year>.json.gz`,
 *   `dependence.json.gz`). Every file is read as bytes: a body that starts with the gzip magic
 *   bytes 0x1f 0x8b is inflated with the browser's DecompressionStream, anything else is decoded
 *   as UTF-8 text. This handles plain `.json`, raw `.gz` bytes, and servers that already sent
 *   `Content-Encoding: gzip` (the browser then hands over the inflated JSON under a .gz name).
 */

/** Error carrying the dashboard status it should map to ("empty" | "error"). */
export class DataLoadError extends Error {
  constructor(message, { status = "error", url = null, httpStatus = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DataLoadError";
    this.status = status;
    this.url = url;
    this.httpStatus = httpStatus;
  }
}

/** Keys of SPEC §4.2 per-cell columns and their typed-array constructors. */
const INT_COLUMNS = Object.freeze({ cell_id: Int32Array, district: Int16Array, zone: Int8Array });
const COORD_COLUMNS = Object.freeze(["lon", "lat"]);
const FLOAT_COLUMNS = Object.freeze(["lst_obs", "lst_pred", "lst_pred_oof", "resid_oof"]);
/** Columns that may be missing entirely in older bundles (filled with NaN). */
const OPTIONAL_FLOAT_COLUMNS = new Set(["lst_pred_oof", "resid_oof"]);

const jsonCache = new Map();
const epochCache = new Map();

/**
 * Base URL of the web bundle, without trailing slash.
 * `VITE_DATA_BASE_URL` wins when set to a non-empty value, else `${BASE_URL}data`.
 */
export function getDataBaseUrl() {
  const env = import.meta.env ?? {};
  const configured = typeof env.VITE_DATA_BASE_URL === "string" ? env.VITE_DATA_BASE_URL.trim() : "";
  const base = configured || `${env.BASE_URL ?? "/"}data`;
  return base.replace(/\/+$/, "");
}

/** Join the base URL and a bundle-relative file name. */
export function dataUrl(fileName) {
  return `${getDataBaseUrl()}/${String(fileName).replace(/^\/+/, "")}`;
}

/** Forget every cached response (used by tests and the "retry" button). */
export function clearDataCache() {
  jsonCache.clear();
  epochCache.clear();
}

function looksLikeHtml(response, text) {
  const type = response.headers?.get?.("content-type") ?? "";
  return type.includes("text/html") || /^\s*<(!doctype|html)/i.test(text);
}

/** True when `bytes` starts with the gzip member header magic (0x1f 0x8b). */
export function isGzipBytes(bytes) {
  return bytes != null && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Inflate gzip bytes to UTF-8 text with the platform's DecompressionStream (all evergreen
 * browsers and Node >= 18). Throws a descriptive Error when the API is unavailable.
 */
export async function gunzipToText(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("this browser cannot decompress gzip (DecompressionStream is unavailable)");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Body of a fetch Response as text, transparently inflating gzip payloads (detected by their
 * magic bytes, not by the file name or headers, so an already-inflated `.gz` works too).
 * Response-like objects without `arrayBuffer()` fall back to `text()`.
 */
export async function readBodyText(response) {
  if (typeof response.arrayBuffer !== "function") return response.text();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (isGzipBytes(bytes)) return gunzipToText(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Fetch and parse a JSON file. `missingIsEmpty` maps a 404 / HTML fallback page to
 * status "empty" (used for the manifest, whose absence means "bundle not installed").
 */
async function fetchJson(url, { missingIsEmpty = false } = {}) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json, application/gzip;q=0.9, */*;q=0.8" } });
  } catch (cause) {
    throw new DataLoadError(`Network error while fetching ${url}: ${cause?.message ?? cause}`, { url, cause });
  }
  if (!response.ok) {
    const missing = response.status === 404;
    throw new DataLoadError(
      missing ? `Not found: ${url} (HTTP 404)` : `Failed to fetch ${url} (HTTP ${response.status} ${response.statusText ?? ""})`.trim(),
      { status: missing && missingIsEmpty ? "empty" : "error", url, httpStatus: response.status },
    );
  }
  let text;
  try {
    text = await readBodyText(response);
  } catch (cause) {
    throw new DataLoadError(`Could not read ${url}: ${cause?.message ?? cause}`, { url, cause });
  }
  if (looksLikeHtml(response, text)) {
    // Dev servers / static hosts with an SPA fallback answer missing files with index.html.
    throw new DataLoadError(`Expected JSON at ${url} but received an HTML page (file probably missing).`, {
      status: missingIsEmpty ? "empty" : "error",
      url,
      httpStatus: response.status,
    });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new DataLoadError(`Invalid JSON in ${url}: ${cause.message}`, { url, cause });
  }
}

/** Promise-level cache: concurrent callers share one request; failures are evicted. */
function cached(cache, key, factory) {
  if (cache.has(key)) return cache.get(key);
  const promise = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, promise);
  return promise;
}

/** Load `manifest.json`. Rejects with DataLoadError(status "empty") when the bundle is absent. */
export function loadManifest() {
  const url = dataUrl("manifest.json");
  return cached(jsonCache, url, async () => {
    const manifest = await fetchJson(url, { missingIsEmpty: true });
    if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.epochs) || !manifest.files) {
      throw new DataLoadError(`manifest.json at ${url} is malformed (missing "epochs" or "files").`, { url });
    }
    return manifest;
  });
}

/**
 * Load a non-epoch asset declared in `manifest.files` (e.g. "model", "zones", "districts").
 * Resolves to `null` when the manifest does not declare the key.
 */
export function loadAsset(manifest, key) {
  const fileName = manifest?.files?.[key];
  if (key === "epochs") return Promise.reject(new DataLoadError('Use loadEpoch() for "epochs".'));
  if (typeof fileName !== "string" || !fileName) return Promise.resolve(null);
  const url = dataUrl(fileName);
  return cached(jsonCache, url, () => fetchJson(url));
}

/** File name of an epoch from the manifest (falls back to the SPEC naming convention). */
function epochFileName(manifest, year) {
  return manifest?.files?.epochs?.[String(year)] ?? `epoch_${year}.json`;
}

/**
 * Load one epoch as typed arrays (cached per URL).
 * @returns {Promise<object>} prepared epoch (see `prepareEpoch`)
 */
export function loadEpoch(manifest, year) {
  const url = dataUrl(epochFileName(manifest, year));
  return cached(epochCache, url, async () => {
    const raw = await fetchJson(url);
    try {
      return prepareEpoch(raw, manifest);
    } catch (cause) {
      throw new DataLoadError(`Epoch ${year} (${url}) is malformed: ${cause.message}`, { url, cause });
    }
  });
}

// ---------------------------------------------------------------------------------------
// Conversion to typed arrays
// ---------------------------------------------------------------------------------------

function toFloat(values, Ctor, n, name) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) throw new Error(`column "${name}" is not an array`);
  if (values.length !== n) throw new Error(`column "${name}" has length ${values.length}, expected n=${n}`);
  const out = new Ctor(n);
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    out[i] = v === null || v === undefined ? NaN : v;
  }
  return out;
}

function toInt(values, Ctor, n, name) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) throw new Error(`column "${name}" is not an array`);
  if (values.length !== n) throw new Error(`column "${name}" has length ${values.length}, expected n=${n}`);
  const out = new Ctor(n);
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    out[i] = v === null || v === undefined || Number.isNaN(v) ? -1 : v;
  }
  return out;
}

function nanColumn(n) {
  return new Float32Array(n).fill(NaN);
}

/** Linear-interpolated quantile of an ascending-sorted typed array (q in [0, 1]). */
export function quantileSorted(sorted, q) {
  const len = sorted.length;
  if (len === 0) return NaN;
  const pos = (len - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, len - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Finite values of `arr` (optionally |v|) as a sorted Float64Array. */
function sortedFinite(arr, absolute = false) {
  const tmp = new Float64Array(arr.length);
  let k = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (Number.isFinite(v)) {
      tmp[k] = absolute ? Math.abs(v) : v;
      k += 1;
    }
  }
  return tmp.subarray(0, k).sort();
}

/**
 * Summary statistics over finite values: {min, max, mean, p02, p98, count}.
 * p02/p98 are the robust colour-scale limits used by the map legends.
 */
export function columnStats(arr) {
  const sorted = sortedFinite(arr);
  const count = sorted.length;
  if (count === 0) return { min: NaN, max: NaN, mean: NaN, p02: NaN, p98: NaN, count: 0 };
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += sorted[i];
  return {
    min: sorted[0],
    max: sorted[count - 1],
    mean: sum / count,
    p02: quantileSorted(sorted, 0.02),
    p98: quantileSorted(sorted, 0.98),
    count,
  };
}

/** p98 of |values|; falls back to max |v| (then 1e-3) so diverging scales never get a 0 domain. */
function robustMaxAbs(arr) {
  const sorted = sortedFinite(arr, true);
  if (sorted.length === 0) return 1e-3;
  const p98 = quantileSorted(sorted, 0.98);
  if (p98 > 0) return p98;
  const max = sorted[sorted.length - 1];
  return max > 0 ? max : 1e-3;
}

/** Feature order: manifest feature names, else the raw object's key order. */
function featureNames(manifest, raw) {
  const fromManifest = manifest?.features?.map?.((f) => f.name).filter(Boolean);
  if (fromManifest?.length) return fromManifest;
  return Object.keys(raw.features ?? {});
}

/**
 * Convert a raw `epoch_<year>.json` object (SPEC §4.2) into the dashboard's epoch object.
 * Pure function (exported for tests). Throws Error with a precise message when malformed.
 */
export function prepareEpoch(raw, manifest) {
  if (!raw || typeof raw !== "object") throw new Error("epoch payload is not an object");
  const n = Number(raw.n ?? raw.cell_id?.length);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid "n": ${raw.n}`);

  const epoch = {
    year: Number(raw.year),
    n,
    cell_size_m: Number(raw.cell_size_m) || Number(manifest?.study_area?.grid_res_m) || 1000,
    epoch_mean: Number.isFinite(raw.epoch_mean) ? raw.epoch_mean : NaN,
    base_value_c: Number.isFinite(raw.base_value_c) ? raw.base_value_c : NaN,
  };

  for (const [name, Ctor] of Object.entries(INT_COLUMNS)) {
    if (raw[name] === undefined) throw new Error(`missing column "${name}"`);
    epoch[name] = toInt(raw[name], Ctor, n, name);
  }
  for (const name of COORD_COLUMNS) {
    if (raw[name] === undefined) throw new Error(`missing column "${name}"`);
    epoch[name] = toFloat(raw[name], Float64Array, n, name);
  }
  for (const name of FLOAT_COLUMNS) {
    if (raw[name] === undefined || raw[name] === null) {
      if (!OPTIONAL_FLOAT_COLUMNS.has(name)) throw new Error(`missing column "${name}"`);
      epoch[name] = nanColumn(n);
    } else {
      epoch[name] = toFloat(raw[name], Float32Array, n, name);
    }
  }

  const names = featureNames(manifest, raw);
  epoch.features = {};
  epoch.shap = {};
  for (const f of names) {
    if (!raw.features?.[f]) throw new Error(`missing features["${f}"]`);
    if (!raw.shap?.[f]) throw new Error(`missing shap["${f}"]`);
    epoch.features[f] = toFloat(raw.features[f], Float32Array, n, `features.${f}`);
    epoch.shap[f] = toFloat(raw.shap[f], Float32Array, n, `shap.${f}`);
  }

  epoch.index = new Map();
  for (let i = 0; i < n; i += 1) epoch.index.set(epoch.cell_id[i], i);

  const shapMaxAbs = {};
  for (const f of names) shapMaxAbs[f] = robustMaxAbs(epoch.shap[f]);
  epoch.stats = {
    lst_obs: columnStats(epoch.lst_obs),
    lst_pred: columnStats(epoch.lst_pred),
    resid_oof: columnStats(epoch.resid_oof),
    shapMaxAbs,
  };
  return epoch;
}
