/**
 * Message protocol of the scenario Web Worker (pure, testable without a real Worker).
 *
 *   {type: "model", modelRaw}                    compile (or clear) the surrogate model
 *   {type: "epoch", key, epoch}                  cache one slim epoch under `key`
 *   {type: "run", id, key, scenario, coupling, manifest}
 *        -> reply {id, result} (typed arrays listed in `transfer`) or {id, error}
 *
 * The worker keeps at most MAX_EPOCHS epochs (least recently used evicted). Baselines are
 * cached per epoch object inside lib/scenario.js, exactly as on the main thread.
 */
import { compileModel } from "./model.js";
import { runScenario } from "./scenario.js";

export const MAX_EPOCHS = 4;

/** Fresh worker state. */
export function createWorkerState() {
  return { model: null, epochs: new Map() };
}

/** Typed-array buffers of a result that can be transferred back without copying. */
export function resultTransferList(result) {
  if (!result) return [];
  const buffers = new Set();
  for (const key of ["indices", "baseline", "scenario", "delta", "applied", "applicableIndices", "deltaByCell"]) {
    const arr = result[key];
    if (ArrayBuffer.isView(arr) && arr.buffer instanceof ArrayBuffer) buffers.add(arr.buffer);
  }
  return [...buffers];
}

/**
 * Handle one message. Returns `{reply, transfer}` for "run" messages and null otherwise.
 * Never throws: failures become `{reply: {id, error}}`.
 */
export function handleScenarioMessage(state, msg) {
  const type = msg?.type;
  try {
    if (type === "model") {
      state.model = msg.modelRaw ? compileModel(msg.modelRaw) : null;
      return null;
    }
    if (type === "epoch") {
      state.epochs.delete(msg.key);
      state.epochs.set(msg.key, msg.epoch);
      while (state.epochs.size > MAX_EPOCHS) state.epochs.delete(state.epochs.keys().next().value);
      return null;
    }
    if (type === "run") {
      const epoch = state.epochs.get(msg.key);
      if (!epoch) throw new Error(`scenario worker: epoch "${msg.key}" was not sent`);
      if (!state.model) throw new Error("scenario worker: the model is not loaded");
      // Mark as recently used.
      state.epochs.delete(msg.key);
      state.epochs.set(msg.key, epoch);
      const result = runScenario({
        epoch,
        model: state.model,
        coupling: msg.coupling ?? null,
        manifest: msg.manifest ?? null,
        scenario: msg.scenario,
      });
      return { reply: { id: msg.id, result }, transfer: resultTransferList(result) };
    }
    return type === undefined ? null : { reply: { id: msg.id, error: `scenario worker: unknown message "${type}"` }, transfer: [] };
  } catch (error) {
    return { reply: { id: msg?.id, error: String(error?.message ?? error) }, transfer: [] };
  }
}
