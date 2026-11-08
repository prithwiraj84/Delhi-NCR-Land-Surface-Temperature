// @vitest-environment jsdom
/**
 * Render tests of the v2 review fixes (F4) through the real data layer and the synthetic v2
 * fixture (with and without the optional review keys), plus the notebook demo / real v1 bundles
 * where present: inspector tier labels (T-F4-06) and Simulate (T-F4-12), engine-driven legend
 * (T-F4-02), FrameCard SSP range (T-F4-07), Key Figures vs the weather-normalised baseline
 * (T-F4-05 / T-F4-08 / T-F4-11), honest v1 → v2 copy (T-F4-13), zone display names and caveats
 * (T-F4-18), ledger header (T-F4-26), lab projection panels (T-F4-30).
 */
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBundleStore } from "../../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../../data/fixtures/synthV2.js";
import { normalizeSeries, scopeBaseline, scopeSeries } from "../../data/series.js";
import { buildTimeline, frameTierInfo } from "../../data/timeline.js";
import { DataProvider, useData } from "../../state/DataContext.jsx";
import { useSelectionStore } from "../../state/stores/selectionStore.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { createFsFetch, PUBLIC_DATA_DIR, PUBLIC_DEMO_DIR, publicDataIsV1, publicDemoExists } from "../../lib/__tests__/testUtils.js";
import { CellSummary } from "../control/inspector/CellSummary.jsx";
import { FrameCard } from "../control/FrameCard.jsx";
import { ThermalLegend } from "../control/ThermalLegend.jsx";
import { legendFromEngine, legendSpec } from "../control/layerModel.js";
import { KeyFigures } from "../timeline/KeyFigures.jsx";
import { DistrictLedger } from "../timeline/DistrictLedger.jsx";
import { ledgerRows, projectionAoa } from "../timeline/timelineModel.js";
import { HonestSkill } from "../lab/HonestSkill.jsx";
import { HindcastPanel } from "../lab/HindcastPanel.jsx";
import { UncertaintyBudget } from "../lab/UncertaintyBudget.jsx";
import { ZonesView } from "../zones/ZonesView.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let synCache = null;
let plainCache = null;
/** Shared fixtures (building one takes seconds). */
const SYN = () => (synCache ??= createSynthV2());
const SYN_PLAIN = () => (plainCache ??= createSynthV2({ optionalKeys: false }));
const SOURCE = { id: "fixture", baseUrl: null, explicit: true, reason: "test" };

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.scrollTo = () => {};
});

const roots = [];
afterEach(async () => {
  // Unmount every tree: a detached but mounted DataProvider keeps running effects and loads.
  await act(async () => {
    while (roots.length) roots.pop().unmount();
  });
  document.body.innerHTML = "";
});

async function settle(ms = 25, rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return { host, root };
}

async function fixtureStore(options = {}) {
  const synth = createSynthV2(options);
  const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth, { compress: false }) }) });
  await store.getState().load({ source: SOURCE });
  return { store, synth };
}

/** Index of a cell with finite values in both modes at `year`. */
async function finiteCell(store, year) {
  const day = (await store.getState().ensure("cube:day:obs")).data;
  const night = (await store.getState().ensure("cube:night:obs")).data;
  const fd = day.years.indexOf(year);
  const fn = night.years.indexOf(year);
  for (let i = 0; i < day.n; i += 1) {
    const a = day.columns.lst.raw[fd * day.n + i];
    const b = night.columns.lst.raw[fn * night.n + i];
    if (a !== -32768 && b !== -32768) return i;
  }
  return 0;
}

