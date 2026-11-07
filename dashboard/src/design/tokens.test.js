/**
 * Design-token contract (UI_SPEC_v2 §4.1 "Rules", §12): contrast, colour-vision separation,
 * ramp monotonicity, signal-vs-data separation and single-source sync (tokens.js ->
 * tokens.css / tailwind.config.js / lib/colors.js / ramps.js).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import tokens, { color, cssVarName, ramps, rampKind, roles, surfaces, ssp } from "./tokens.js";
import { contrastRatio, cvdDeltaE, deltaE, lutHex, oklabL } from "./colorScience.js";
import { renderTokensCss } from "./tokensCss.js";
import { LUTS, buildRampTexture, DRIVER_ROW, lutRgb, rampFor, rampRow, vsupRgb, vsupTier, VSUP_TIERS } from "./ramps.js";
import { MOTION_MATRIX, motion, nextMotionPref, panelVariants, resolveMotionLevel, staggerDelay, transition } from "./motion.js";
import { compositeOver, hexToRgb, THEME, sequentialScale, divergingScale } from "../lib/colors.js";
import tailwindConfig from "../../tailwind.config.js";

const SURFACES = Object.entries(surfaces);

describe("WCAG contrast", () => {
  it("surface-1 opaque equivalent is the 72 % composite over --void", () => {
    expect(compositeOver(color.surface1, color.surface1Alpha, color.void).toUpperCase()).toBe(surfaces.surface1);
  });

  it.each(roles.text)("text token %s is >= 4.5:1 on every surface", (key) => {
    for (const [name, surface] of SURFACES) {
      const ratio = contrastRatio(color[key], surface);
      expect(ratio, `${key} on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(roles.nonText)("non-text token %s is >= 3:1 on every surface", (key) => {
    for (const [name, surface] of SURFACES) {
      const ratio = contrastRatio(color[key], surface);
      expect(ratio, `${key} on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("ink-faint is the faintest text and still >= 5.0:1 on surface-3 (spec 5.11)", () => {
    expect(contrastRatio(color.inkFaint, color.surface3)).toBeGreaterThan(5.0);
  });
});

describe("series accents under colour-vision deficiency", () => {
  const series = roles.series;
  const pairs = series.flatMap((a, i) => series.slice(i + 1).map((b) => [a, b]));

  it.each(pairs)("%s vs %s: protan/deutan dE >= 11 and normal-vision dE >= 15", (a, b) => {
    const cvd = cvdDeltaE(color[a], color[b]);
    expect(cvd, `${a}/${b} CVD dE ${cvd.toFixed(1)}`).toBeGreaterThanOrEqual(11);
    expect(deltaE(color[a], color[b])).toBeGreaterThanOrEqual(15);
  });

  it("ssp370 stays optional: it is reported, and only promoted when it clears the gate", () => {
    const worst = Math.min(...series.map((s) => cvdDeltaE(color.ssp370, color[s])));
    expect(roles.optionalSeries).toContain("ssp370");
    if (worst < 11) expect(roles.series).not.toContain("ssp370");
  });

  it("every SSP carries a distinct dash/width (colour is never the only cue)", () => {
    const sig = Object.values(ssp).map((s) => `${s.dash}|${s.width}`);
    expect(new Set(sig).size).toBe(sig.length);
  });
});

describe("data ramps", () => {
  it.each(Object.keys(ramps))("%s: sequential ramps are strictly monotone in OKLab L; Polar is V-shaped", (name) => {
    const stops = ramps[name];
    const L = stops.map((c) => oklabL(c));
    const lut = LUTS[name];
    const lutL = Array.from({ length: 256 }, (_, i) => oklabL(lutHex(lut, i)));
    if (rampKind[name] === "sequential") {
      for (let i = 1; i < L.length; i += 1) expect(L[i]).toBeGreaterThan(L[i - 1]);
      // baked LUT: non-decreasing within 8-bit rounding noise
      for (let i = 1; i < 256; i += 1) expect(lutL[i]).toBeGreaterThanOrEqual(lutL[i - 1] - 0.004);
    } else {
      const mid = (L.length - 1) / 2;
      for (let i = 1; i <= mid; i += 1) expect(L[i]).toBeLessThan(L[i - 1]);
      for (let i = mid + 1; i < L.length; i += 1) expect(L[i]).toBeGreaterThan(L[i - 1]);
      // arms are near-symmetric in lightness, so neither sign looks "stronger"
      for (let i = 0; i < mid; i += 1) expect(Math.abs(L[i] - L[L.length - 1 - i])).toBeLessThan(0.03);
    }
  });

  it.each(Object.keys(ramps))("%s: stop 0 is >= 1.5:1 against --void", (name) => {
    expect(contrastRatio(ramps[name][0], color.void)).toBeGreaterThanOrEqual(1.5);
  });

  it.each(["nocturne", "polar"])("--signal is >= 8 dE from every %s stop and LUT entry", (name) => {
    for (const stop of ramps[name]) expect(deltaE(color.signal, stop), stop).toBeGreaterThanOrEqual(8);
    const lut = LUTS[name];
    let worst = Infinity;
    for (let i = 0; i < 256; i += 1) worst = Math.min(worst, deltaE(color.signal, lutHex(lut, i)));
    expect(worst).toBeGreaterThanOrEqual(8);
  });

  it("LUT end points equal the first and last stops", () => {
    for (const [name, stops] of Object.entries(ramps)) {
      const lut = LUTS[name];
      expect(lutHex(lut, 0).toUpperCase()).toBe(stops[0].toUpperCase());
      expect(lutHex(lut, 255).toUpperCase()).toBe(stops.at(-1).toUpperCase());
    }
  });

  it("GPU texture: 256 x 6 RGBA, rows match the CPU LUTs, driver row holds the palette", () => {
    const tex = buildRampTexture();
    expect(tex.width).toBe(256);
    expect(tex.height).toBe(6);
    expect(tex.data).toHaveLength(256 * 6 * 4);
    const row = rampRow("nocturne");
    for (const i of [0, 77, 255]) {
      const o = (row * 256 + i) * 4;
      expect([tex.data[o], tex.data[o + 1], tex.data[o + 2], tex.data[o + 3]]).toEqual([...LUTS.nocturne.slice(i * 3, i * 3 + 3), 255]);
    }
    const o = (DRIVER_ROW * 256 + 7) * 4;
    expect([tex.data[o], tex.data[o + 1], tex.data[o + 2]]).toEqual(hexToRgb(tokens.driverPalette[0]));
    expect(() => rampRow("rainbow")).toThrow();
  });

  it("CPU scales sample the same LUT as the texture (prism top = legend colour)", () => {
    const scale = sequentialScale([20, 50], { ramp: "solar" });
    expect(scale(35).slice(0, 3)).toEqual(lutRgb("solar", 35, 20, 50));
    expect(divergingScale(4)(0).slice(0, 3)).toEqual(lutRgb("polar", 0, -4, 4));
    expect(lutRgb("solar", Number.NaN, 0, 1)).toBeNull();
  });

  it("ramp selection follows mode x variable", () => {
    expect(rampFor({ mode: "day", variable: "abs" })).toBe("solar");
    expect(rampFor({ mode: "night", variable: "abs" })).toBe("nocturne");
    expect(rampFor({ mode: "dtr" })).toBe("amplitude");
    expect(rampFor({ mode: "night", variable: "suhi" })).toBe("polar");
    expect(rampFor({ mode: "night", variable: "abs", domainMode: "shared" })).toBe("solar");
    expect(rampFor({ layer: "shap:ndvi" })).toBe("polar");
    expect(rampFor({ layer: "unc" })).toBe("mist");
  });

  it("VSUP tiers: thresholds, desaturation and fog increase with uncertainty", () => {
    expect([0.2, 0.5, 0.99, 1.5, 2, 5, Number.NaN].map(vsupTier)).toEqual([0, 1, 1, 2, 3, 3, 0]);
    expect(VSUP_TIERS.map((t) => t.bins)).toEqual([16, 8, 4, 2]);
    const chroma = (rgb) => {
      const [r, g, b] = rgb;
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    const c = [0, 1, 2, 3].map((tier) => chroma(vsupRgb("solar", 0.6, tier)));
    for (let i = 1; i < c.length; i += 1) expect(c[i]).toBeLessThan(c[i - 1]);
  });
});

describe("categorical palettes", () => {
  it("driver palette: adjacent pairs clear the CVD floor (fixed order is the safety mechanism)", () => {
    const p = tokens.driverPalette;
    for (let i = 1; i < p.length; i += 1) expect(cvdDeltaE(p[i - 1], p[i]), `${p[i - 1]}/${p[i]}`).toBeGreaterThanOrEqual(8);
  });
  it("zone colours: pairwise CVD dE >= 6 except the documented weak pair (labels are mandatory)", () => {
    const z = tokens.zoneColors;
    const weak = new Set(tokens.zoneCvdWeakPairs.map(([a, b]) => `${a}-${b}`));
    for (let i = 0; i < z.length; i += 1) {
      for (let j = i + 1; j < z.length; j += 1) {
        const d = cvdDeltaE(z[i], z[j]);
        expect(deltaE(z[i], z[j])).toBeGreaterThanOrEqual(12); // full-colour readers
        if (weak.has(`${i}-${j}`)) expect(d).toBeLessThan(6); // keep the list honest
        else expect(d, `zones ${i}/${j}`).toBeGreaterThanOrEqual(6);
      }
    }
  });
});

describe("single source of truth", () => {
  it("tokens.css is generated from tokens.js + motion.js (run `npm run tokens` if this fails)", () => {
    const file = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
    expect(file).toBe(renderTokensCss());
  });

  it("CSS variable names match the UI_SPEC table", () => {
    expect(cssVarName("surface1")).toBe("--surface-1");
    expect(cssVarName("inkFaint")).toBe("--ink-faint");
    expect(cssVarName("ssp245")).toBe("--ssp245");
    expect(cssVarName("hairlineStrong")).toBe("--hairline-strong");
    const css = renderTokensCss();
    for (const name of ["--void", "--bg", "--surface-2", "--signal", "--solar", "--lunar", "--mode-accent", "--ssp585", "--fog", "--hatch"]) {
      expect(css).toContain(`${name}:`);
    }
  });

  it("tailwind.config.js reads its colours from tokens.js", () => {
    const colors = tailwindConfig.theme.extend.colors;
    expect(colors.signal).toBe(color.signal);
    expect(colors.surface[2]).toBe(color.surface2);
    expect(colors.ink.faint).toBe(color.inkFaint);
    expect(colors.ssp245).toBe(color.ssp245);
    expect(colors.cyan.DEFAULT).toBe(color.signal); // v1 alias re-pointed
  });

  it("lib/colors.js THEME mirrors the tokens", () => {
    expect(THEME.bg).toBe(color.bg);
    expect(THEME.inkFaint).toBe(color.inkFaint);
    expect(THEME.cyan).toBe(color.signal);
    expect(THEME.solar).toBe(color.solar);
  });
});

describe("motion tokens", () => {
  it("exits are <= 75 % of the entrance (law 2)", () => {
    expect(motion.exit.ms).toBeLessThanOrEqual(0.75 * motion.base.ms);
  });
  it("stagger is clamped to <= 40 ms x 8 items (law 3)", () => {
    expect(staggerDelay(3)).toBe(120);
    expect(staggerDelay(20)).toBe(7 * 40);
    expect(staggerDelay(2, 120)).toBe(80);
  });
  it("framer transitions carry the token timing", () => {
    expect(transition("base")).toEqual({ duration: 0.22, ease: [0.16, 1, 0.3, 1], delay: 0 });
  });
  it("motion levels resolve System via prefers-reduced-motion and cycle on M", () => {
    expect(resolveMotionLevel("system", true)).toBe("reduced");
    expect(resolveMotionLevel("system", false)).toBe("full");
    expect(resolveMotionLevel("off", false)).toBe("off");
    expect(resolveMotionLevel("bogus", false)).toBe("full");
    expect(["system", "full", "reduced", "off"].map(nextMotionPref)).toEqual(["full", "reduced", "off", "system"]);
  });
  it("reduced-motion matrix: terminator <= 150 ms under Reduced, jumps under Off, playback never < 0.8 s/frame", () => {
    expect(MOTION_MATRIX.full.terminator).toBe(700);
    expect(MOTION_MATRIX.reduced.terminator).toBeLessThanOrEqual(150);
    expect(MOTION_MATRIX.off.terminator).toBe(0);
    for (const row of Object.values(MOTION_MATRIX)) expect(row.playTween + row.playHold).toBeGreaterThanOrEqual(800);
    expect(panelVariants("off").initial).toBe(false);
  });
});
