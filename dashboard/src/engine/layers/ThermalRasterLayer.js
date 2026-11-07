/**
 * ThermalRasterLayer (UI_SPEC §6.3): the 250 m (or 500 m preview) thermal raster.
 *
 * A BitmapLayer subclass that keeps the stock vertex shader and mesh (rectangular `bounds`,
 * `_imageCoordinateSystem: "lnglat"`, so EPSG:4326 pixels land at their true lon/lat on the
 * Web-Mercator map — placing UTM imagery would misplace the eastern edge by ~4 km) and replaces
 * the fragment shader:
 *   - two R-code textures (A, B) decoded as value = lo + (R − 1)·(hi − lo)/254 (R = 0 → discard),
 *     fetched with integer texel coordinates (NEAREST by construction);
 *   - the same atlas LUT, domain, sweep weight and nodata rule as the columns, so switching
 *     resolution never changes colours;
 *   - outside-AOA hatch (G bit 0), fwidth-anti-aliased isotherms (1 °C, every 5th bold).
 *
 * Textures are luma Textures created by the engine from the decoded `values`/`flags` bytes the
 * data worker produced (RGBA8: R = value code, G = flags), never re-encoded or filtered.
 */

import { BitmapLayer } from "@deck.gl/layers";
import { RASTER_FS, thermalRasterModule } from "../shaders/thermal.glsl.js";

const DEFAULT_RASTER = Object.freeze({
  boundsLL: [0, 0, 1, 1],
  decodeA: [0, 1, 0, 0],
  decodeB: [0, 1, 0, 0],
  channel: [0, 1, 0, 1],
  channelB: [0, 1, 0, 0],
  shape: [0, 0, 0.08, 0],
  lonRange: [0, 1, 0, 0],
  fx: [1, 0, 1, 0],
});

export default class ThermalRasterLayer extends BitmapLayer {
  getShaders() {
    const shaders = super.getShaders();
    return { ...shaders, fs: RASTER_FS, modules: [...shaders.modules, thermalRasterModule] };
  }

  draw(opts) {
    const { shaderModuleProps } = opts;
    const { model, coordinateConversion, bounds, disablePicking } = this.state;
    const { textureA, textureB, thermalLut, thermalRaster, desaturate, transparentColor, tintColor } = this.props;
    if (shaderModuleProps.picking?.isActive && disablePicking) return;
    if (!model || !textureA || !thermalLut) return;
    model.shaderInputs.setProps({
      bitmap: {
        bounds,
        coordinateConversion,
        desaturate,
        tintColor: tintColor.slice(0, 3).map((x) => x / 255),
        transparentColor: transparentColor.map((x) => x / 255),
      },
      thermalRaster: { ...DEFAULT_RASTER, ...(thermalRaster ?? {}), textureA, textureB: textureB ?? textureA, lutTexture: thermalLut },
    });
    model.draw(this.context.renderPass);
  }
}

ThermalRasterLayer.layerName = "ThermalRasterLayer";
ThermalRasterLayer.defaultProps = {
  ...BitmapLayer.defaultProps,
  textureA: { type: "object", value: null, compare: true },
  textureB: { type: "object", value: null, compare: true },
  thermalLut: { type: "object", value: null, compare: true },
  thermalRaster: { type: "object", value: DEFAULT_RASTER, compare: false },
  _imageCoordinateSystem: "lnglat",
};

/** Interleave decoded raster channels into RGBA8 (R = value code, G = flags). */
export function rasterTextureBytes(raster) {
  const n = raster.width * raster.height;
  const out = new Uint8Array(n * 4);
  const { values, flags } = raster;
  for (let i = 0, o = 0; i < n; i += 1, o += 4) {
    out[o] = values[i];
    out[o + 1] = flags ? flags[i] : 0;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * Create a luma texture for a decoded raster resource ({values, flags, width, height}).
 * NEAREST sampling and no mipmaps (the shader uses texelFetch anyway).
 */
export function createRasterTexture(device, raster) {
  const data = rasterTextureBytes(raster);
  return device.createTexture({
    id: `thermal-raster-${raster.key ?? "x"}${raster.preview ? "-preview" : ""}`,
    width: raster.width,
    height: raster.height,
    format: "rgba8unorm",
    data,
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
  });
}
