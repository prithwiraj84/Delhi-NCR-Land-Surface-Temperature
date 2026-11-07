/**
 * Boot-sequence model (UI_SPEC §3.1): normalises the data layer's loader progress
 * (`BundleStore.progress`, exposed by DataContext/useData) into log lines, decides whether
 * the cinematic acquisition plays, and formats the footer. Pure and unit-tested.
 *
 * Accepted progress shapes (the data layer may evolve; all map to the same lines):
 *   [{file|key|id|name|url, label?, status, loaded|bytes|received, total|size, ms|duration, deferred?}]
 *   {files|items|entries: [...]}
 *   {"manifest.json": {status, loaded, total, ms}, ...}
 */
import { fmtBytes, fmtInt, fmtMs } from "../lib/format.js";

export const BOOT_SESSION_KEY = "ncr-ops.boot-played";
export const BOOT_MIN_MS = 1600;
export const BOOT_MAX_MS = 2400;

const STATUS_MAP = Object.freeze({
  ok: "ok",
  done: "ok",
  ready: "ok",
  loaded: "ok",
  complete: "ok",
  cached: "ok",
  error: "error",
  failed: "error",
  missing: "missing",
  unavailable: "missing",
  queued: "queued",
  deferred: "queued",
  idle: "queued",
  pending: "queued",
  waiting: "queued",
  loading: "loading",
  streaming: "loading",
  fetching: "loading",
  decoding: "loading",
});

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function entriesOf(progress) {
  if (!progress) return [];
  if (Array.isArray(progress)) return progress;
  if (typeof progress !== "object") return [];
  for (const key of ["files", "items", "entries", "log"]) if (Array.isArray(progress[key])) return progress[key];
  return Object.entries(progress)
    .filter(([, v]) => v && typeof v === "object")
    .map(([file, v]) => ({ file, ...v }));
}

/**
 * Normalise loader progress to log lines.
 * @returns {Array<{file: string, label: string, status: "ok"|"loading"|"queued"|"error"|"missing",
 *          loaded: number|null, total: number|null, ms: number|null, fraction: number|null, note: string|null}>}
 */
export function normalizeProgress(progress) {
  return entriesOf(progress)
    .map((e) => {
      const file = String(e.file ?? e.key ?? e.id ?? e.name ?? e.url ?? "").split("/").pop();
      if (!file) return null;
      const raw = String(e.status ?? (e.done ? "ok" : e.error ? "error" : "loading")).toLowerCase();
      const status = e.deferred && raw !== "ok" ? "queued" : STATUS_MAP[raw] ?? "loading";
      const loaded = num(e.loaded ?? e.bytes ?? e.received);
      const total = num(e.total ?? e.size ?? e.contentLength);
      const fraction = status === "ok" ? 1 : loaded !== null && total ? Math.max(0, Math.min(1, loaded / total)) : null;
      return {
        file,
        label: e.label ?? file,
        status,
        loaded,
        total,
        ms: num(e.ms ?? e.duration ?? e.elapsed),
        fraction,
        note: e.deferred ? "deferred to idle" : e.note ?? (typeof e.error === "string" ? e.error : null),
      };
    })
    .filter(Boolean);
}

/** Overall fraction 0..1 over lines that are not queued (null when unknown). */
export function overallFraction(lines) {
  const active = lines.filter((l) => l.status !== "queued");
  if (!active.length) return null;
  const known = active.filter((l) => l.fraction !== null);
  if (!known.length) return null;
  return known.reduce((s, l) => s + l.fraction, 0) / active.length;
}

/** Right-hand text of a log line ("ok   22 KB · 140 ms", "71 %  0.43 / 0.61 MB", "queued"). */
export function lineStatusText(line) {
  if (line.status === "ok") return ["ok", line.loaded !== null ? fmtBytes(line.loaded) : null, line.ms !== null ? fmtMs(line.ms) : null].filter(Boolean).join("  ");
  if (line.status === "error") return `error${line.note ? ` · ${line.note}` : ""}`;
  if (line.status === "missing") return "not in bundle";
  if (line.status === "queued") return line.note ?? "queued";
  if (line.fraction !== null) return `${Math.round(line.fraction * 100)} %  ${fmtBytes(line.loaded)} / ${fmtBytes(line.total)}`;
  return line.loaded ? `${fmtBytes(line.loaded)}…` : "loading…";
}

/** Synthetic lines when the data layer exposes no progress (status only). */
export function fallbackLines(status) {
  if (status === "ready") return [{ file: "manifest.json", label: "manifest.json", status: "ok", loaded: null, total: null, ms: null, fraction: 1, note: null }];
  if (status === "error") return [{ file: "manifest.json", label: "manifest.json", status: "error", loaded: null, total: null, ms: null, fraction: null, note: null }];
  if (status === "empty") return [{ file: "manifest.json", label: "manifest.json", status: "missing", loaded: null, total: null, ms: null, fraction: null, note: null }];
  return [{ file: "manifest.json", label: "manifest.json", status: "loading", loaded: null, total: null, ms: null, fraction: null, note: null }];
}

/**
 * Whether the cinematic acquisition should play: Full motion, first load this session.
 * `storage` is injectable for tests; storage errors (private mode) mean "play, don't remember".
 */
export function shouldPlayCinematic(level, storage = globalThis.sessionStorage) {
  if (level !== "full") return false;
  try {
    return storage?.getItem(BOOT_SESSION_KEY) !== "1";
  } catch {
    return true;
  }
}

export function rememberCinematic(storage = globalThis.sessionStorage) {
  try {
    storage?.setItem(BOOT_SESSION_KEY, "1");
  } catch {
    // storage blocked: the sequence may replay next load, which is acceptable
  }
}

/**
 * Footer line: "55,150 cells · 1 km · 250 m · 1990 ─ 2050 · REAL · GEE".
 * @param {{nCells?: number, gridRes?: number, fineRes?: number, years?: number[], dataMode?: string}} meta
 */
export function bootFooter(meta) {
  const parts = [];
  if (Number.isFinite(meta?.nCells)) parts.push(`${fmtInt(meta.nCells)} cells`);
  if (Number.isFinite(meta?.gridRes)) parts.push(meta.gridRes >= 1000 ? `${meta.gridRes / 1000} km` : `${meta.gridRes} m`);
  if (Number.isFinite(meta?.fineRes)) parts.push(`${meta.fineRes} m`);
  if (meta?.years?.length) parts.push(`${meta.years[0]} ─ ${meta.years.at(-1)}`);
  if (meta?.dataMode === "synthetic") parts.push("SYNTHETIC · DEMO");
  else if (meta?.dataMode) parts.push(`REAL · ${String(meta.dataMode).toUpperCase()}`);
  return parts.join(" · ");
}
