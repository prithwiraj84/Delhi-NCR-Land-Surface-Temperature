/**
 * GLSL for the thermal map engine (UI_SPEC §6.2–§6.3). Everything here mirrors a CPU function:
 *
 *   thermal_weight      ⇔ mixFrame.js  mixWeight / sweepWeight / radialWeight
 *   thermal_lut         ⇔ lut.js       atlasRgb / lutColumn (texelFetch of the same atlas bytes)
 *   thermal_elev        ⇔ colorize.js  elevationOf
 *   value / colour mix  ⇔ colorize.js  colorizeSlots
 *
 * Injection strategy (NO string patching of deck.gl sources):
 * luma.gl emits hook functions (DECKGL_FILTER_*) BEFORE the layer's own source, so a hook body
 * cannot see the layer's attributes (`positions`, `normals`, `instanceFillColors`). We declare
 * module-level globals in `vs:#decl`, assign them in `vs:#main-start` (inside main(), where the
 * attributes are in scope) and read them in the hooks, which deck calls later in main():
 *   - `vs:DECKGL_FILTER_SIZE(inout vec3 size, VertexGeometry geometry)` — in ColumnLayer 9.4 it
 *     runs on `vec3 pos = vec3(offset, 0.)` before `project_position_to_clipspace(centroid, …, pos)`,
 *     so adding `project_size(metres · zT)` to `size.z` extrudes the prism from the blended value
 *     while `getElevation` stays the constant 0 (verified by shaderHooks.test.js).
 *   - `vs:DECKGL_FILTER_COLOR` — top faces get the exact LUT colour (unlit), sides the lit colour.
 *   - `fs:DECKGL_FILTER_COLOR` — screen-space AOA hatch and brush dimming.
 * All uniforms are packed in vec4s (std140-safe); the packing is documented per member.
 */

/** Sentinel the CPU writes into Float32 slot attributes for nodata (NaN is unreliable in GLSL). */
export const SLOT_NODATA = -9999;

// ---------------------------------------------------------------------------------------
// Shared GLSL chunks
// ---------------------------------------------------------------------------------------

/**
 * Mix weight (shape 0 fade | 1 sweep east→west | 2 radial | 3 split = 1, the split itself is a
 * discard in ScreenSplitExtension). `p` = (mix, sweepPos, feather, shape); `lon` = (west, east);
 * `radial` = (cx, cy, radius, unused); `planar` = (west, south, cos(lat0), latSpan).
 */
export const WEIGHT_GLSL = /* glsl */ `
vec2 thermal_planarXY(vec2 lnglat, vec4 planar) {
  return vec2((lnglat.x - planar.x) * planar.z / planar.w, (lnglat.y - planar.y) / planar.w);
}

float thermal_weightOf(vec2 lnglat, vec4 p, vec2 lon, vec4 radial, vec4 planar) {
  float shape = p.w;
  if (shape < 0.5) {
    return clamp(p.x, 0.0, 1.0);
  }
  if (shape < 1.5) {
    float u = (lnglat.x - lon.x) / max(lon.y - lon.x, 1e-6);
    float f = max(p.z, 1e-6);
    float edge = 1.0 + f - clamp(p.y, 0.0, 1.0) * (1.0 + 2.0 * f);
    return clamp((u - edge) / f + 1.0, 0.0, 1.0);
  }
  if (shape < 2.5) {
    float d = distance(thermal_planarXY(lnglat, planar), radial.xy);
    float r = max(radial.z, 1e-9);
    float f = max(p.z, 1e-6) * r;
    float front = clamp(p.x, 0.0, 1.0) * (r + f);
    return clamp((front - d) / f, 0.0, 1.0);
  }
  return 1.0;
}
`;

