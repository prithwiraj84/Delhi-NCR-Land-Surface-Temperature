/**
 * Constants shared by the scenario worker (scenarioWorkerCore.js) and its main-thread client
 * (scenarioEngine.js). Kept in a dependency-free module so the client can mirror the worker's
 * epoch LRU without importing the scenario engine itself into the initial bundle.
 */

/** Epochs the worker keeps cached (least recently used evicted); the client mirrors this LRU. */
export const MAX_EPOCHS = 4;
