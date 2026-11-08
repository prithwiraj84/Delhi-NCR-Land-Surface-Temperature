// @vitest-environment jsdom
/**
 * Render, keyboard and accessibility tests of the Control chrome (E4: MissionControl, time
 * ribbon, telemetry, frame card, layer dock, legend, toolbar, inspector, compare, Briefing)
 * through the REAL data layer on both bundle generations:
 *   - the in-memory synthetic v2 fixture, and
 *   - the user's real v1 bundle in public/data (read-only; skipped when absent).
 * axe runs without colour contrast (jsdom has no layout; contrast is asserted numerically in
 * design/tokens.test.js) and without the page-level `region` rule (the view is mounted alone).
 */
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { createBundleStore } from "../../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../../data/fixtures/synthV2.js";
import { createFsFetch, PUBLIC_DATA_DIR, PUBLIC_DEMO_DIR, publicDataIsV1, publicDemoExists } from "../../lib/__tests__/testUtils.js";
import { DataProvider } from "../../state/DataContext.jsx";
import { useSelectionStore } from "../../state/stores/selectionStore.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { useAnnouncerStore } from "../../shell/announcer.js";
import { MissionControl } from "./MissionControl.jsx";

expect.extend(matchers);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const axe = configureAxe({ rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
const IGNORED_ERRORS = /not implemented: HTMLCanvasElement|not wrapped in act/i;

let errorSpy;
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  document.documentElement.dataset.motion = "off"; // deterministic: no tweens in jsdom
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function settle(ms = 30, rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

function setWidth(px) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  window.dispatchEvent(new Event("resize"));
}

async function mount(store) {
  const host = document.createElement("div");
  host.style.position = "relative";
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(h(DataProvider, { store, autoLoad: false }, h("main", null, h(MissionControl))));
  });
  await settle();
  return { host, root };
}

const press = async (el, key, extra = {}) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  });
  await settle(20, 4);
};

/** Run a synchronous store mutation inside act() so React flushes the resulting commit. */
const actNow = async (fn) => {
  await act(async () => {
    fn();
  });
};

const click = async (el) => {
  await act(async () => {
    el.click();
  });
  await settle(20, 4);
};

function consoleErrors() {
  return errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => !IGNORED_ERRORS.test(m));
}

