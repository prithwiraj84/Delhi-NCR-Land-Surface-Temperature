/**
 * Scenario engine client + worker protocol (DASH-05): results computed through the (simulated)
 * worker equal the main-thread results, epochs are sent once, replies are matched by id and a
 * crashing worker falls back to the main thread.
 */
import { describe, it, expect } from "vitest";
import { ScenarioEngine, slimEpoch } from "../scenarioEngine.js";
import { createWorkerState, handleScenarioMessage, MAX_EPOCHS } from "../scenarioWorkerCore.js";
import { runScenario, SCENARIO_PRESETS } from "../scenario.js";
import { compileModel } from "../model.js";
import { prepareEpoch } from "../data.js";
import { fixture } from "./testUtils.js";

const manifest = fixture("manifest.json");
const coupling = fixture("scenario_coupling.json");
const modelRaw = fixture("model_web.json");
const model = compileModel(modelRaw);
const epoch2025 = prepareEpoch(fixture("epoch_2025.json"), manifest);
const epoch2020 = prepareEpoch(fixture("epoch_2020.json"), manifest);

/** In-process stand-in for a module Worker: structured-clones messages like the real thing. */
function fakeWorkerFactory(log, { crashOnRun = false } = {}) {
  return () => {
    const state = createWorkerState();
    const worker = {
      onmessage: null,
      onerror: null,
      terminated: false,
      postMessage(msg) {
        log.push(msg.type);
        const copy = structuredClone(msg);
        setTimeout(() => {
          if (worker.terminated) return;
          if (crashOnRun && copy.type === "run") {
            worker.onerror?.({ message: "boom", preventDefault() {} });
            return;
          }
          const out = handleScenarioMessage(state, copy);
          if (out) worker.onmessage?.({ data: structuredClone(out.reply) });
        }, 0);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    return worker;
  };
}

const scenario = SCENARIO_PRESETS[0].scenario;
const args = (epoch, s = scenario) => ({ epoch, model, modelRaw, coupling, manifest, scenario: s });

describe("ScenarioEngine", () => {
  it("returns the same result through the worker as on the main thread, sending each epoch once", async () => {
    const log = [];
    const engine = new ScenarioEngine({ workerFactory: fakeWorkerFactory(log) });
    expect(engine.usesWorker).toBe(true);
    const viaWorker = await engine.run(args(epoch2025));
    const direct = runScenario({ epoch: epoch2025, model, coupling, manifest, scenario });
    expect(Array.from(viaWorker.indices)).toEqual(Array.from(direct.indices));
    viaWorker.delta.forEach((d, j) => expect(d).toBeCloseTo(direct.delta[j], 12));
    expect(viaWorker.stats.mean).toBeCloseTo(direct.stats.mean, 12);
    expect(viaWorker.epochYear).toBe(2025);

    await engine.run(args(epoch2025, { ...scenario, delta: 0.1 }));
    await engine.run(args(epoch2020));
    expect(log.filter((t) => t === "model")).toHaveLength(1);
    expect(log.filter((t) => t === "epoch")).toHaveLength(2);
    expect(log.filter((t) => t === "run")).toHaveLength(3);
    engine.dispose();
  });

  it("matches concurrent replies to their requests", async () => {
    const engine = new ScenarioEngine({ workerFactory: fakeWorkerFactory([]) });
    const [a, b] = await Promise.all([
      engine.run(args(epoch2025, { ...scenario, delta: 0.05 })),
      engine.run(args(epoch2025, { ...scenario, delta: 0.3 })),
    ]);
    expect(a.stats.requested).toBeCloseTo(0.05, 12);
    expect(b.stats.requested).toBeCloseTo(0.3, 12);
    engine.dispose();
  });

  it("rejects with the worker's error message", async () => {
    const engine = new ScenarioEngine({ workerFactory: fakeWorkerFactory([]) });
    await expect(engine.run(args(epoch2025, { ...scenario, feature: "nope" }))).rejects.toThrow(/not a model feature/);
    engine.dispose();
  });

  it("falls back to the main thread when the worker crashes or is unavailable", async () => {
    const engine = new ScenarioEngine({ workerFactory: fakeWorkerFactory([], { crashOnRun: true }) });
    const res = await engine.run(args(epoch2025));
    expect(res.stats.count).toBe(4);
    expect(engine.usesWorker).toBe(false);

    const none = new ScenarioEngine({ workerFactory: null });
    expect(none.usesWorker).toBe(false);
    expect((await none.run(args(epoch2025))).stats.count).toBe(4);
    expect(await none.run({ ...args(null) })).toBeNull();

    const throwing = new ScenarioEngine({
      workerFactory: () => {
        throw new Error("no module workers");
      },
    });
    expect(throwing.usesWorker).toBe(false);
  });

  it("the worker core evicts least recently used epochs and reports unknown epochs", () => {
    const state = createWorkerState();
    handleScenarioMessage(state, { type: "model", modelRaw });
    for (let k = 0; k < MAX_EPOCHS + 1; k += 1) {
      handleScenarioMessage(state, { type: "epoch", key: `e${k}`, epoch: slimEpoch(epoch2025) });
    }
    expect(state.epochs.size).toBe(MAX_EPOCHS);
    const missing = handleScenarioMessage(state, { type: "run", id: 7, key: "e0", scenario });
    expect(missing.reply).toEqual({ id: 7, error: expect.stringMatching(/was not sent/) });
    const ok = handleScenarioMessage(state, { type: "run", id: 8, key: "e4", scenario, coupling, manifest });
    expect(ok.reply.result.stats.count).toBe(4);
    expect(ok.transfer.length).toBeGreaterThan(0);
  });
});