/** Exact atlas lookup: column round(clamp(t)·255), row ramp·5 + variant (lut.js). */
export const LUT_GLSL = /* glsl */ `
vec3 thermal_lutRgb(sampler2D atlas, float v, float lo, float hi, float rampIndex, float variant) {
  float span = hi - lo;
  float t = span > 0.0 ? (v - lo) / span : 0.5;
  int col = int(floor(clamp(t, 0.0, 1.0) * 255.0 + 0.5));
  int row = int(rampIndex + 0.5) * 5 + int(clamp(variant, 0.0, 4.0) + 0.5);
  return texelFetch(atlas, ivec2(col, row), 0).rgb;
}
`;

/** Screen-space 45° hatch mask (UI_SPEC §6.2: mod(x + y, 6) < 1.5). */
export const HATCH_GLSL = /* glsl */ `
float thermal_hatch(vec2 fragCoord) {
  return mod(fragCoord.x + fragCoord.y, 6.0) < 1.5 ? 1.0 : 0.0;
}
`;

// ---------------------------------------------------------------------------------------
// ThermalColumnLayer module (both paths): exact unlit top faces + side rim
// ---------------------------------------------------------------------------------------

const columnUniformBlock = /* glsl */ `\
layout(std140) uniform thermalColumnUniforms {
  vec4 opts;   // x rim strength (0.25; 0 under flat lighting), y slots active (GPU path), z,w unused
} thermalColumn;
`;

export const thermalColumnModule = {
  name: "thermalColumn",
  vs: /* glsl */ `${columnUniformBlock}
float thermalCol_isTop;
float thermalCol_zT;
vec4 thermalCol_base;
`,
  fs: columnUniformBlock,
  inject: {
    // Capture per-vertex facts while the ColumnLayer attributes are in scope.
    "vs:#main-start": {
      order: 0,
      injection: /* glsl */ `
  thermalCol_isTop = normals.z > 0.9 ? 1.0 : 0.0;
  thermalCol_zT = (positions.z + 1.0) * 0.5;
  thermalCol_base = instanceFillColors;
`,
    },
    "vs:DECKGL_FILTER_COLOR": {
      order: 0,
      injection: /* glsl */ `
  bool thermalSlots = thermalColumn.opts.y > 0.5;
  if (column.extruded && !column.isStroke) {
    if (thermalCol_isTop > 0.5) {
      // Data-pure top face: the exact LUT colour, never lit (UI_SPEC §1 principle 7).
      color.rgb = thermalCol_base.rgb;
    } else {
      if (thermalSlots) {
        // GPU path renders the prism white; the lit white is the per-vertex light factor.
        color.rgb = thermalCol_base.rgb * color.rgb;
      }
      vec3 viewDir = normalize(project.cameraPosition - geometry.position.xyz);
      float facing = abs(dot(normalize(geometry.normal), viewDir));
      color.rgb = min(color.rgb + vec3(pow(1.0 - facing, 3.0) * thermalColumn.opts.x), vec3(1.0));
    }
  } else if (thermalSlots) {
    color.rgb = thermalCol_base.rgb;
  }
  if (thermalSlots) {
    color.a *= thermalCol_base.a;
  }
`,
    },
  },
  uniformTypes: { opts: "vec4<f32>" },
};

// ---------------------------------------------------------------------------------------
// ThermalSlotsExtension module (GPU two-slot mix on columns)
// ---------------------------------------------------------------------------------------

const slotsUniformBlock = /* glsl */ `\
layout(std140) uniform thermalUniforms {
  vec4 slotA;    // lo, hi, heightRef, rampIndex of slot A
  vec4 slotB;    // lo, hi, heightRef, rampIndex of slot B
  vec4 shape;    // mix, sweepPos, feather, shape code
  vec4 lonRange; // west, east, valueMix (1 = same channel: value lerp; 0 = colour cross-fade), unused
  vec4 radial;   // cx, cy, radius, unused (planar units)
  vec4 planar;   // west, south, cos(lat0), latSpan
  vec4 height;   // heightMode (0 flat | 1 anom+ | 2 abs), heightModeFrom, heightBlend, heightCap
  vec4 elev;     // metres per unit (anom+), metres per unit abs slot A, slot B, sink multiplier
  vec4 fx;       // fogStrength, hatchOn, maskOn, unused
} thermal;
`;

