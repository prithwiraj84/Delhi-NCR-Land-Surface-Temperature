/**
 * Playback scheduler (time/playback.js) against E2's real timeStore initializer with a fake
 * clock: 800 + 800 ms per frame at 1× (scaled by speed), the reduced-motion matrix (2.5 s /
 * 3 s steps, no tween), buffering when the next frame is not loaded, the extra 400 ms hold
 * when crossing NOW, stop at the end / loop, pause settling on a frame, and the NOW detector.
 */
import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { buildTimeline } from "../data/timeline.js";
import { createSynthV2 } from "../data/fixtures/synthV2.js";
import { timeStoreInitializer } from "../state/stores/timeStore.js";
import { crossingDetector } from "./nowCrossing.js";
import { createPlaybackScheduler, cubicBezier, LOOP_FADE_MS, NOW_EXTRA_HOLD_MS, playbackTiming } from "./playback.js";

const timeline = buildTimeline(createSynthV2().manifest);

function setup({ level = "full", ready = () => true, year = 2010, speed = 1, loop = false } = {}) {
  const store = create(timeStoreInitializer);
  store.getState().configure(timeline, { year });
  store.getState().setSpeed(speed);
  store.getState().setLoop(loop);
  const status = create(() => ({ phase: "idle", buffering: false, bufferingYear: null, nextYear: null, stopAt: null }));
  const events = [];
  const prefetched = [];
  const scheduler = createPlaybackScheduler({
    store,
    getLevel: () => level,
    isFrameReady: ready,
    prefetch: (y) => prefetched.push(y),
    onEvent: (e) => events.push(e),
    status,
  });
  let now = 0;
  const run = (ms, stepMs = 16) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + stepMs);
      scheduler.tick(now);
    }
  };
  return { store, status, scheduler, events, prefetched, run, tickNow: () => scheduler.tick(now) };
}

describe("timing matrix", () => {
  it("full = 800 + 800 ms scaled by speed; reduced 2.5 s and off 3 s without tween; never < 0.8 s/frame", () => {
    expect(playbackTiming("full", 1)).toMatchObject({ tweenMs: 800, holdMs: 800 });
    expect(playbackTiming("full", 0.5)).toMatchObject({ tweenMs: 1600, holdMs: 1600 });
    expect(playbackTiming("full", 2).periodMs).toBe(800);
    expect(playbackTiming("reduced", 1)).toMatchObject({ tweenMs: 0, holdMs: 2500 });
    expect(playbackTiming("off", 1)).toMatchObject({ tweenMs: 0, holdMs: 3000 });
    for (const level of ["full", "reduced", "off"]) for (const s of [0.5, 1, 2, 8]) expect(playbackTiming(level, s).periodMs).toBeGreaterThanOrEqual(800 - 1e-9);
  });

  it("the epoch easing (cubicInOut) is monotone without overshoot", () => {
    const ease = cubicBezier([0.65, 0, 0.35, 1]);
    let prev = 0;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const y = ease(Math.min(1, x));
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
      prev = y;
    }
    expect(ease(0.5)).toBeCloseTo(0.5, 3);
  });
});

