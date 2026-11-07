// @vitest-environment jsdom
/**
 * Accessibility smoke tests for the v2 shell and UI primitives (UI_SPEC §12): vitest-axe in
 * jsdom (colour contrast is excluded here - jsdom has no layout; contrast is asserted
 * numerically in design/tokens.test.js), plus keyboard behaviour of the assembled shell
 * (route keys, palette, shortcut sheet, Escape, roving focus).
 *
 * The data layer and the lazily loaded view/stage modules are mocked: this suite tests the
 * shell, not the data streams or the WebGL engine.
 */
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import manifestV1 from "../lib/__tests__/fixtures/manifest.json";

expect.extend(matchers);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fakeData = {
  status: "ready",
  error: null,
  reload: vi.fn(),
  manifest: manifestV1,
  validation: { errors: [], warnings: ["district boundaries are approximate"] },
  progress: [
    { id: "manifest", label: "manifest.json", file: "manifest.json", status: "ok", bytes: 22000, total: 22000, ms: 40 },
    { id: "cube", label: "cube_obs_day.lstb.gz", file: "cube_obs_day.lstb.gz", status: "loading", bytes: 300000, total: 600000, ms: 200 },
  ],
  source: { id: "data" },
  setBundleSource: vi.fn(),
};

vi.mock("../state/DataContext.jsx", () => ({
  useData: () => fakeData,
  DataProvider: ({ children }) => children,
}));

// Route views / stage are other streams' modules: replace them with simple labelled stubs.
vi.mock("./moduleResolution.js", async () => {
  const { createElement } = await import("react");
  const { ROUTE_BY_ID, DEFAULT_ROUTE } = await import("./routes.js");
  const stubs = {};
  const stubFor = (id) =>
    (stubs[id] ??= function RouteStub() {
      return createElement("div", { "data-testid": `view-${id}` }, createElement("h1", null, `${ROUTE_BY_ID[id].label} stub`));
    });
  return {
    ThermalStage: null,
    pickComponent: (m) => m.default,
    lazyFrom: () => null,
    resolveRouteModule: (routeId) => {
      const route = ROUTE_BY_ID[routeId] ?? ROUTE_BY_ID[DEFAULT_ROUTE];
      return { route, Component: stubFor(route.id), kind: "v2" };
    },
  };
});

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

let container;
let root;

async function render(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return container;
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function waitFor(check, { timeout = 1500, step = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await flush(step);
    }
  }
}

/** axe results restricted to serious/critical (the acceptance gate), plus the full list for messages. */
async function seriousViolations(node, options) {
  const results = await axe(node, options);
  return { ...results, violations: results.violations.filter((v) => v.impact === "serious" || v.impact === "critical") };
}