export const thermalSlotsModule = {
  name: "thermal",
  vs: /* glsl */ `${slotsUniformBlock}
uniform sampler2D thermal_lutTexture;
in float instanceValueA;
in float instanceValueB;
in vec4 instanceThermalAux;   // raw bytes: VSUP code A, VSUP code B, AOA bits (1 = A outside, 2 = B outside), brush (1 = selected)
out vec4 thermal_vFx;         // x hatch, y brush-dim
float thermal_elevation;
float thermal_hidden;
${WEIGHT_GLSL}
${LUT_GLSL}
bool thermal_isNodata(float v) { return v < ${SLOT_NODATA + 1}.0; }

float thermal_elev(float v, float mode, vec4 slot, float perUnitAbs) {
  if (mode < 0.5) return 0.0;
  if (mode < 1.5) return clamp(v - slot.z, 0.0, thermal.height.w) * thermal.elev.x;
  return max(v - slot.x, 0.0) * perUnitAbs;
}

void thermal_compute(vec2 lnglat) {
  float m = thermal_weightOf(lnglat, thermal.shape, thermal.lonRange.xy, thermal.radial, thermal.planar);
  float a = instanceValueA;
  float b = instanceValueB;
  bool na = thermal_isNodata(a);
  bool nb = thermal_isNodata(b);
  float vsA = instanceThermalAux.x;
  float vsB = instanceThermalAux.y;
  float aoaBits = instanceThermalAux.z;
  bool sideB = m >= 0.5;
  vec3 rgb = vec3(0.0);
  float alpha = 1.0;
  float elevation = 0.0;
  thermal_hidden = 0.0;
  if (thermal.lonRange.z > 0.5) {
    // Value mix (same colour channel): the shared nodata rule of mixFrame.mixValue.
    float v = m <= 0.0 ? a : (m >= 1.0 ? b : mix(a, b, m));
    bool missing = m <= 0.0 ? na : (m >= 1.0 ? nb : (na || nb));
    if (missing) {
      thermal_hidden = 1.0;
    } else {
      vec3 plain = thermal_lutRgb(thermal_lutTexture, v, thermal.slotA.x, thermal.slotA.y, thermal.slotA.w, 0.0);
      float w = ((1.0 - m) * (vsA > 0.5 ? 1.0 : 0.0) + m * (vsB > 0.5 ? 1.0 : 0.0)) * thermal.fx.x;
      float code = sideB ? (vsB > 0.5 ? vsB : vsA) : (vsA > 0.5 ? vsA : vsB);
      rgb = (w > 0.0 && code > 0.5)
        ? mix(plain, thermal_lutRgb(thermal_lutTexture, v, thermal.slotA.x, thermal.slotA.y, thermal.slotA.w, code), w)
        : plain;
      float eTo = thermal_elev(v, thermal.height.x, thermal.slotA, thermal.elev.y);
      float eFrom = thermal_elev(v, thermal.height.y, thermal.slotA, thermal.elev.y);
      elevation = thermal.height.z >= 1.0 ? eTo : mix(eFrom, eTo, thermal.height.z);
    }
  } else {
    // Colour cross-fade between two channels (Day ↔ Night sweep, layer fade).
    bool okA = !na && m < 1.0;
    bool okB = !nb && m > 0.0;
    if (!okA && !okB) {
      thermal_hidden = 1.0;
    } else {
      float fog = thermal.fx.x >= 0.5 ? 1.0 : 0.0;
      vec3 ca = okA ? thermal_lutRgb(thermal_lutTexture, a, thermal.slotA.x, thermal.slotA.y, thermal.slotA.w, vsA * fog) : vec3(0.0);
      vec3 cb = okB ? thermal_lutRgb(thermal_lutTexture, b, thermal.slotB.x, thermal.slotB.y, thermal.slotB.w, vsB * fog) : vec3(0.0);
      float wa = okA ? 1.0 - m : 0.0;
      float wb = okB ? m : 0.0;
      float sum = wa + wb;
      rgb = (ca * wa + cb * wb) / (sum > 0.0 ? sum : 1.0);
      alpha = (okA && okB) ? 1.0 : (okA ? 1.0 - m : m);
      float ea = na ? 0.0 : thermal_elev(a, thermal.height.x, thermal.slotA, thermal.elev.y);
      float eb = nb ? 0.0 : thermal_elev(b, thermal.height.x, thermal.slotB, thermal.elev.z);
      elevation = mix(ea, eb, m);
    }
  }
  float outside = sideB ? mod(floor(aoaBits * 0.5 + 0.01), 2.0) : mod(aoaBits + 0.01, 2.0);
  thermal_vFx = vec4(
    thermal.fx.y > 0.5 && outside > 0.5 ? 1.0 : 0.0,
    thermal.fx.z > 0.5 && instanceThermalAux.w < 0.5 ? 1.0 : 0.0,
    0.0,
    0.0
  );
  thermal_elevation = elevation * thermal.elev.w;
  thermalCol_base = vec4(rgb, alpha);
}
`,
  fs: /* glsl */ `${slotsUniformBlock}
in vec4 thermal_vFx;
${HATCH_GLSL}
`,
  inject: {
    // Runs after the column module captured its globals (order 0) and overrides the base colour.
    "vs:#main-start": { order: 10, injection: "  thermal_compute(instancePositions.xy);\n" },
    "vs:DECKGL_FILTER_SIZE": {
      order: 0,
      injection: /* glsl */ `
  if (thermal_hidden > 0.5) {
    size = vec3(0.0);
  } else {
    size.z += project_size(thermal_elevation * thermalCol_zT * column.elevationScale);
  }
`,
    },
    "fs:DECKGL_FILTER_COLOR": {
      order: 0,
      injection: /* glsl */ `
  if (thermal_vFx.x > 0.5 && thermal_hatch(gl_FragCoord.xy) > 0.5) {
    color.rgb *= 0.65;
  }
  if (thermal_vFx.y > 0.5) {
    color.rgb *= 0.25;
  }
`,
    },
  },
  getUniforms(opts = {}) {
    const out = {};
    for (const key of Object.keys(THERMAL_UNIFORM_TYPES)) if (key in opts) out[key] = opts[key];
    if (opts.lutTexture) out.thermal_lutTexture = opts.lutTexture;
    return out;
  },
  uniformTypes: null,
};