describe("full-motion playback", () => {
  it("tweens 800 ms (scrubTo, year unchanged) then commits the frame and holds 800 ms", () => {
    const { store, run, events } = setup({ year: 2010 });
    store.getState().play();
    run(400);
    const mid = store.getState();
    expect(mid.scrubT).toBeGreaterThan(2010);
    expect(mid.scrubT).toBeLessThan(2015);
    expect(mid.year).toBe(2010); // committed year waits for the frame (no React re-render per tick)
    run(420);
    expect(store.getState().year).toBe(2015);
    expect(store.getState().scrubT).toBe(2015);
    expect(events.some((e) => e.type === "frame" && e.year === 2015)).toBe(true);
    run(700);
    expect(store.getState().scrubT).toBe(2015); // still holding
    run(400);
    expect(store.getState().scrubT).toBeGreaterThan(2015);
  });

  it("plays 2010 → 2050 in (tween + hold) per frame plus the NOW hold, then stops at the end", () => {
    const { store, run, events } = setup({ year: 2010 });
    store.getState().play();
    const frames = timeline.years.filter((y) => y > 2010).length; // 8
    run(frames * 1600 + NOW_EXTRA_HOLD_MS + 200);
    expect(store.getState().year).toBe(2050);
    expect(store.getState().playing).toBe(false);
    expect(events.filter((e) => e.type === "cross-now")).toHaveLength(1);
    expect(events.find((e) => e.type === "cross-now").year).toBe(2030);
    expect(events.at(-1).type).toBe("end");
  });

  it("holds an extra 400 ms at the first projected frame", () => {
    const a = setup({ year: 2025 });
    a.store.getState().play();
    a.run(800 + 800 + 50); // tween to 2030 + normal hold
    expect(a.store.getState().scrubT).toBe(2030);
    a.run(NOW_EXTRA_HOLD_MS);
    expect(a.store.getState().scrubT).toBeGreaterThan(2030);
  });

  it("2× speed halves both phases", () => {
    const { store, run } = setup({ year: 2010, speed: 2 });
    store.getState().play();
    run(420);
    expect(store.getState().year).toBe(2015);
  });

  it("loops back to the first frame after a 1.2 s fade when loop is on", () => {
    const { store, run, events } = setup({ year: 2045, loop: true });
    store.getState().play();
    run(1600 + LOOP_FADE_MS + 50);
    expect(store.getState().year).toBe(timeline.first);
    expect(store.getState().playing).toBe(true);
    expect(events.some((e) => e.type === "loop")).toBe(true);
  });

  it("pausing mid-tween settles on a frame, never between frames", () => {
    const { store, run, tickNow } = setup({ year: 2010 });
    store.getState().play();
    run(600);
    store.getState().pause();
    tickNow();
    expect(timeline.years).toContain(store.getState().scrubT);
    expect(store.getState().year).toBe(store.getState().scrubT);
  });

  it("an external jump during playback restarts from there", () => {
    const { store, run } = setup({ year: 2010 });
    store.getState().play();
    run(900); // at 2015, holding
    store.getState().setYear(2040);
    run(800 + 800 + 50);
    expect(store.getState().year).toBe(2045);
  });
});

describe("buffering", () => {
  it("waits (map keeps the current frame) and prefetches until the next frame is ready", () => {
    let ready2015 = false;
    const { store, run, status, prefetched, events } = setup({ year: 2010, ready: (y) => y !== 2015 || ready2015 });
    store.getState().play();
    run(3000);
    expect(store.getState().scrubT).toBe(2010);
    expect(status.getState().buffering).toBe(true);
    expect(status.getState().bufferingYear).toBe(2015);
    expect(prefetched).toEqual([2015]);
    ready2015 = true;
    run(850);
    expect(store.getState().year).toBe(2015);
    expect(status.getState().buffering).toBe(false);
    expect(events.some((e) => e.type === "buffered")).toBe(true);
  });
});

describe("reduced / off motion", () => {
  it("reduced: no tween — frames step every 2.5 s", () => {
    const { store, run } = setup({ year: 2010, level: "reduced" });
    store.getState().play();
    run(20);
    expect(store.getState().year).toBe(2015); // immediate step, no in-between positions
    run(2400);
    expect(store.getState().year).toBe(2015);
    run(150);
    expect(store.getState().year).toBe(2020);
  });

  it("off: steps every 3 s and never writes a fractional playhead", () => {
    const { store, run } = setup({ year: 2010, level: "off" });
    const seen = new Set();
    const unsub = store.subscribe((s) => seen.add(s.scrubT));
    store.getState().play();
    run(6100);
    unsub();
    expect(store.getState().year).toBe(2025);
    for (const t of seen) expect(timeline.years).toContain(t);
  });

  it("stopAt bounds a playback segment (Briefing)", () => {
    const { store, status, run, events } = setup({ year: 1990 });
    status.setState({ stopAt: 2000 });
    store.getState().play();
    run(5000);
    expect(store.getState().year).toBe(2000);
    expect(store.getState().playing).toBe(false);
    expect(events.at(-1).type).toBe("stop-at");
    expect(status.getState().stopAt).toBeNull();
  });
});

describe("NOW crossing detector", () => {
  it("fires 'enter' once per pass and re-arms after returning to NOW or earlier", () => {
    const d = crossingDetector(2025);
    expect(d.update(2020)).toBeNull();
    expect(d.update(2025)).toBeNull();
    expect(d.update(2025.4)).toBe("enter");
    expect(d.update(2030)).toBeNull();
    expect(d.update(2040)).toBeNull();
    expect(d.update(2024)).toBe("exit");
    expect(d.update(2026)).toBe("enter");
  });

  it("starting beyond NOW is not a crossing", () => {
    const d = crossingDetector(2025);
    expect(d.update(2040)).toBeNull();
    expect(d.update(2045)).toBeNull();
    expect(d.update(2020)).toBe("exit");
  });
});
