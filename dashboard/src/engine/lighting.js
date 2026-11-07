/**
 * Lighting presets (UI_SPEC §5.2 D, §6.6):
 *   Sun   warm, high key light from the south-east morning sun + soft ambient (day)
 *   Moon  ambient 0.9, key 0.5 tinted [180, 200, 255] (night)
 *   Flat  ambient only (perf tier ≥ 2)
 *
 * One LightingEffect instance lives for the whole stage; presets are applied by MUTATING its
 * lights in place (deck reads light colours/intensities every draw), so the Day ↔ Night sweep can
 * blend lighting per frame without rebuilding the effect pipeline. Lighting only affects prism
 * SIDES: top faces are unlit exact LUT colours.
 */

import { AmbientLight, DirectionalLight, LightingEffect } from "@deck.gl/core";

export const PRESETS = Object.freeze({
  sun: Object.freeze({ ambient: { color: [255, 250, 240], intensity: 1.0 }, key: { color: [255, 236, 210], intensity: 0.9, direction: [-2, -6, -8] }, rim: { color: [170, 200, 255], intensity: 0.35, direction: [4, 7, -3] } }),
  moon: Object.freeze({ ambient: { color: [200, 214, 255], intensity: 0.9 }, key: { color: [180, 200, 255], intensity: 0.5, direction: [3, -5, -6] }, rim: { color: [150, 170, 230], intensity: 0.25, direction: [4, 7, -3] } }),
  flat: Object.freeze({ ambient: { color: [255, 255, 255], intensity: 1.0 }, key: { color: [255, 255, 255], intensity: 0, direction: [0, 0, -1] }, rim: { color: [255, 255, 255], intensity: 0, direction: [0, 0, -1] } }),
});

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Blend two presets (t = 0 → a, 1 → b). Pure. */
export function blendPresets(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const part = (x, y) => ({
    color: lerp3(x.color, y.color, k).map(Math.round),
    intensity: lerp(x.intensity, y.intensity, k),
    ...(x.direction ? { direction: lerp3(x.direction, y.direction, k) } : {}),
  });
  return { ambient: part(a.ambient, b.ambient), key: part(a.key, b.key), rim: part(a.rim, b.rim) };
}

/**
 * Stage lighting controller.
 * @returns {{effect: LightingEffect, effects: LightingEffect[], apply(spec): boolean, presetFor(mode, flat): object}}
 */
export function createStageLighting() {
  const ambient = new AmbientLight({ ...PRESETS.sun.ambient });
  const key = new DirectionalLight({ ...PRESETS.sun.key });
  const rim = new DirectionalLight({ ...PRESETS.sun.rim });
  const effect = new LightingEffect({ ambient, key, rim });
  let lastKey = "";
  return {
    effect,
    effects: [effect],
    /** Apply a (blended) preset in place; returns true when something changed (redraw needed). */
    apply(spec) {
      const sig = JSON.stringify(spec);
      if (sig === lastKey) return false;
      lastKey = sig;
      ambient.color = spec.ambient.color;
      ambient.intensity = spec.ambient.intensity;
      key.color = spec.key.color;
      key.intensity = spec.key.intensity;
      key.direction = spec.key.direction;
      rim.color = spec.rim.color;
      rim.intensity = spec.rim.intensity;
      rim.direction = spec.rim.direction;
      return true;
    },
    presetFor(mode, flat = false) {
      if (flat) return PRESETS.flat;
      return mode === "night" ? PRESETS.moon : PRESETS.sun;
    },
  };
}
