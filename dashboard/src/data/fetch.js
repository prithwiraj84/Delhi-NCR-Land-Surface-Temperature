/**
 * Byte-level fetch with progress, gzip sniffing and "missing file" detection, shared by the
 * main thread and the data worker (it has no DOM dependencies).
 *
 * - Bodies are streamed through `response.body.getReader()` when available so the boot log
 *   (UI_SPEC §3.1, `BundleStore.progress`) shows real bytes; `Content-Length` (when the server
 *   sends it) gives the total. With `Content-Encoding: gzip` the browser reports compressed
 *   Content-Length but hands over inflated bytes, so `loaded` may exceed `total`; consumers
 *   clamp the fraction.
 * - A 404, or an HTML page served by an SPA fallback for a missing file, is a DataLoadError with
 *   `status: "missing"` so optional resources become `unavailable` instead of `error`.
 * - Payloads are inflated when they start with the gzip magic bytes (never by file name).
 */

import { DataLoadError, isGzipBytes } from "../lib/data.js";
import { gunzipBytes } from "./lstb.js";

/** True when bytes look like an HTML document (SPA fallback page for a missing file). */
export function looksLikeHtmlBytes(bytes, contentType = "") {
  if (String(contentType).includes("text/html")) return true;
  if (!bytes || bytes.length < 5) return false;
  let i = 0;
  while (i < bytes.length && i < 64 && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i += 1;
  if (bytes[i] !== 0x3c) return false; // "<"
  const head = new TextDecoder("utf-8").decode(bytes.subarray(i, Math.min(bytes.length, i + 16))).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

async function readStream(response, onProgress, total) {
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch a URL as bytes.
 * @param {string} url
 * @param {{fetchImpl?: Function, onProgress?: ({loaded:number,total:number|null}) => void,
 *          signal?: AbortSignal, binary?: boolean}} [options]
 *   `binary` only changes the Accept header.
 * @returns {Promise<{bytes: Uint8Array, contentType: string, httpStatus: number, compressedBytes: number}>}
 * @throws {DataLoadError} status "missing" (404 / HTML fallback) or "error"
 */
export async function fetchBytes(url, { fetchImpl = globalThis.fetch, onProgress = null, signal = undefined, binary = false } = {}) {
  if (typeof fetchImpl !== "function") throw new DataLoadError("fetch() is unavailable in this environment", { url });
  let response;
  try {
    response = await fetchImpl(url, {
      signal,
      headers: { Accept: binary ? "application/octet-stream, application/gzip, */*;q=0.8" : "application/json, application/gzip;q=0.9, */*;q=0.8" },
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new DataLoadError(`Network error while fetching ${url}: ${cause?.message ?? cause}`, { url, cause });
  }
  if (!response.ok) {
    const missing = response.status === 404;
    throw new DataLoadError(
      missing ? `Not found: ${url} (HTTP 404)` : `Failed to fetch ${url} (HTTP ${response.status} ${response.statusText ?? ""})`.trim(),
      { status: missing ? "missing" : "error", url, httpStatus: response.status },
    );
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  const lengthHeader = Number(response.headers?.get?.("content-length"));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
  let bytes;
  try {
    if (response.body && typeof response.body.getReader === "function") bytes = await readStream(response, onProgress, total);
    else {
      bytes = new Uint8Array(await response.arrayBuffer());
      onProgress?.({ loaded: bytes.byteLength, total: total ?? bytes.byteLength });
    }
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new DataLoadError(`Could not read ${url}: ${cause?.message ?? cause}`, { url, cause });
  }
  if (looksLikeHtmlBytes(bytes, contentType)) {
    throw new DataLoadError(`Expected data at ${url} but received an HTML page (file probably missing).`, {
      status: "missing",
      url,
      httpStatus: response.status,
    });
  }
  return { bytes, contentType, httpStatus: response.status, compressedBytes: bytes.byteLength };
}

/** Inflate when gzip (magic bytes), else return the bytes unchanged. Errors become DataLoadError. */
export async function inflateBytes(bytes, url = null) {
  if (!isGzipBytes(bytes)) return bytes;
  try {
    return await gunzipBytes(bytes);
  } catch (cause) {
    throw new DataLoadError(`Could not decompress ${url ?? "payload"}: ${cause?.message ?? cause}`, { url, cause });
  }
}

/** Parse JSON from (possibly gzip) bytes. */
export async function parseJsonBytes(bytes, url = null) {
  const inflated = await inflateBytes(bytes, url);
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(inflated));
  } catch (cause) {
    throw new DataLoadError(`Invalid JSON in ${url ?? "payload"}: ${cause.message}`, { url, cause });
  }
}

/** Fetch + inflate + parse a JSON file (gzip or plain). */
export async function fetchJsonFile(url, options = {}) {
  const { bytes } = await fetchBytes(url, options);
  return parseJsonBytes(bytes, url);
}