function suite(label, makeStore, { v1 = false } = {}) {
  describe(label, () => {
    let store;
    beforeAll(async () => {
      useTimeStore.getState().reset();
      useSelectionStore.getState().clear();
      useViewStore.getState().reset();
      store = await makeStore();
      expect(store.getState().status).toBe("ready");
      useTimeStore.getState().configure(store.getState().timeline);
      errorSpy = vi.spyOn(console, "error");
    }, 180000);
    afterAll(() => errorSpy?.mockRestore());

    it("renders the desktop chrome with manifest tiers, a signed UHI and no serious axe violations", async () => {
      setWidth(1440);
      errorSpy.mockClear();
      const { host, root } = await mount(store);
      const tl = store.getState().timeline;
      expect(host.querySelector('[data-testid="telemetry-strip"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="layer-dock"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="thermal-legend"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="frame-card"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="inspector"]')).toBeTruthy();
      const slider = host.querySelector('[data-testid="time-ribbon"] [role="slider"]');
      expect(slider.getAttribute("aria-valuemin")).toBe(String(tl.first));
      expect(slider.getAttribute("aria-valuemax")).toBe(String(tl.last));
      expect(slider.getAttribute("aria-valuetext")).toMatch(new RegExp(`^${tl.now}, observed, day, NCR mean \\d+\\.\\d °C`));
      // Surface UHI telemetry is signed: the daytime UHI is negative on both bundles.
      const uhi = [...host.querySelectorAll('[data-testid="telemetry-strip"] [data-status]')].find((el) => /Surface UHI/.test(el.textContent));
      expect(uhi.textContent).toMatch(/−\d+\.\d/);
      const results = await axe(host);
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 140)}`)).toEqual([]);
      expect(consoleErrors()).toEqual([]);
      await act(async () => root.unmount());
    }, 90000);

    it("the ribbon owns the arrow keys: step frames, jump tiers, nudge years; snap is announced", async () => {
      setWidth(1440);
      const { host, root } = await mount(store);
      const tl = store.getState().timeline;
      const slider = host.querySelector('[data-testid="time-ribbon"] [role="slider"]');
      await actNow(() => useTimeStore.getState().setYear(tl.years[1]));
      await settle(20, 3);
      await press(slider, "ArrowRight");
      expect(useTimeStore.getState().year).toBe(tl.years[2]);
      await press(slider, "ArrowLeft");
      expect(useTimeStore.getState().year).toBe(tl.years[1]);
      await press(slider, "ArrowUp");
      expect(useTimeStore.getState().year).toBe(tl.years[1] + 1);
      expect(slider.getAttribute("aria-valuetext")).toMatch(/interpolated between/);
      await press(slider, "End");
      expect(useTimeStore.getState().year).toBe(tl.last);
      await press(slider, "Home");
      expect(useTimeStore.getState().year).toBe(tl.first);
      await settle(120, 6); // announcer debounce 500 ms
      expect(useAnnouncerStore.getState().polite).toMatch(new RegExp(`^${tl.first}, `));
      await actNow(() => useTimeStore.getState().setYear(tl.now));
      await act(async () => root.unmount());
    }, 60000);

    it("unavailable layers stay visible with their reason; the dock is one radio group", async () => {
      setWidth(1440);
      const { host, root } = await mount(store);
      const radios = [...host.querySelectorAll('[data-testid="layer-dock"] [role="radiogroup"][aria-label="Map layer"] [role="radio"]')];
      expect(radios).toHaveLength(9);
      expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
      const aoa = radios.find((r) => /AOA/.test(r.textContent));
      if (v1) {
        expect(aoa.getAttribute("aria-disabled")).toBe("true");
        expect(host.querySelector(`#${aoa.getAttribute("aria-describedby")}`).textContent).toMatch(/rerun notebook v2/);
      } else expect(aoa.getAttribute("aria-disabled")).toBeNull();
      await act(async () => root.unmount());
    }, 60000);

    it("H pins the hottest cell and the inspector shows the district and the cell", async () => {
      setWidth(1440);
      const { host, root } = await mount(store);
      await act(async () => {
        window.dispatchEvent(new CustomEvent("ncr:probe-hottest"));
      });
      await settle(40, 10);
      const pinned = useSelectionStore.getState().pinnedIndex;
      expect(Number.isInteger(pinned)).toBe(true);
      const inspector = host.querySelector('[data-testid="inspector"]');
      expect(inspector.textContent).toMatch(/District/);
      expect(inspector.textContent).toMatch(/Cell/);
      expect(inspector.textContent).toMatch(/Obs/);
      await actNow(() => useSelectionStore.getState().clear());
      await act(async () => root.unmount());
    }, 60000);

    it("compare: a divider with role=separator moves 2 % per arrow key", async () => {
      setWidth(1440);
      const tl = store.getState().timeline;
      useTimeStore.getState().setCompare({ kind: "y", a: tl.first, b: tl.last });
      const { host, root } = await mount(store);
      const sep = host.querySelector('[role="separator"]');
      expect(sep).toBeTruthy();
      expect(host.querySelector('[data-testid="compare-chips"]')).toBeTruthy();
      await actNow(() => useTimeStore.getState().setCompare({ splitPx: 500 }));
      await settle(20, 2);
      await actNow(() => useTimeStore.getState().setCompare(null));
      await settle(20, 2);
      expect(host.querySelector('[role="separator"]')).toBeNull();
      await act(async () => root.unmount());
    }, 60000);

    it("the Briefing is keyboard-completable and reads the daytime UHI as negative", async () => {
      setWidth(1440);
      const { host, root } = await mount(store);
      await act(async () => useViewStore.getState().startBriefing(0));
      await settle(40, 10);
      const card = () => host.querySelector('[data-testid="briefing"]');
      expect(card()).toBeTruthy();
      const texts = [];
      for (let i = 0; i < 9; i += 1) {
        texts.push(card().textContent);
        await press(card(), "ArrowRight");
        await settle(30, 4);
        if (useTimeStore.getState().playing) await actNow(() => useTimeStore.getState().pause());
      }
      expect(useViewStore.getState().briefing.active).toBe(false);
      const fringe = texts.find((t) => /Surface UHI \(urban − rural\) [−+]\d/.test(t) && /by day/.test(t));
      expect(fringe).toMatch(/−\d+\.\d °C by day: built-up land is cooler/);
      if (v1) expect(texts.join(" ")).toMatch(/Night is unavailable in this bundle/);
      else expect(texts.join(" ")).toMatch(/the island flips/);
      expect(consoleErrors()).toEqual([]);
      await actNow(() => {
        useTimeStore.getState().setCompare(null);
        useTimeStore.getState().setYear(store.getState().timeline.now);
        useViewStore.getState().reset();
      });
      await act(async () => root.unmount());
    }, 120000);

    it("mobile: tape ribbon, compact chrome and a bottom sheet once a cell is pinned", async () => {
      setWidth(390);
      const { host, root } = await mount(store);
      expect(host.querySelector('[data-variant="tape"] [role="slider"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="bottom-sheet"]')).toBeNull();
      await act(async () => useSelectionStore.getState().pin(0));
      await settle(30, 6);
      expect(host.querySelector('[data-testid="bottom-sheet"]')).toBeTruthy();
      const handle = host.querySelector('[data-testid="bottom-sheet"] button[aria-expanded]');
      await click(handle);
      expect(host.querySelector('[data-testid="bottom-sheet"]').getAttribute("data-snap")).toBe("half");
      const results = await axe(host);
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 140)}`)).toEqual([]);
      await actNow(() => {
        useSelectionStore.getState().clear();
        setWidth(1440);
      });
      await act(async () => root.unmount());
    }, 90000);
  });
}

suite("Control on the synthetic v2 fixture", async () => {
  const synth = createSynthV2();
  const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth) }) });
  await store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  return store;
});

if (publicDataIsV1()) {
  suite(
    "Control on the REAL v1 bundle (public/data)",
    async () => {
      const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DATA_DIR) });
      await store.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
      return store;
    },
    { v1: true },
  );
}

// The notebook's own synthetic v2 export (public/demo, after a local synthetic run).
if (publicDemoExists("manifest.json")) {
  suite("Control on the notebook's synthetic v2 demo bundle (public/demo)", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DEMO_DIR) });
    await store.getState().load({ source: { id: "demo", baseUrl: "/demo", explicit: true, reason: "test" } });
    return store;
  });
}