/** Uniform members of the `thermal` block (all vec4). */
export const THERMAL_UNIFORM_TYPES = Object.freeze({
  slotA: "vec4<f32>",
  slotB: "vec4<f32>",
  shape: "vec4<f32>",
  lonRange: "vec4<f32>",
  radial: "vec4<f32>",
  planar: "vec4<f32>",
  height: "vec4<f32>",
  elev: "vec4<f32>",
  fx: "vec4<f32>",
});
thermalSlotsModule.uniformTypes = THERMAL_UNIFORM_TYPES;

// ---------------------------------------------------------------------------------------
// ScreenSplitExtension module (compare): discard by screen x (any pitch / bearing)
// ---------------------------------------------------------------------------------------

const splitUniformBlock = /* glsl */ `\
layout(std140) uniform screenSplitUniforms {
  vec4 split;   // x enabled, y side (0 keep left of the divider, 1 keep right), z divider (0..1 of the width), w buffer width (device px)
} screenSplit;
`;

export const screenSplitModule = {
  name: "screenSplit",
  vs: splitUniformBlock,
  fs: splitUniformBlock,
  inject: {
    "fs:#main-start": /* glsl */ `
  if (screenSplit.split.x > 0.5) {
    float splitFx = gl_FragCoord.x / max(screenSplit.split.w, 1.0);
    if ((screenSplit.split.y < 0.5 && splitFx > screenSplit.split.z) || (screenSplit.split.y > 0.5 && splitFx < screenSplit.split.z)) {
      discard;
    }
  }
`,
  },
  uniformTypes: { split: "vec4<f32>" },
};