describe("inspector cell readout (T-F4-06) and Simulate (T-F4-12)", () => {
  let store;
  let tl;
  let manifest;
  beforeAll(async () => {
    ({ store } = await fixtureStore());
    tl = store.getState().timeline;
    manifest = store.getState().manifest;
  });

  const render = async (props) => {
    let data = null;
    const Probe = () => {
      data = useData();
      return null;
    };
    const out = await mount(h(DataProvider, { store, autoLoad: false }, h(Probe), h(CellSummary, { timeline: tl, manifest, ssp: "ssp245", ...props })));
    return { ...out, data: () => data };
  };
  const readout = (host) => host.querySelector("[data-testid=cell-readout] dt")?.textContent ?? "";

  it("night 1990 is modelled: not 'Obs', with the modelled glyph and the map/pred note", async () => {
    const i = await finiteCell(store, 1990);
    const { host } = await render({ index: i, t: 1990, mode: "night" });
    await settle();
    expect(readout(host)).toBe("Map (modelled)");
    expect(host.querySelector("[data-testid=cell-readout] [data-testid=tier-modelled]")).not.toBeNull();
    expect(host.textContent).toMatch(/the waterfall explains Pred/);
  });

  it("night 2005 is observed ('Obs'), night 2000 is 'Reconstructed'", async () => {
    const i = await finiteCell(store, 2005);
    const a = await render({ index: i, t: 2005, mode: "night" });
    await settle();
    expect(readout(a.host)).toBe("Obs");
    document.body.innerHTML = "";
    const j = await finiteCell(store, 2000);
    const b = await render({ index: j, t: 2000, mode: "night" });
    await settle();
    expect(readout(b.host)).toBe("Reconstructed");
  });

  it("DTR 2025 shows the DTR value labelled DTR, with day pred / resid", async () => {
    const i = await finiteCell(store, 2025);
    const { host } = await render({ index: i, t: 2025, mode: "dtr" });
    await settle();
    expect(readout(host)).toBe("DTR");
    expect(host.textContent).toMatch(/Day pred/);
    const day = (await store.getState().ensure("cube:day:obs")).data;
    const night = (await store.getState().ensure("cube:night:obs")).data;
    const f = day.years.indexOf(2025);
    const dtr = (day.columns.lst.raw[f * day.n + i] - night.columns.lst.raw[f * night.n + i]) * 0.01;
    const shown = Number(host.querySelector("[data-testid=cell-readout] dd").textContent);
    expect(shown).toBeCloseTo(dtr, 1);
  });

  it("Simulate sets the what-if region to the pinned cell's district and opens Drivers", async () => {
    useViewStore.getState().setRoute("control");
    const i = await finiteCell(store, 2025);
    const out = await render({ index: i, t: 2025, mode: "day" });
    await settle();
    const button = [...out.host.querySelectorAll("button")].find((b) => /Simulate/.test(b.textContent));
    await act(async () => button.click());
    await settle(10, 3);
    const district = store.getState().resources.cells.data.district[i];
    expect(out.data().scenario.region).toEqual({ type: "district", ids: [Number(district)] });
    expect(useViewStore.getState().route).toBe("drivers");
  });
});