async function press(key, init = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

let deps;
beforeAll(async () => {
  deps = await import("./deps.js");
});

beforeEach(() => {
  window.location.hash = "";
  document.documentElement.dataset.motion = "off";
  deps.useViewStore.setState({ route: "control", motionPref: "off", perfTier: 0 });
  deps.useTimeStore.setState({ playing: false, mode: "day", year: 2025 });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  const { useShellUi } = await import("./uiStore.js");
  useShellUi.setState({ overlay: null });
  const { useToastStore } = await import("./toasts.js");
  useToastStore.setState({ toasts: [] });
});

describe("UI primitives", () => {
  it("Segmented, TierGlyph, Delta, HudFrame, MicroLabel and ScanSkeleton have no axe violations", async () => {
    const { Segmented } = await import("../components/ui/Segmented.jsx");
    const { TierGlyph } = await import("../components/ui/TierGlyph.jsx");
    const { Delta } = await import("../components/ui/Delta.jsx");
    const { HudFrame } = await import("../components/ui/HudFrame.jsx");
    const { MicroLabel } = await import("../components/ui/MicroLabel.jsx");
    const { ScanSkeleton } = await import("../components/ui/ScanSkeleton.jsx");
    const onChange = vi.fn();
    const node = await render(
      h(
        "main",
        null,
        h(HudFrame, { title: "Telemetry", id: "telemetry" }, h(MicroLabel, null, "NCR mean"), h(Delta, { value: -1.6, context: "vs rural" })),
        h(Segmented, {
          ariaLabel: "Mode",
          value: "day",
          onChange,
          options: [
            { value: "day", label: "Day" },
            { value: "night", label: "Night", disabled: true, reason: "Not in this v1 bundle" },
            { value: "dtr", label: "DTR" },
          ],
        }),
        ...["observed", "observed-sparse", "reconstructed", "modelled", "projected", "simulated-demo", "bogus"].map((t) => h(TierGlyph, { key: t, tier: t, variant: "chip", detail: "Landsat 8/9" })),
        h(TierGlyph, { tier: "projected", variant: "glyph", downscaled: true }),
        h(ScanSkeleton, { label: "Loading fan chart" }),
      ),
    );
    expect(await seriousViolations(node)).toHaveNoViolations();
    expect(await axe(node, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).toHaveNoViolations();

    // Segmented: one tab stop, arrows skip the disabled option and select.
    const radios = [...node.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0].focus();
    await press("ArrowRight");
    expect(onChange).toHaveBeenCalledWith("dtr");
    expect(document.activeElement).toBe(radios[2]);

    // Delta: signed with a true minus and a warmer/cooler accessible name.
    const delta = node.querySelector('[role="img"][aria-label*="cooler"]');
    expect(delta.getAttribute("aria-label")).toBe("minus 1.6 °C cooler vs rural");
    expect(delta.textContent).toContain("−1.6");
  });
});

describe("shell components", () => {
  it("NavRail (rail + mobile bar) is a labelled nav with aria-current and roving focus", async () => {
    const { NavRail } = await import("./NavRail.jsx");
    const node = await render(h("div", null, h(NavRail, { orientation: "vertical" }), h(NavRail, { orientation: "mobile" })));
    expect(await seriousViolations(node)).toHaveNoViolations();
    const rail = node.querySelectorAll("nav")[0];
    const buttons = [...rail.querySelectorAll("button")];
    expect(buttons).toHaveLength(6);
    expect(buttons[0].getAttribute("aria-current")).toBe("page");
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0].focus();
    await press("ArrowDown");
    expect(document.activeElement).toBe(buttons[1]);
    await act(async () => buttons[1].click());
    expect(deps.useViewStore.getState().route).toBe("timeline");
  });

  it("CommandBar renders mode/SSP controls with unavailable reasons for a v1 bundle", async () => {
    const { CommandBar } = await import("./CommandBar.jsx");
    const node = await render(h(CommandBar));
    expect(await seriousViolations(node)).toHaveNoViolations();
    const night = [...node.querySelectorAll('[role="radio"]')].find((r) => r.textContent.includes("Night"));
    expect(night.getAttribute("aria-disabled")).toBe("true");
    expect(night.getAttribute("aria-describedby")).toBeTruthy();
    const ssp = node.querySelector("select");
    expect(ssp.disabled).toBe(true);
  });

  it("CommandPalette is a modal combobox + listbox driven by the keyboard", async () => {
    const { CommandPalette } = await import("./CommandPalette.jsx");
    const { useShellUi } = await import("./uiStore.js");
    const node = await render(h(CommandPalette));
    await act(async () => useShellUi.getState().open("palette"));
    await flush(20);
    const input = node.querySelector('[role="combobox"]');
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(await seriousViolations(node)).toHaveNoViolations();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "gurugram");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = [...node.querySelectorAll('[role="option"]')];
    expect(options[0].textContent).toContain("Gurugram");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    await press("Enter");
    expect(deps.useSelectionStore.getState().districtId).toBe(1);
    expect(useShellUi.getState().overlay).toBeNull();
  });

  it("ShortcutSheet and SettingsMenu dialogs are accessible", async () => {
    const { ShortcutSheet } = await import("./ShortcutSheet.jsx");
    const { SettingsMenu } = await import("./SettingsMenu.jsx");
    const { useShellUi } = await import("./uiStore.js");
    const node = await render(h("div", null, h(SettingsMenu), h(ShortcutSheet)));
    await act(async () => useShellUi.getState().open("settings"));
    await flush(20);
    expect(node.querySelector('[role="dialog"][aria-label="Settings"]')).toBeTruthy();
    expect(await seriousViolations(node)).toHaveNoViolations();
    const motionRadios = [...node.querySelectorAll('[role="radiogroup"][aria-label="Motion level"] [role="radio"]')];
    await act(async () => motionRadios[2].click());
    expect(deps.useViewStore.getState().motionPref).toBe("reduced");
    await act(async () => useShellUi.getState().open("shortcuts"));
    await flush(20);
    const sheet = node.querySelector('[role="dialog"][aria-modal="true"]');
    expect(sheet.textContent).toContain("Keyboard shortcuts");
    expect(await seriousViolations(node)).toHaveNoViolations();
  });

  it("ToastHost, LiveAnnouncer and BootSequence expose live regions and a progressbar", async () => {
    const { ToastHost } = await import("./ToastHost.jsx");
    const { LiveAnnouncer } = await import("./LiveAnnouncer.jsx");
    const { BootSequence } = await import("./BootSequence.jsx");
    const { showToast } = await import("./toasts.js");
    const { announce } = await import("./announcer.js");
    const node = await render(
      h("div", null, h(ToastHost), h(LiveAnnouncer), h(BootSequence, { status: "loading", progress: fakeData.progress, meta: { years: [1990, 2050], dataMode: "gee" }, onDone: () => {} })),
    );
    await act(async () => {
      showToast({ id: "now", title: "Entering projections", body: "Model + CMIP6 scenario, not observations", tone: "info" });
      announce("2040, projected", { immediate: true });
    });
    expect(node.textContent).toContain("Entering projections");
    expect(node.querySelector('[data-testid="live-polite"]').textContent).toBe("2040, projected");
    const bar = node.querySelector('[role="progressbar"]');
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
    expect(await seriousViolations(node)).toHaveNoViolations();
  });
});