// ---------------------------------------------------------------------------------------
// ThermalRasterLayer fragment shader (BitmapLayer subclass, EPSG:4326)
// ---------------------------------------------------------------------------------------

const rasterUniformBlock = /* glsl */ `\
layout(std140) uniform thermalRasterUniforms {
  vec4 boundsLL;  // W, S, E, N of the raster (lon/lat)
  vec4 decodeA;   // lo, hi (R-code decode of texture A), display offset A (e.g. −frame mean), unused
  vec4 decodeB;   // same for texture B
  vec4 channel;   // display lo, hi, rampIndex, valueMix
  vec4 channelB;  // display lo, hi, rampIndex of slot B (colour cross-fade), unused
  vec4 shape;     // mix, sweepPos, feather, shape code
  vec4 lonRange;  // west, east (sweep normalisation, same as the columns), unused, unused
  vec4 fx;        // hatchOn, isoStep (°C, 0 = off), opacity, maskOn (unused for rasters)
} thermalRaster;
`;

export const thermalRasterModule = {
  name: "thermalRaster",
  vs: rasterUniformBlock,
  fs: /* glsl */ `${rasterUniformBlock}
uniform sampler2D thermalRaster_textureA;
uniform sampler2D thermalRaster_textureB;
uniform sampler2D thermalRaster_lut;
`,
  getUniforms(opts = {}) {
    const out = {};
    for (const key of Object.keys(RASTER_UNIFORM_TYPES)) if (key in opts) out[key] = opts[key];
    if (opts.textureA) out.thermalRaster_textureA = opts.textureA;
    if (opts.textureB) out.thermalRaster_textureB = opts.textureB;
    if (opts.lutTexture) out.thermalRaster_lut = opts.lutTexture;
    return out;
  },
  uniformTypes: null,
};

export const RASTER_UNIFORM_TYPES = Object.freeze({
  boundsLL: "vec4<f32>",
  decodeA: "vec4<f32>",
  decodeB: "vec4<f32>",
  channel: "vec4<f32>",
  channelB: "vec4<f32>",
  shape: "vec4<f32>",
  lonRange: "vec4<f32>",
  fx: "vec4<f32>",
});
thermalRasterModule.uniformTypes = RASTER_UNIFORM_TYPES;