describe("legend renders the engine channel (T-F4-02)", () => {
  it("shows lo / 0 / hi from the engine legend and the layer title", async () => {
    const synth = SYN();
    const timeline = buildTimeline(synth.manifest);
    const base = legendSpec({ layer: "resid", variable: "abs", mode: "day", timeline, xai: { resid: Float32Array.from([-9, 9]) } });
    const engine = { layer: "resid", mode: "day", variable: "abs", kind: "diverging", ramp: "polar", lo: -1.5, hi: 1.5, unit: "°C", stretched: false, crossFrame: false, domainYear: 2010, note: null, held: false };
    const spec = legendFromEngine(base, engine, { layer: "resid", mode: "day" });
    const { host } = await mount(h(ThermalLegend, { spec, mode: "day" }));
    expect(host.textContent).toMatch(/Residual: observed − OOF prediction/);
    expect(host.textContent).toMatch(/−1\.5/);
    expect(host.textContent).toMatch(/\+1\.5/);
    expect(host.textContent).toMatch(/scale from the 2010 frame, not fixed across frames/);
    expect(host.textContent).not.toMatch(/fixed all frames/);
    // The pred layer is always absolute, whatever the variable selector says.
    const pred = legendSpec({ layer: "pred", variable: "anom", mode: "day", timeline });
    expect(pred.title).toBe("Predicted LST (absolute)");
    expect(pred.signed).toBe(false);
    expect(pred.domain).toEqual(timeline.domains.day.abs);
  });

  it("projected LST: the uncertainty-shading switch hides the VSUP wedge when off and reports changes", async () => {
    const spec = { kind: "continuous", title: "LST", ramp: "solar", domain: [30, 58], unit: "°C", signed: false, fixed: true };
    const calls = [];
    const on = await mount(h(ThermalLegend, { spec, mode: "day", vsup: true, fog: true, onFogChange: (v) => calls.push(v) }));
    const sw = on.host.querySelector("[data-testid=fog-switch] [role=switch]");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(on.host.textContent).toMatch(/uncertainty \(p5–p95 half-width\)/);
    await act(async () => sw.click());
    expect(calls).toEqual([false]);
    const off = await mount(h(ThermalLegend, { spec, mode: "day", vsup: true, fog: false, onFogChange: () => {} }));
    expect(off.host.querySelector("[data-testid=fog-switch] [role=switch]").getAttribute("aria-checked")).toBe("false");
    expect(off.host.textContent).not.toMatch(/uncertainty \(p5–p95 half-width\)/);
    expect(off.host.textContent).toMatch(/Shading off/);
    // Observed frames (no onFogChange): no switch.
    const obs = await mount(h(ThermalLegend, { spec, mode: "day" }));
    expect(obs.host.querySelector("[data-testid=fog-switch]")).toBeNull();
  });
});

describe("FrameCard projected range follows the SSP (T-F4-07)", () => {
  it("prints 'NCR p5–p95 a–b' of the selected SSP, different per SSP", async () => {
    const synth = SYN();
    const tl = buildTimeline(synth.manifest);
    const texts = [];
    for (const ssp of ["ssp126", "ssp245", "ssp585"]) {
      const info = frameTierInfo(tl, 2050, "day", ssp);
      expect(info.ci_kind).toBe("p5–p95");
      expect(info.level_ci).toEqual([synth.manifest.timeline.frames.at(-1).day.by_scenario[ssp].p05, synth.manifest.timeline.frames.at(-1).day.by_scenario[ssp].p95]);
      const { host } = await mount(h(FrameCard, { year: 2050, tier: "projected", mode: "day", ci: info.level_ci, ciKind: info.ci_kind, sspLabel: ssp }));
      const t = host.querySelector("[data-testid=frame-uncertainty]").textContent;
      expect(t).toMatch(/^NCR p5–p95 \d+\.\d–\d+\.\d °C/);
      expect(t).not.toMatch(/±/);
      texts.push(t);
      document.body.innerHTML = "";
    }
    expect(new Set(texts).size).toBe(3);
  });
});

describe("Key Figures (T-F4-05 / T-F4-08 / T-F4-11)", () => {
  it("projected change is relative to the weather-normalised baseline; night change starts at 2000", async () => {
    const synth = SYN();
    const series = normalizeSeries(synth.files.get("timeline_series.json.gz")());
    const metrics = synth.files.get("metrics.json")();
    const day = scopeSeries(series, "ncr", "day");
    const night = scopeSeries(series, "ncr", "night");
    const aoa = { day: projectionAoa(metrics, "day", 2050, "ssp585"), night: projectionAoa(metrics, "night", 2050, "ssp585") };
    const { host } = await mount(h(KeyFigures, { day, night, now: 2025, last: 2050, ssps: ["ssp245", "ssp585"], selectedSsp: "ssp585", scopeLabel: "Delhi NCR", projections: true, harmonised: true, aoa }));
    const text = host.textContent;
    expect(text).toMatch(/Δ 2050 vs weather-normalised 2025 baseline \(p50\)/);
    expect(text).toMatch(new RegExp(`Baseline ${series.baselineLevel.day.toFixed(1)} °C`));
    expect(text).toMatch(/includes the 2024–26 weather anomaly/);
    const total = day.decomposition.ssp585["2050"].total;
    expect(text).toMatch(new RegExp(`day ${total >= 0 ? "\\+" : "−"}${Math.abs(total).toFixed(1)}`));
    expect(text).toMatch(/AOA 2050 · SSP5-8.5: \d+\s?% \(day\) · \d+\s?% \(night\) inside/);
    expect(text).toMatch(/2000 → 2025/); // night change from the first observed-evidence frame
    expect(text).toMatch(/1990 → 2025/); // day still from 1990 (observed-sparse)
  });

  it("non-harmonised levels show the guard instead of change numbers", async () => {
    const synth = SYN();
    const series = normalizeSeries(synth.files.get("timeline_series.json.gz")());
    const day = scopeSeries(series, "ncr", "day");
    const { host } = await mount(h(KeyFigures, { day, night: null, nightReason: "no night", now: 2025, last: 2025, ssps: [], selectedSsp: null, scopeLabel: "NCR", projections: false, harmonised: false }));
    expect(host.querySelector("[data-testid=levels-guard]").textContent).toMatch(/not harmonised/);
    expect(host.textContent).not.toMatch(/1990 → 2025/);
  });
});

