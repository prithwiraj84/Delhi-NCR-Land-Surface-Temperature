/**
 * Performance governor (UI_SPEC §6.6): steps quality DOWN one tier when the map is slow and back
 * UP when it has been fast for a while. It samples per-frame WORK time (main-thread engine frame
 * time + deck CPU/GPU time), not the render interval: on a 30 Hz display a 33 ms interval with
 * 3 ms of work is a healthy frame and must never demote.
 *
 *   step down   work EMA > 22 ms, or interval EMA > max(1.5 × the vsync period, 25 ms),
 *               continuously for 2 s → tier + 1 (max 3), PerfChip shows Undo
 *   recover     work EMA < min(14 ms, 0.9 × the vsync period) and a healthy interval
 *               continuously for 10 s → tier − 1 (never below the user's floor)
 *   Undo        starts a 30 s hold (no step down) WITHOUT changing the user's floor; only an
 *               explicit Settings choice (`setUserTier`) sets the floor
 *
 *   T1 solid panels (no backdrop blur)
 *   T2 flat lighting, lens off, DPR 1, isotherms off
 *   T3 2-D, CPU path, raster only on pause
 *
 * The vsync (rAF) period must not learn a sustained slow interval as "the display" (a GPU-bound
 * map at 25 fps with 3–6 ms of JS work, where deck reports no GPU time, would never be demoted).
 * Two sources, the smaller wins:
 *   - the idle probe: `sampleVsync(intervalMs)` with rAF intervals measured while the engine is
 *     NOT rendering (MapEngine runs a short probe burst after each animation ends, at most every
 *     30 s), i.e. the display refresh itself; 25th percentile of the last `probeWindow` samples;
 *   - a long-window minimum of the rendered intervals: the 25th percentile of the last
 *     `periodWindow` intervals, which may only RISE towards a slower value with the time
 *     constant `periodRelaxMs` (60 s) but drops at once. A fast start therefore anchors 16.7 ms
 *     and a later slowdown demotes; without any probe, a device that is slow from the very first
 *     frame is indistinguishable from a slow display and keeps T0 (a 30 Hz display must not demote).
 * Only frames the engine actually rendered while animating are sampled; an interval that spans a
 * tick the engine skipped on purpose (the 30 Hz CPU scrub throttle) is passed as null and only the
 * work time counts. Samples above 250 ms (tab switch, GC pause, breakpoint) are ignored as outliers
 * unless `outlierRun` (3) of them arrive in a row: then the device itself is that slow (a software
 * renderer at 2 fps) and they count, clamped to 250 ms.
 *
 * Pure and clock-injected: `sample(workMs, nowMs, intervalMs?)` returns the tier change (or null),
 * so the policy is unit-tested without a browser.
 */

export const GOVERNOR_DEFAULTS = Object.freeze({
  slowMs: 22,
  slowHoldMs: 2000,
  fastMs: 14,
  fastHoldMs: 10000,
  /** interval > slowIntervalFactor × vsync period counts as slow */
  slowIntervalFactor: 1.5,
  /** recovery needs work < fastPeriodFactor × vsync period (and < fastMs) */
  fastPeriodFactor: 0.9,
  alpha: 0.1,
  maxTier: 3,
  outlierMs: 250,
  /** consecutive samples above outlierMs after which they count (clamped) instead of being ignored */
  outlierRun: 3,
  undoHoldMs: 30000,
  periodWindow: 120,
  /** minimum intervals before the period estimate is trusted */
  periodMinSamples: 20,
  /** the rendered-interval estimate rises towards slower values with this time constant (ms) */
  periodRelaxMs: 60000,
  /** idle rAF probe samples kept / needed (sampleVsync) */
  probeWindow: 60,
  probeMinSamples: 8,
  /** a probe interval above this is not a display refresh (ms) */
  probeMaxMs: 100,
  /** an interval below this is never "slow", whatever the vsync estimate (high-refresh displays) */
  slowIntervalMinMs: 25,
});

/** What each tier switches (engine + shell read this instead of re-deriving the table). */
export function tierEffects(tier) {
  const t = Math.max(0, Math.min(3, tier | 0));
  return Object.freeze({
    tier: t,
    solidPanels: t >= 1,
    flatLighting: t >= 2,
    lensAllowed: t < 2,
    maxDpr: t >= 2 ? 1 : 1.5,
    isotherms: t < 2,
    forceFlat2d: t >= 3,
    forceCpu: t >= 3,
    rasterOnPauseOnly: t >= 3,
  });
}

/**
 * @param {object} [options] overrides of GOVERNOR_DEFAULTS plus `initialTier`, `floorTier`
 *   (the user's chosen minimum, never undone automatically) and `onChange(tier, reason)`.
 */
