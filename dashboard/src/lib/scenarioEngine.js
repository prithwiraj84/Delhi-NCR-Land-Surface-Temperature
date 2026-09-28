/**
 * Main-thread client of the scenario engine.
 *
 * Runs `runScenario` in a Web Worker (scenario.worker.js) when the platform supports module
 * workers, so an NCR-wide re-prediction (~0.4-0.9 s at 55k cells) never freezes sliders or the
 * map. The worker receives the raw model once (it compiles its own copy) and each epoch's
 * feature columns once (structured-clone copies; the main thread keeps its arrays). Replies are
 * matched by request id; the caller drops superseded replies. Result typed arrays are
 * transferred back without copying.
 *
 * Fallback: without Worker support, without a raw model, or after the worker fails to start
 * or crashes, the same `runScenario` runs synchronously on the main thread (the pending
 * requests of a crashed worker are re-run that way), so results are identical either way.
 */
import { runScenario } from "./scenario.js";
import { MAX_EPOCHS } from "./scenarioWorkerCore.js";

let epochCounter = 0;
const epochKeys = new WeakMap();

/** Stable per-object key for an epoch (epochs are immutable once prepared). */
function epochKey(epoch) {
  let key = epochKeys.get(epoch);
  if (!key) {
    epochCounter += 1;
    key = `epoch-${epoch.year}-${epochCounter}`;
    epochKeys.set(epoch, key);
  }
  return key;
}

/** Only what runScenario reads from an epoch (drops SHAP, coordinates, index Map, stats). */
export function slimEpoch(epoch) {
  return {
    year: epoch.year,
    n: epoch.n,
    cell_size_m: epoch.cell_size_m,
    epoch_mean: epoch.epoch_mean,
    district: epoch.district,
    zone: epoch.zone,
    features: epoch.features,
  };
}

/** Only what runScenario reads from the manifest. */
export function slimManifest(manifest) {
  if (!manifest) return null;
  return { features: manifest.features, districts: manifest.districts, target_mode: manifest.target_mode };
}

/** Module worker for the browser build (null where Worker is unavailable, e.g. Node tests). */
export function defaultWorkerFactory() {
  if (typeof Worker !== "function") return null;
  return new Worker(new URL("./scenario.worker.js", import.meta.url), { type: "module", name: "lst-scenario" });
}

export class ScenarioEngine {
  /** @param {{workerFactory?: (() => Worker|null) | null}} [options] */
  constructor({ workerFactory = defaultWorkerFactory } = {}) {
    this.pending = new Map();
    this.nextId = 1;
    this.sentEpochs = [];
    this.sentModel = undefined;
    this.worker = null;
    try {
      this.worker = workerFactory ? workerFactory() : null;
    } catch (error) {
      console.warn("[scenario] Web Worker unavailable, running on the main thread", error);
      this.worker = null;
    }
    if (this.worker) {
      this.worker.onmessage = (event) => this.onMessage(event.data);
      this.worker.onerror = (event) => this.fail(event);
      this.worker.onmessageerror = (event) => this.fail(event);
    }
  }

  /** True while scenarios run off the main thread. */
  get usesWorker() {
    return Boolean(this.worker);
  }

  runSync({ epoch, model, coupling = null, manifest = null, scenario }) {
    return runScenario({ epoch, model, coupling, manifest, scenario });
  }

  /** Worker failed (module load error or crash): switch to the main thread and re-run pending requests. */
  fail(event) {
    event?.preventDefault?.();
    console.warn("[scenario] worker failed, falling back to the main thread:", event?.message ?? event);
    try {
      this.worker?.terminate?.();
    } catch (_error) {
      // already gone
    }
    this.worker = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      try {
        p.resolve(this.runSync(p.args));
      } catch (error) {
        p.reject(error);
      }
    }
  }

  onMessage(data) {
    const p = this.pending.get(data?.id);
    if (!p) return;
    this.pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.result ?? null);
  }

  /** Mirror of the worker's LRU epoch cache: send the epoch unless the worker still holds it. */
  ensureEpoch(epoch) {
    const key = epochKey(epoch);
    const at = this.sentEpochs.indexOf(key);
    if (at >= 0) {
      this.sentEpochs.splice(at, 1);
      this.sentEpochs.push(key);
      return key;
    }
    this.worker.postMessage({ type: "epoch", key, epoch: slimEpoch(epoch) });
    this.sentEpochs.push(key);
    while (this.sentEpochs.length > MAX_EPOCHS) this.sentEpochs.shift();
    return key;
  }

  /**
   * Run a scenario. Resolves to the runScenario result (or null when the epoch or model is
   * missing); rejects with the engine's error message.
   * @param {{epoch: object, model: object, modelRaw?: object|null, coupling?: object|null,
   *          manifest?: object|null, scenario: object}} args
   */
  run(args) {
    const { epoch, model, modelRaw = null, coupling = null, manifest = null, scenario } = args;
    if (!epoch || !model) return Promise.resolve(null);
    if (!this.worker || !modelRaw) {
      return new Promise((resolve) => resolve(this.runSync(args)));
    }
    if (this.sentModel !== modelRaw) {
      this.worker.postMessage({ type: "model", modelRaw });
      this.sentModel = modelRaw;
    }
    const key = this.ensureEpoch(epoch);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, args });
      this.worker.postMessage({ type: "run", id, key, scenario, coupling, manifest: slimManifest(manifest) });
    });
  }

  /** Stop the worker; pending requests resolve to null. */
  dispose() {
    try {
      this.worker?.terminate?.();
    } catch (_error) {
      // ignore
    }
    this.worker = null;
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
  }
}