describe("Model Lab copy (T-F4-13 / T-F4-30)", () => {
  it("HonestSkill states the exported numbers, the ablation and the synthetic caveat — no causal attribution", async () => {
    const synth = SYN();
    const metrics = synth.files.get("metrics.json")();
    metrics.modes.day.ablation = { scheme: "block20", base_only: { r2_pooled: 0.85 }, all_features: { r2_pooled: 0.86 }, gain_r2_pooled: 0.0104 };
    const { host } = await mount(h(HonestSkill, { metrics, schema: "v2", dataMode: "synthetic" }));
    const story = host.querySelector("[data-testid=v1v2-story]").textContent;
    expect(story).toMatch(/Same metric \(5×5 blocks, mean of folds\): 0\.62 → /);
    expect(story).toMatch(/Pooled scoring adds [+−]\d\.\d\d/);
    expect(story).toMatch(/Base-only ablation: the 14 focal features change block-20 pooled R² by \+0\.010/);
    expect(story).toMatch(/synthetic scores and are not comparable with the real v1 run/);
    expect(host.textContent).not.toMatch(/comes from the neighbourhood \(focal\) features/);
  });

  it("HindcastPanel shows the verdict and checks only when exported; UncertaintyBudget states the block correlation", async () => {
    const withKeys = SYN().files.get("metrics.json")();
    const a = await mount(h(HindcastPanel, { slice: withKeys.modes.day, metrics: withKeys, mode: "day" }));
    expect(a.host.querySelector("[data-testid=land-verdict]").textContent).toMatch(/mixed/);
    expect(a.host.textContent).toMatch(/quantity_disagreement <= null/);
    expect(a.host.textContent).toMatch(/extrapolated GHSL epoch/);
    document.body.innerHTML = "";
    const without = SYN_PLAIN().files.get("metrics.json")();
    const b = await mount(h(HindcastPanel, { slice: without.modes.day, metrics: without, mode: "day" }));
    expect(b.host.querySelector("[data-testid=land-verdict]")).toBeNull();
    expect(b.host.textContent).toMatch(/FoM beats the null/);
    document.body.innerHTML = "";
    const series = normalizeSeries(SYN().files.get("timeline_series.json.gz")());
    const ncr = scopeSeries(series, "ncr", "day");
    const c = await mount(h(UncertaintyBudget, { budget: ncr.uncertaintyBudget, ssps: ["ssp245"], year: 2050, scopeLabel: "NCR", rho: withKeys.modes.day.aoa.resid_rho_block20, mode: "day" }));
    const note = c.host.querySelector("[data-testid=budget-model-note]").textContent;
    expect(note).toMatch(/spatially correlated model error \(20 km blocks\) \(block correlation ρ = 0\.36, day\)/);
    expect(note).toMatch(/structural uncertainty of the land response is not included/);
  });
});

