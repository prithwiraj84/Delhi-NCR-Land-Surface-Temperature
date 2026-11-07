import { describe, expect, it } from "vitest";
import { createPerfGovernor, tierEffects } from "./perfGovernor.js";

/** Feed `ms`-long frames for `durationMs` starting at `t0`; returns [end time, changes]. */
function feed(g, ms, durationMs, t0 = 0) {
  const changes = [];
  let t = t0;
  while (t < t0 + durationMs) {
    t += ms;
    const c = g.sample(ms, t);
    if (c) changes.push({ ...c, at: t });
  }
  return [t, changes];
}

describe("perfGovernor", () => {
  it("steps down one tier after 2 s above 22 ms, not before", () => {
    const g = createPerfGovernor();
    const [, early] = feed(g, 30, 1800);
    expect(early).toHaveLength(0);
    const [, changes] = feed(g, 30, 600, 1800);
    expect(changes).toHaveLength(1);
    expect(changes[0].tier).toBe(1);
    expect(g.tier).toBe(1);
  });

  it("never cascades: each step needs a fresh 2 s window, and stops at T3", () => {
    const g = createPerfGovernor();
    const [, changes] = feed(g, 40, 20000);
    expect(changes.map((c) => c.tier)).toEqual([1, 2, 3]);
    for (let i = 1; i < changes.length; i += 1) expect(changes[i].at - changes[i - 1].at).toBeGreaterThanOrEqual(2000);
  });

  it("recovers one tier after 10 s under 14 ms", () => {
    const g = createPerfGovernor({ initialTier: 2 });
    const [t1, none] = feed(g, 10, 9000);
    expect(none).toHaveLength(0);
    const [, up] = feed(g, 10, 2000, t1);
    expect(up[0].tier).toBe(1);
  });

  it("holds between thresholds and ignores outliers (tab switches, GC pauses)", () => {
    const g = createPerfGovernor();
    const [, mid] = feed(g, 18, 30000);
    expect(mid).toHaveLength(0);
    expect(g.sample(900, 40000)).toBeNull();
    expect(g.ema).toBeLessThan(20);
  });

  it("never recovers below the user's chosen tier, and undo blocks re-escalation for a while", () => {
    const changes = [];
    const g = createPerfGovernor({ onChange: (tier, reason) => changes.push([tier, reason]) });
    g.setUserTier(2);
    feed(g, 8, 30000);
    expect(g.tier).toBe(2);
    const h = createPerfGovernor();
    feed(h, 30, 2500);
    expect(h.tier).toBe(1);
    h.undo(0, 3000);
    expect(h.tier).toBe(0);
    const [, blocked] = feed(h, 30, 10000, 3000);
    expect(blocked).toHaveLength(0);
    const [, later] = feed(h, 30, 25000, 13000);
    expect(later.length).toBeGreaterThan(0);
  });

  it("maps tiers to their effects (§6.6 table)", () => {
    expect(tierEffects(0)).toMatchObject({ solidPanels: false, flatLighting: false, lensAllowed: true, forceCpu: false });
    expect(tierEffects(1)).toMatchObject({ solidPanels: true, flatLighting: false });
    expect(tierEffects(2)).toMatchObject({ flatLighting: true, lensAllowed: false, maxDpr: 1, isotherms: false, forceCpu: false });
    expect(tierEffects(3)).toMatchObject({ forceFlat2d: true, forceCpu: true, rasterOnPauseOnly: true });
    expect(tierEffects(9).tier).toBe(3);
  });
});