describe("assembled AppShell", () => {
  it("has no serious/critical axe violations and a complete keyboard map", async () => {
    const { AppShell } = await import("./AppShell.jsx");
    const { useShellUi } = await import("./uiStore.js");
    const node = await render(h(AppShell));
    await waitFor(() => expect(node.querySelector('[data-testid="view-control"]')).toBeTruthy());
    expect(node.querySelector('[data-testid="stage-pending"]')).toBeTruthy();
    expect(document.documentElement.dataset.motion).toBe("off");
    expect(window.location.hash).toMatch(/^#\/control/);
    expect(await seriousViolations(node)).toHaveNoViolations();

    // 1-6 switch routes (and the URL follows)
    document.body.focus();
    await press("2");
    await waitFor(() => expect(node.querySelector('[data-testid="view-timeline"]')).toBeTruthy());
    expect(deps.useViewStore.getState().route).toBe("timeline");
    expect(window.location.hash).toMatch(/^#\/timeline/);
    await press("6");
    await waitFor(() => expect(node.querySelector('[data-testid="view-sources"]')).toBeTruthy());

    // ? opens the sheet; keys other than Esc are inert while it is open; Esc closes it
    await press("?", { shiftKey: true });
    expect(useShellUi.getState().overlay).toBe("shortcuts");
    await press("1");
    expect(deps.useViewStore.getState().route).toBe("sources");
    await press("Escape");
    expect(useShellUi.getState().overlay).toBeNull();

    // Ctrl+K toggles the palette
    await press("k", { ctrlKey: true });
    expect(useShellUi.getState().overlay).toBe("palette");
    await flush(20);
    expect(await seriousViolations(node)).toHaveNoViolations();
    await press("Escape");
    expect(useShellUi.getState().overlay).toBeNull();

    // N on a v1 bundle: refused with a toast, mode unchanged
    await press("n");
    expect(deps.useTimeStore.getState().mode).toBe("day");
    await waitFor(() => expect(node.textContent).toMatch(/Night unavailable/));

    // M cycles the motion preference
    await press("m");
    expect(deps.useViewStore.getState().motionPref).toBe("system");
  });
});
