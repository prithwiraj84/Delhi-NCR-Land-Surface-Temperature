/**
 * Web Worker entry for the scenario engine: keeps the compiled surrogate model and the epochs'
 * feature columns off the main thread, so re-predicting ~55k cells (a few hundred ms) never
 * blocks input or deck.gl rendering. Protocol: see scenarioWorkerCore.js.
 */
import { createWorkerState, handleScenarioMessage } from "./scenarioWorkerCore.js";

const state = createWorkerState();

self.onmessage = (event) => {
  const out = handleScenarioMessage(state, event.data);
  if (out) self.postMessage(out.reply, out.transfer);
};