describe("perfGovernor work-time sampling (T-F4-03, UI_SPEC §6.6)", () => {
  /** Feed frames with `work` ms of work every `interval` ms for `durationMs`. */
  function run(g, { work, interval, durationMs, t0 = 0 }) {
    const changes = [];
    let t = t0;
    while (t < t0 + durationMs) {
      t += interval;
      const c = g.sample(work, t, interval);
      if (c) changes.push({ ...c, at: t });
    }
    return [t, changes];
  }

  it("a 30 Hz display (33.3 ms intervals) with 3 ms of work never demotes", () => {
    const g = createPerfGovernor();
    const [, changes] = run(g, { work: 3, interval: 1000 / 30, durationMs: 30000 });
    expect(changes).toHaveLength(0);
    expect(g.tier).toBe(0);
    expect(g.period).toBeCloseTo(1000 / 30, 3);
  });

  it("16.7 ms intervals with 5 ms of work recover after 10 s", () => {
    const g = createPerfGovernor({ initialTier: 1 });
    const [t1, early] = run(g, { work: 5, interval: 1000 / 60, durationMs: 9500 });
    expect(early).toHaveLength(0);
    const [, up] = run(g, { work: 5, interval: 1000 / 60, durationMs: 1500, t0: t1 });
    expect(up[0]?.tier).toBe(0);
  });

  it("40 ms of real work demotes after 2 s", () => {
    const g = createPerfGovernor();
    const [t1, early] = run(g, { work: 40, interval: 40, durationMs: 1900 });
    expect(early).toHaveLength(0);
    const [, changes] = run(g, { work: 40, interval: 40, durationMs: 400, t0: t1 });
    expect(changes[0]?.tier).toBe(1);
  });

  it("intervals above 1.5× the vsync period demote even with light work (dropped frames)", () => {
    const g = createPerfGovernor();
    // Learn a 60 Hz period first, then drop to ~25 Hz with 6 ms of work for > 2 s.
    const [t1] = run(g, { work: 4, interval: 1000 / 60, durationMs: 1000 });
    const [, changes] = run(g, { work: 6, interval: 40, durationMs: 4000, t0: t1 });
    expect(changes[0]?.tier).toBe(1);
  });

  it("a GPU-bound map slow from the first frame demotes once the idle probe knows the display (60 Hz)", () => {
    const g = createPerfGovernor();
    for (let i = 0; i < 24; i += 1) g.sampleVsync(1000 / 60);
    const [, changes] = run(g, { work: 6, interval: 40, durationMs: 20000 });
    expect(changes.map((c) => c.tier)).toEqual([1, 2, 3]);
    expect(changes[0].at).toBeLessThan(2600);
    expect(g.period).toBeCloseTo(1000 / 60, 3);
  });

  it("15 fps with light work demotes too, and a probe on a 30 Hz display still never demotes 33 ms frames", () => {
    const g = createPerfGovernor();
    for (let i = 0; i < 24; i += 1) g.sampleVsync(1000 / 60);
    const [, slow] = run(g, { work: 8, interval: 66, durationMs: 10000 });
    expect(slow[0]?.tier).toBe(1);
    const h = createPerfGovernor();
    for (let i = 0; i < 24; i += 1) h.sampleVsync(1000 / 30);
    const [, none] = run(h, { work: 3, interval: 1000 / 30, durationMs: 30000 });
    expect(none).toHaveLength(0);
  });

  it("a sustained slowdown after a fast start is not learned as vsync (no recovery while still slow)", () => {
    const g = createPerfGovernor();
    const [t1] = run(g, { work: 4, interval: 1000 / 60, durationMs: 2000 });
    const [, changes] = run(g, { work: 6, interval: 40, durationMs: 30000, t0: t1 });
    expect(changes.map((c) => c.tier)).toEqual([1, 2, 3]);
    expect(g.tier).toBe(3);
  });

  it("high-refresh displays: 60 fps on a 144 Hz panel is not slow", () => {
    const g = createPerfGovernor();
    for (let i = 0; i < 24; i += 1) g.sampleVsync(1000 / 144);
    const [, changes] = run(g, { work: 4, interval: 1000 / 60, durationMs: 20000 });
    expect(changes).toHaveLength(0);
  });

  it("a sustained run of very slow frames (> 250 ms, e.g. a software renderer at 2 fps) still counts", () => {
    const g = createPerfGovernor();
    for (let i = 0; i < 24; i += 1) g.sampleVsync(1000 / 60);
    expect(g.sample(2, 500, 500)).toBeNull(); // the first long frames are treated as stalls
    const [, changes] = run(g, { work: 2, interval: 500, durationMs: 4000, t0: 500 });
    expect(changes[0]?.tier).toBe(1);
  });

  it("undo holds for 30 s without changing the user's floor", () => {
    const g = createPerfGovernor();
    g.setUserTier(1);
    expect(g.floor).toBe(1);
    run(g, { work: 40, interval: 40, durationMs: 2500 });
    expect(g.tier).toBe(2);
    g.undo(1, 3000);
    expect(g.tier).toBe(1);
    expect(g.floor).toBe(1);
    const [, blocked] = run(g, { work: 40, interval: 40, durationMs: 20000, t0: 3000 });
    expect(blocked).toHaveLength(0);
  });
});
