// @vitest-environment jsdom
/**
 * Render + accessibility smoke tests of the analysis routes (E5: Timeline, Drivers, Zones,
 * Model Lab, Sources) against BOTH bundle generations through the real data layer:
 *   - the in-memory synthetic v2 fixture (src/data/fixtures/synthV2.js), and
 *   - the user's real v1 bundle in public/data (skipped when absent), and
 *   - the notebook's synthetic v2 demo bundle in public/demo (skipped when absent).
 * Each view must render without throwing or logging errors, show its H1, label every
 * v2-only panel on the v1 bundle as unavailable (with the "rerun notebook v2" reason), and
 * pass axe with no serious/critical violations (colour contrast is asserted numerically by
 * design/tokens.test.js; jsdom has no layout).
 */
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { createBundleStore } from "../../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../../data/fixtures/synthV2.js";
import { DataProvider } from "../../state/DataContext.jsx";
import { useSelectionStore } from "../../state/stores/selectionStore.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { createFsFetch, PUBLIC_DATA_DIR, PUBLIC_DEMO_DIR, publicDataIsV1, publicDemoExists } from "../../lib/__tests__/testUtils.js";
import { TimelineView } from "../timeline/TimelineView.jsx";
import { DriversView } from "../drivers/DriversView.jsx";
import { ZonesView } from "../zones/ZonesView.jsx";
import { ModelLab } from "../lab/ModelLab.jsx";
import { SourcesView } from "../sources/SourcesView.jsx";

expect.extend(matchers);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const axe = configureAxe({ rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
const VIEWS = [
  ["timeline", TimelineView, /1990|2010/],
  ["drivers", DriversView, /Why it is hot/],
  ["zones", ZonesView, /Governance zones/],
  ["lab", ModelLab, /How good is this model/],
  ["sources", SourcesView, /Where every number comes from/],
];

let errorSpy;
beforeAll(() => {
  // jsdom has no canvas, matchMedia or ResizeObserver; the views degrade gracefully without them.
  HTMLCanvasElement.prototype.getContext = () => null;
  window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.scrollTo = () => {};
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function settle(ms = 30, rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function renderView(store, Component, route) {
  useViewStore.getState().setRoute(route);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(h(DataProvider, { store, autoLoad: false }, h("main", null, h(Component))));
  });
  await settle();
  return { host, root };
}

function suite(label, makeStore, { v1 = false } = {}) {
  describe(label, () => {
    let store;
    beforeAll(async () => {
      useTimeStore.getState().reset();
      useSelectionStore.getState().clear();
      store = await makeStore();
      expect(store.getState().status).toBe("ready");
      useTimeStore.getState().configure(store.getState().timeline);
      errorSpy = vi.spyOn(console, "error");
    }, 120000);
    afterAll(() => errorSpy?.mockRestore());

    for (const [route, Component, heading] of VIEWS) {
      it(`renders ${route} with its heading, no console errors and no serious axe violations`, async () => {
        errorSpy.mockClear();
        const { host, root } = await renderView(store, Component, route);
        const h1 = host.querySelector("h1");
        expect(h1?.textContent ?? "").toMatch(heading);
        const results = await axe(host);
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
        const errors = errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => !/not implemented: HTMLCanvasElement|not wrapped in act/i.test(m));
        expect(errors).toEqual([]);
        // Zones and Sources are fully backed by a v1 bundle (day zones, data_sources lanes).
        if (v1 && route !== "sources" && route !== "zones") expect(host.textContent).toMatch(/rerun notebook v2|v1 bundle|v1 metric|Unavailable/i);
        await act(async () => root.unmount());
      }, 60000);
    }
  });
}

suite("synthetic v2 fixture", async () => {
  const synth = createSynthV2();
  const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth) }) });
  await store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  return store;
});

if (publicDataIsV1()) {
  suite(
    "real v1 bundle (public/data)",
    async () => {
      const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DATA_DIR) });
      await store.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
      return store;
    },
    { v1: true },
  );
}

// The synthetic v2 bundle written by the notebook itself (public/demo, from a local synthetic
// run): catches drift between the notebook's real export format and the in-memory fixture.
if (publicDemoExists("manifest.json")) {
  suite("synthetic v2 demo bundle written by the notebook (public/demo)", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DEMO_DIR) });
    await store.getState().load({ source: { id: "demo", baseUrl: "/demo", explicit: true, reason: "test" } });
    return store;
  });
}