describe("zone display names and caveats (T-F4-18)", () => {
  it("night zone 1 shows its display name and a keyboard-reachable caveat; canonical ids/colours unchanged", async () => {
    const { store } = await fixtureStore();
    useTimeStore.getState().configure(store.getState().timeline);
    useTimeStore.getState().setMode("night");
    useViewStore.getState().setRoute("zones");
    const { host } = await mount(h(DataProvider, { store, autoLoad: false }, h("main", null, h(ZonesView))));
    await settle(40, 10);
    expect(host.textContent).toMatch(/Moderate mosaic \(no riparian signal\)/);
    const pip = host.querySelector("[data-testid=zone-label-caveat]");
    expect(pip).not.toBeNull();
    expect(pip.tagName).toBe("BUTTON");
    expect(pip.getAttribute("aria-label")).toMatch(/Named Riparian Buffer by the SPEC zone rule/);
    useTimeStore.getState().setMode("day");
  });

  it("a bundle without display_name renders the canonical names", async () => {
    const { store } = await fixtureStore({ optionalKeys: false });
    useTimeStore.getState().configure(store.getState().timeline);
    useTimeStore.getState().setMode("night");
    useViewStore.getState().setRoute("zones");
    const { host } = await mount(h(DataProvider, { store, autoLoad: false }, h("main", null, h(ZonesView))));
    await settle(40, 10);
    expect(host.textContent).toMatch(/Riparian Buffer/);
    expect(host.textContent).not.toMatch(/Moderate mosaic/);
    expect(host.querySelector("[data-testid=zone-label-caveat]")).toBeNull();
    useTimeStore.getState().setMode("day");
    useSelectionStore.getState().clear?.();
  });
});

describe.skipIf(!publicDataIsV1())("real v1 bundle (public/data, read-only)", () => {
  it("ledger: header from the first frame, no p50 column, Δ columns n/a (levels not harmonised)", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DATA_DIR) });
    await store.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
    const tl = store.getState().timeline;
    const series = (await store.getState().ensure("series")).data;
    const rows = ledgerRows(series, { now: tl.now, ssp: null, lastYear: tl.last, nightAvailable: false, harmonised: tl.harmonised });
    const { host } = await mount(h(DistrictLedger, { rows, now: tl.now, first: tl.first, last: tl.last, ssp: null, nightAvailable: false, harmonised: tl.harmonised, projections: tl.projYears.length > 0, selectedScope: "ncr", onSelect: () => {} }));
    const headers = [...host.querySelectorAll("th")].map((t) => t.textContent);
    expect(headers.some((t) => /Day 2010–2025/.test(t))).toBe(true);
    expect(headers.some((t) => /p50/.test(t))).toBe(false);
    expect(tl.harmonised).toBe(false);
    expect(host.textContent).toMatch(/n\/a/);
  });

  it("HonestSkill renders the v1 copy without an ablation", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DATA_DIR) });
    await store.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
    const metrics = (await store.getState().ensure("asset:metrics")).data;
    const { host } = await mount(h(HonestSkill, { metrics, schema: "v1" }));
    expect(host.textContent).toMatch(/This is a v1 bundle/);
    expect(host.textContent).not.toMatch(/ablation/);
  });
});

describe.skipIf(!publicDemoExists())("notebook demo bundle (public/demo, read-only)", () => {
  it("Key Figures: NCR change against the exported weather-normalised baseline (baseline_c, D14)", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DEMO_DIR) });
    await store.getState().load({ source: { id: "demo", baseUrl: "/demo", explicit: true, reason: "test" } });
    const series = (await store.getState().ensure("series")).data;
    const day = scopeSeries(series, "ncr", "day");
    expect(Number.isFinite(day.baselineLevel)).toBe(true);
    const base = scopeBaseline(day, "ssp245");
    expect(["baseline_c", "baseline_level_c"]).toContain(base.source);
    const { host } = await mount(h(KeyFigures, { day, night: null, now: 2025, last: 2050, ssps: ["ssp245"], selectedSsp: "ssp245", scopeLabel: "NCR", projections: true, harmonised: true }));
    expect(host.textContent).toMatch(new RegExp(`Baseline ${base.base.toFixed(1)} °C`));
  });
});