export const RASTER_FS = /* glsl */ `\
#version 300 es
#define SHADER_NAME thermal-raster-fragment-shader

#ifdef GL_ES
precision highp float;
#endif

in vec2 vTexCoord;
in vec2 vTexPos;

out vec4 fragColor;

const float TILE_SIZE = 512.0;
const float PI = 3.1415926536;
const float WORLD_SCALE = TILE_SIZE / PI / 2.0;

vec2 mercator_to_lnglat(vec2 xy) {
  xy /= WORLD_SCALE;
  return degrees(vec2(xy.x - PI, atan(exp(xy.y - PI)) * 2.0 - PI * 0.5));
}

${WEIGHT_GLSL}
${LUT_GLSL}
${HATCH_GLSL}

vec3 packUVsIntoRGB(vec2 uv) {
  vec2 uv8bit = floor(uv * 256.);
  vec2 uvFraction = fract(uv * 256.);
  vec2 uvFraction4bit = floor(uvFraction * 16.);
  float fractions = uvFraction4bit.x + uvFraction4bit.y * 16.;
  return vec3(uv8bit, fractions) / 255.;
}

// NEAREST by construction: integer texel fetch, so filtering state can never blend R codes.
vec2 thermal_fetchRG(sampler2D tex, vec2 uv) {
  ivec2 size = textureSize(tex, 0);
  ivec2 px = clamp(ivec2(floor(uv * vec2(size))), ivec2(0), size - 1);
  return floor(texelFetch(tex, px, 0).rg * 255.0 + 0.5);
}

float thermal_decode(float r, vec4 decode) {
  return r < 0.5 ? -1e9 : decode.x + (r - 1.0) * (decode.y - decode.x) / 254.0 + decode.z;
}

void main(void) {
  vec2 lnglat;
  vec2 uv;
  if (bitmap.coordinateConversion < -0.5) {
    lnglat = mercator_to_lnglat(vTexPos);
    uv = vec2((lnglat.x - thermalRaster.boundsLL.x) / (thermalRaster.boundsLL.z - thermalRaster.boundsLL.x),
              (lnglat.y - thermalRaster.boundsLL.w) / (thermalRaster.boundsLL.y - thermalRaster.boundsLL.w));
  } else {
    uv = vTexCoord;
    lnglat = vec2(mix(thermalRaster.boundsLL.x, thermalRaster.boundsLL.z, uv.x), mix(thermalRaster.boundsLL.w, thermalRaster.boundsLL.y, uv.y));
  }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;

  vec2 sa = thermal_fetchRG(thermalRaster_textureA, uv);
  vec2 sb = thermal_fetchRG(thermalRaster_textureB, uv);
  float a = thermal_decode(sa.x, thermalRaster.decodeA);
  float b = thermal_decode(sb.x, thermalRaster.decodeB);
  bool na = a < -1e8;
  bool nb = b < -1e8;
  float m = thermal_weightOf(lnglat, thermalRaster.shape, thermalRaster.lonRange.xy, vec4(0.0), vec4(0.0, 0.0, 1.0, 1.0));
  bool sideB = m >= 0.5;
  vec3 rgb;
  float alpha = 1.0;
  float v;
  if (thermalRaster.channel.w > 0.5) {
    v = m <= 0.0 ? a : (m >= 1.0 ? b : mix(a, b, m));
    bool missing = m <= 0.0 ? na : (m >= 1.0 ? nb : (na || nb));
    if (missing) discard;
    rgb = thermal_lutRgb(thermalRaster_lut, v, thermalRaster.channel.x, thermalRaster.channel.y, thermalRaster.channel.z, 0.0);
  } else {
    bool okA = !na && m < 1.0;
    bool okB = !nb && m > 0.0;
    if (!okA && !okB) discard;
    vec3 ca = okA ? thermal_lutRgb(thermalRaster_lut, a, thermalRaster.channel.x, thermalRaster.channel.y, thermalRaster.channel.z, 0.0) : vec3(0.0);
    vec3 cb = okB ? thermal_lutRgb(thermalRaster_lut, b, thermalRaster.channelB.x, thermalRaster.channelB.y, thermalRaster.channelB.z, 0.0) : vec3(0.0);
    float wa = okA ? 1.0 - m : 0.0;
    float wb = okB ? m : 0.0;
    rgb = (ca * wa + cb * wb) / max(wa + wb, 1e-6);
    alpha = (okA && okB) ? 1.0 : (okA ? 1.0 - m : m);
    v = sideB ? (okB ? b : a) : (okA ? a : b);
  }

  // Isotherms on the displayed value: fwidth anti-aliased, 1 °C step, every 5th line bold.
  float isoStep = thermalRaster.fx.y;
  if (isoStep > 0.0) {
    float iso = v / isoStep;
    float w = max(fwidth(iso), 1e-4);
    float dist = abs(fract(iso + 0.5) - 0.5) / w;
    bool major = mod(floor(iso + 0.5), 5.0) < 0.5;
    float halfWidth = major ? 0.9 : 0.5;
    float line = 1.0 - clamp(dist - halfWidth, 0.0, 1.0);
    rgb = mix(rgb, vec3(0.02, 0.03, 0.05), line * (major ? 0.7 : 0.4));
  }

  float flags = sideB ? sb.y : sa.y;
  if (thermalRaster.fx.x > 0.5 && mod(flags, 2.0) > 0.5 && thermal_hatch(gl_FragCoord.xy) > 0.5) {
    rgb *= 0.65;
  }

  fragColor = vec4(rgb, alpha * thermalRaster.fx.z * layer.opacity);
  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);
  if (bool(picking.isActive) && !bool(picking.isAttribute)) {
    fragColor.rgb = packUVsIntoRGB(uv);
  }
}
`;
