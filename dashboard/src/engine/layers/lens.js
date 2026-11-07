/**
 * Downscale lens (UI_SPEC §6.4, key `Z`): a 110 px circle following the pointer. Inside it the
 * 250 m raster shows; the 1 km columns are hidden there (MaskExtension, `maskInverted: true`).
 *
 * The mask is a SOLID POLYGON (48-gon) computed in lon/lat from the pixel radius through the
 * current viewport, not a pixel-radius scatterplot: deck's mask pass sizes its texture from the
 * mask layer's data bounds, which for a single point would be degenerate.
 *
 * The rim is a 1 px signal-cyan ring (chrome, not data) with the tag "250 m · DOWNSCALED".
 */

import { MaskExtension } from "@deck.gl/extensions";
import { PathLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { ALWAYS_ON_TOP } from "./overlays.js";

export const LENS_RADIUS_PX = 110;
export const LENS_MASK_ID = "lens-mask";
const SEGMENTS = 48;
const SIGNAL = [69, 224, 255];

/** One shared MaskExtension (deck compares extensions by identity). */
export const MASK_EXTENSION = new MaskExtension();

/**
 * Lens ring in lon/lat around a screen point.
 * @param {object} viewport deck WebMercatorViewport
 * @param {[number, number]} xy pointer position (CSS px, relative to the canvas)
 * @returns {Array<[number, number]>|null} closed ring, or null when unprojectable
 */
export function lensRing(viewport, [x, y], radiusPx = LENS_RADIUS_PX) {
  if (!viewport?.unproject) return null;
  const ring = [];
  for (let k = 0; k <= SEGMENTS; k += 1) {
    const a = (k / SEGMENTS) * Math.PI * 2;
    const p = viewport.unproject([x + Math.cos(a) * radiusPx, y + Math.sin(a) * radiusPx]);
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    ring.push([p[0], p[1]]);
  }
  return ring;
}

/**
 * Mask + rim layers for the lens. `label` is the rim tag (reason text when the raster is not
 * available for this frame).
 */
export function createLensLayers({ ring, label = "250 m · DOWNSCALED" }) {
  if (!ring) return [];
  const top = ring.reduce((best, p) => (p[1] > best[1] ? p : best), ring[0]);
  return [
    new SolidPolygonLayer({
      id: LENS_MASK_ID,
      data: [{ polygon: ring }],
      getPolygon: (d) => d.polygon,
      operation: "mask",
    }),
    new PathLayer({
      id: "lens-rim",
      data: [{ path: ring }],
      getPath: (d) => d.path,
      getColor: [...SIGNAL, 230],
      getWidth: 1,
      widthUnits: "pixels",
      pickable: false,
      parameters: ALWAYS_ON_TOP,
    }),
    new TextLayer({
      id: "lens-tag",
      data: [{ position: top, text: label }],
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: 11,
      sizeUnits: "pixels",
      getPixelOffset: [0, -10],
      getColor: [...SIGNAL, 255],
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
      fontWeight: 500,
      fontSettings: { sdf: true },
      outlineWidth: 3,
      outlineColor: [5, 7, 13, 230],
      characterSet: "auto",
      pickable: false,
      parameters: ALWAYS_ON_TOP,
    }),
  ];
}

/** Props to merge into the raster (inside) or the columns (outside, inverted) under the lens. */
export const lensMaskProps = (inverted) => ({ extensions: [MASK_EXTENSION], maskId: LENS_MASK_ID, maskInverted: inverted });
