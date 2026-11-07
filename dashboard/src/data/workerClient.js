/**
 * Main-thread client of the data worker with an inline fallback.
 *
 * `createWorkerClient()` starts the module worker lazily on the first request. If `Worker` is not
 * available (Node tests, very old browsers) or the worker fails to start, every op transparently
 * runs inline through the same `runWorkerOp` code, so behaviour is identical either way.
 * A custom `fetchImpl` (in-memory fixture bundle) cannot cross into the worker; those requests
 * always run inline.
 */

import { DataLoadError } from "../lib/data.js";
import { runWorkerOp } from "./workerOps.js";

function reviveError(e) {
  return new DataLoadError(e?.message ?? "data worker failed", { status: e?.status ?? "error", url: e?.url ?? null, httpStatus: e?.httpStatus ?? null });
}

/** Absolute URL (workers resolve relative URLs against the worker script, not the page). */
function absoluteUrl(url) {
  try {
    return typeof location !== "undefined" ? new URL(url, location.href).href : url;
  } catch (_error) {
    return url;
  }
}

/**
 * @param {{fetchImpl?: Function|null, workerFactory?: (() => Worker)|null}} [options]
 *   `fetchImpl` non-null forces inline execution with that fetch; `workerFactory: null` disables
 *   the worker (tests).
 */
export function createWorkerClient({ fetchImpl = null, workerFactory } = {}) {
  const factory =
    workerFactory !== undefined
      ? workerFactory
      : typeof Worker === "function"
        ? () => new Worker(new URL("./dataWorker.js", import.meta.url), { type: "module" })
        : null;
  let worker = null;
  let broken = !factory || fetchImpl !== null;
  let nextId = 1;
  const pending = new Map();

  const failAll = (reason) => {
    for (const [, p] of pending) p.reject(reason);
    pending.clear();
  };

  function ensureWorker() {
    if (broken) return null;
    if (worker) return worker;
    try {
      worker = factory();
    } catch (error) {
      console.warn("[data] worker unavailable, decoding on the main thread:", error?.message ?? error);
      broken = true;
      return null;
    }
    worker.onmessage = (event) => {
      const { id, type } = event.data ?? {};
      const p = pending.get(id);
      if (!p) return;
      if (type === "progress") p.onProgress?.({ loaded: event.data.loaded, total: event.data.total });
      else if (type === "result") {
        pending.delete(id);
        p.resolve(event.data.result);
      } else if (type === "error") {
        pending.delete(id);
        p.reject(reviveError(event.data.error));
      }
    };
    worker.onerror = (event) => {
      // A module worker that cannot load (CSP, bundler issue) fires `error` before any message.
      console.warn("[data] worker error, falling back to main-thread decoding:", event?.message ?? event);
      event?.preventDefault?.();
      broken = true;
      const retry = [...pending.values()];
      pending.clear();
      try {
        worker.terminate();
      } catch (_error) {
        // already gone
      }
      worker = null;
      for (const p of retry) runInline(p.op, p.args, p.onProgress).then(p.resolve, p.reject);
    };
    return worker;
  }

  async function runInline(op, args, onProgress) {
    const { result } = await runWorkerOp(op, args, { fetchImpl: fetchImpl ?? globalThis.fetch, onProgress });
    return result;
  }

  /**
   * Run an op; resolves with its result object.
   * @param {string} op
   * @param {object} args
   * @param {{onProgress?: Function, transfer?: Transferable[]}} [options]
   */
  function run(op, args, { onProgress = null, transfer = [] } = {}) {
    const w = ensureWorker();
    if (!w) return runInline(op, args, onProgress);
    const id = nextId;
    nextId += 1;
    const message = { id, op, args: args?.url ? { ...args, url: absoluteUrl(args.url) } : args };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress, op, args: message.args });
      try {
        w.postMessage(message, transfer);
      } catch (error) {
        pending.delete(id);
        runInline(op, args, onProgress).then(resolve, reject);
        console.warn("[data] postMessage failed, decoding inline:", error?.message ?? error);
      }
    });
  }

  function dispose() {
    failAll(new DataLoadError("data worker disposed", { status: "error" }));
    if (worker) {
      try {
        worker.terminate();
      } catch (_error) {
        // ignore
      }
    }
    worker = null;
  }

  return {
    run,
    dispose,
    get usesWorker() {
      return Boolean(worker) && !broken;
    },
  };
}
