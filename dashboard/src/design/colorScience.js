/**
 * Colour-science checks used by tokens.test.js (and available to any palette work):
 * WCAG contrast, OKLab dE (x100) and colour-vision-deficiency simulation.
 *
 * CVD simulation: Machado, Oliveira & Fernandes (2009) severity-1.0 matrices applied in
 * LINEAR RGB, then measured in OKLab. The dE thresholds used by the tests (>= 11 between
 * series accents, >= 8 signal-vs-ramp) are calibrated to exactly this model; swapping in a
 * different simulation (e.g. Viénot 1999) moves borderline pairs and would require
 * recalibration.
 */
import { contrastRatio, hexToRgb, linearToOklab, rgbToOklab, srgbToLinear } from "../lib/colors.js";

export { contrastRatio };

export const MACHADO = Object.freeze({
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** OKLab of a hex colour, optionally under simulated CVD ("protan" | "deutan" | "tritan"). */
export function oklabOf(hex, kind = null) {
  const lin = hexToRgb(hex).slice(0, 3).map(srgbToLinear);
  if (!kind) return linearToOklab(lin);
  const M = MACHADO[kind];
  if (!M) throw new Error(`oklabOf: unknown CVD kind "${kind}"`);
  return linearToOklab(M.map((row) => clamp01(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
}

/** OKLab Euclidean distance x100 between two hex colours, optionally under simulated CVD. */
export function deltaE(a, b, kind = null) {
  const p = oklabOf(a, kind);
  const q = oklabOf(b, kind);
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Minimum dE over protan and deutan simulation (the dichromat gate). */
export function cvdDeltaE(a, b) {
  return Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan"));
}

/** OKLab lightness L (0..1) of a hex colour or an [r, g, b] triple. */
export function oklabL(c) {
  return (typeof c === "string" ? rgbToOklab(hexToRgb(c)) : rgbToOklab(c))[0];
}

/** "#rrggbb" for LUT entry i of a Uint8Array(256 * 3). */
export function lutHex(lut, i) {
  return `#${[lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