export function createPerfGovernor(options = {}) {
  const cfg = { ...GOVERNOR_DEFAULTS, ...options };
  let tier = Math.max(0, Math.min(cfg.maxTier, options.initialTier ?? 0));
  let floor = Math.max(0, Math.min(cfg.maxTier, options.floorTier ?? 0));
  let ema = null;
  let emaInterval = null;
  let slowSince = null;
  let fastSince = null;
  let holdUntil = -Infinity;
  let enabled = true;
  let longRun = 0;
  const intervals = [];
  const probe = [];
  let best = null; // long-window minimum of the rendered-interval estimate
  let bestAt = null;
  let probeCache = null;
  const onChange = typeof options.onChange === "function" ? options.onChange : null;

  const pct25 = (arr) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * 0.25)];
  };

  /** Update the long-window minimum after a new rendered interval at time `now`. */
  const updateBest = (now) => {
    if (intervals.length < cfg.periodMinSamples) return;
    const cur = pct25(intervals);
    if (best === null || cur <= best) best = cur;
    else best += (cur - best) * Math.min(1, Math.max(0, now - (bestAt ?? now)) / cfg.periodRelaxMs);
    bestAt = now;
  };

  /** vsync period estimate (ms): min(idle probe, long-window minimum); null while unknown. */
  const period = () => {
    if (probeCache === null && probe.length >= cfg.probeMinSamples) probeCache = pct25(probe);
    if (probeCache !== null) return best !== null ? Math.min(probeCache, best) : probeCache;
    return best;
  };

  const resetWindows = () => {
    slowSince = null;
    fastSince = null;
    // Start the next decision window from a neutral estimate so one tier change cannot cascade.
    ema = null;
    emaInterval = null;
  };

  const change = (next, reason) => {
    const clamped = Math.max(floor, Math.min(cfg.maxTier, next));
    if (clamped === tier) return null;
    const prev = tier;
    tier = clamped;
    resetWindows();
    const event = { tier, prev, reason };
    onChange?.(tier, reason);
    return event;
  };

  return {
    get tier() {
      return tier;
    },
    /** EMA of the per-frame work time (ms). */
    get ema() {
      return ema;
    },
    get emaInterval() {
      return emaInterval;
    },
    /** Estimated vsync period (ms) or null while unknown. */
    get period() {
      return period();
    },
    get floor() {
      return floor;
    },
    /**
     * Record one rendered frame.
     * @param {number} workMs        engine + deck work of the frame (ms)
     * @param {number} now           monotonic clock (ms)
     * @param {number|null} [intervalMs] time since the previous rendered frame; null/undefined when
     *   unknown or when it spans a tick the engine skipped on purpose
     * @returns {{tier:number, prev:number, reason:string}|null} the change made, if any
     */
    sample(workMs, now, intervalMs = null) {
      if (!enabled || !Number.isFinite(workMs) || workMs < 0) return null;
      const hasIv = Number.isFinite(intervalMs) && intervalMs > 0;
      if (workMs > cfg.outlierMs || (hasIv && intervalMs > cfg.outlierMs)) {
        longRun += 1;
        if (longRun < cfg.outlierRun) return null; // an isolated stall (tab switch, GC, breakpoint)
      } else longRun = 0;
      workMs = Math.min(workMs, cfg.outlierMs);
      const iv = hasIv ? Math.min(intervalMs, cfg.outlierMs) : null;
      if (iv !== null) {
        intervals.push(iv);
        if (intervals.length > cfg.periodWindow) intervals.shift();
        updateBest(now);
        emaInterval = emaInterval === null ? iv : emaInterval + cfg.alpha * (iv - emaInterval);
      }
      ema = ema === null ? workMs : ema + cfg.alpha * (workMs - ema);
      const p = period();
      const slowWork = ema > cfg.slowMs;
      const slowInterval = p !== null && emaInterval !== null && emaInterval > Math.max(cfg.slowIntervalFactor * p, cfg.slowIntervalMinMs);
      const fastLimit = p !== null ? Math.min(cfg.fastMs, cfg.fastPeriodFactor * p) : cfg.fastMs;
      if (slowWork || slowInterval) {
        fastSince = null;
        if (slowSince === null) slowSince = now;
        if (now - slowSince >= cfg.slowHoldMs && tier < cfg.maxTier && now >= holdUntil) {
          const why = slowWork ? `work EMA ${ema.toFixed(1)} ms > ${cfg.slowMs} ms` : `frame interval ${emaInterval.toFixed(1)} ms > max(${cfg.slowIntervalFactor} × vsync ${p.toFixed(1)} ms, ${cfg.slowIntervalMinMs} ms)`;
          return change(tier + 1, `${why} for ${cfg.slowHoldMs / 1000} s`);
        }
      } else if (ema < fastLimit) {
        slowSince = null;
        if (fastSince === null) fastSince = now;
        if (now - fastSince >= cfg.fastHoldMs && tier > floor) {
          return change(tier - 1, `work EMA ${ema.toFixed(1)} ms < ${fastLimit.toFixed(1)} ms for ${cfg.fastHoldMs / 1000} s`);
        }
      } else {
        slowSince = null;
        fastSince = null;
      }
      return null;
    },
    /**
     * One rAF interval measured while the engine rendered nothing (idle probe): the display's
     * refresh period, used as the vsync estimate (see the header).
     */
    sampleVsync(intervalMs) {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > cfg.probeMaxMs) return;
      probe.push(intervalMs);
      if (probe.length > cfg.probeWindow) probe.shift();
      probeCache = null;
    },
    /**
     * Undo (PerfChip): go back to `toTier` and do not step down again for `undoHoldMs`. The
     * user's floor is NOT changed (the governor may still recover above it later).
     */
    undo(toTier, now) {
      holdUntil = now + cfg.undoHoldMs;
      const target = Math.max(floor, Math.min(cfg.maxTier, toTier | 0));
      const out = change(target, "undo");
      if (!out) resetWindows();
      return out;
    },
    /** The user picked a tier in Settings: it becomes the floor and the current tier. */
    setUserTier(t) {
      floor = Math.max(0, Math.min(cfg.maxTier, t | 0));
      const prev = tier;
      tier = floor;
      resetWindows();
      return prev !== tier ? { tier, prev, reason: "user" } : null;
    },
    /** Follow an external tier change (store) without treating it as a decision. */
    sync(t) {
      tier = Math.max(0, Math.min(cfg.maxTier, t | 0));
      ema = null;
      emaInterval = null;
    },
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) {
        slowSince = null;
        fastSince = null;
      }
    },
    reset() {
      resetWindows();
    },
  };
}
