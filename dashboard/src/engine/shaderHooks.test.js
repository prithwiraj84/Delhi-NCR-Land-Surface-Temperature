/**
 * Guards the GPU elevation strategy against deck.gl / luma.gl upgrades (UI_SPEC Risks: "add a
 * test that the hook string exists in the installed shader").
 *
 * 1. The installed @deck.gl/layers ColumnLayer vertex shader still calls DECKGL_FILTER_SIZE on the
 *    local offset `pos` BEFORE projecting it, and still declares the attributes our
 *    `vs:#main-start` capture reads (positions, normals, instanceFillColors, instancePositions).
 * 2. deck still registers the `vs:DECKGL_FILTER_SIZE(inout vec3 size, VertexGeometry geometry)` hook.
 * 3. Assembling ThermalColumnLayer + ThermalSlotsExtension with deck's own shader assembler gives
 *    the order the technique relies on: globals → hook bodies → layer source → main-start capture
 *    → the hook call; and the layer's own source is included UNCHANGED (no string patching).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getShaderAssembler } from "@deck.gl/core";
import ThermalSlotsExtension from "./extensions/ThermalSlotsExtension.js";
import ScreenSplitExtension from "./extensions/ScreenSplitExtension.js";
import ThermalColumnLayer from "./layers/ThermalColumnLayer.js";
import ThermalRasterLayer from "./layers/ThermalRasterLayer.js";

const require = createRequire(import.meta.url);
const layersDist = dirname(require.resolve("@deck.gl/layers"));

/** Source text of a deck.gl `export default \`...\`` shader file. */
function shaderSource(rel) {
  const text = readFileSync(join(layersDist, rel), "utf8");
  const m = text.match(/export default `([\s\S]*?)`;/);
  if (!m) throw new Error(`no shader template in ${rel}`);
  return m[1];
}

const PLATFORM = { type: "webgl", shaderLanguage: "glsl", shaderLanguageVersion: 300, gpu: "test", features: new Set() };
const LAYER_UB = "layout(std140) uniform layerUniforms { float opacity; } layer;\n";
const CONTEXT = { defaultShaderModules: [{ name: "layer", vs: LAYER_UB, fs: LAYER_UB, uniformTypes: { opacity: "f32" } }] };

function assemble(layer) {
  layer.context = CONTEXT;
  return getShaderAssembler("glsl").assembleGLSLShaderPair({ platformInfo: PLATFORM, ...layer.getShaders() });
}

describe("installed deck.gl ColumnLayer shader (pinned ~9.4)", () => {
  const vs = shaderSource("column-layer/column-layer-vertex.glsl.js");
  const pkg = JSON.parse(readFileSync(join(layersDist, "..", "package.json"), "utf8"));

  it("is deck.gl 9.4.x", () => {
    expect(pkg.version.startsWith("9.4.")).toBe(true);
  });

  it("calls DECKGL_FILTER_SIZE on the local offset before projecting it", () => {
    const decl = vs.indexOf("vec3 pos = vec3(offset, 0.);");
    const hook = vs.indexOf("DECKGL_FILTER_SIZE(pos, geometry);");
    const project = vs.indexOf("gl_Position = project_position_to_clipspace(centroidPosition, centroidPosition64Low, pos, geometry.position);");
    expect(decl).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(decl);
    expect(project).toBeGreaterThan(hook);
  });

  it("declares the attributes the main-start capture reads", () => {
    for (const a of ["in vec3 positions;", "in vec3 normals;", "in vec3 instancePositions;", "in vec4 instanceFillColors;", "in float instanceElevations;"]) expect(vs).toContain(a);
    expect(vs).toContain("void main(void) {");
    expect(vs).toContain("DECKGL_FILTER_COLOR(vColor, geometry);");
  });

  it("deck registers the DECKGL_FILTER_SIZE hook signature", () => {
    const hooks = getShaderAssembler("glsl")._hookFunctions.map((h) => (typeof h === "string" ? h : h.hook));
    expect(hooks).toContain("vs:DECKGL_FILTER_SIZE(inout vec3 size, VertexGeometry geometry)");
    expect(hooks).toContain("fs:DECKGL_FILTER_COLOR(inout vec4 color, FragmentGeometry geometry)");
  });
});

describe("assembled ThermalColumnLayer + ThermalSlotsExtension", () => {
  const { vs, fs } = assemble(new ThermalColumnLayer({ id: "t", data: [], extensions: [new ThermalSlotsExtension(), new ScreenSplitExtension()] }));

  it("orders globals → hook bodies → layer source → capture → hook call", () => {
    const globals = vs.indexOf("vec4 thermalCol_base;");
    const sizeHook = vs.indexOf("void DECKGL_FILTER_SIZE(inout vec3 size, VertexGeometry geometry) {");
    const extrude = vs.indexOf("size.z += project_size(thermal_elevation * thermalCol_zT * column.elevationScale);");
    const attr = vs.indexOf("in vec3 positions;");
    const main = vs.indexOf("void main(void) {");
    const capture = vs.indexOf("thermalCol_zT = (positions.z + 1.0) * 0.5;");
    const compute = vs.indexOf("thermal_compute(instancePositions.xy);");
    const call = vs.indexOf("DECKGL_FILTER_SIZE(pos, geometry);");
    expect(globals).toBeGreaterThan(0);
    expect(sizeHook).toBeGreaterThan(globals);
    expect(extrude).toBeGreaterThan(sizeHook);
    expect(attr).toBeGreaterThan(extrude);
    expect(main).toBeGreaterThan(attr);
    expect(capture).toBeGreaterThan(main);
    expect(compute).toBeGreaterThan(capture);
    expect(call).toBeGreaterThan(compute);
  });

  it("includes the deck.gl layer source unchanged (no string patching)", () => {
    const original = shaderSource("column-layer/column-layer-vertex.glsl.js").split("\n").slice(1).join("\n");
    // Main-start injections are inserted right after `void main(void) {`; everything before and
    // the whole body after the injected block must be byte-identical to the installed source.
    const [head, body] = original.split("void main(void) {\n");
    expect(vs).toContain(head.trim());
    expect(vs).toContain(body.trim().slice(0, 400));
    expect(vs).toContain(body.trim().slice(-400));
  });

  it("injects the fragment hatch / brush and the screen split", () => {
    expect(fs).toContain("thermal_hatch(gl_FragCoord.xy)");
    expect(fs).toContain("screenSplit.split.x > 0.5");
    expect(fs.indexOf("screenSplit.split.x > 0.5")).toBeGreaterThan(fs.indexOf("void main(void) {"));
  });

  it("the CPU-path layer (no extension) has the top-face module but no slot code", () => {
    const cpu = assemble(new ThermalColumnLayer({ id: "c", data: [] }));
    expect(cpu.vs).toContain("thermalCol_isTop = normals.z > 0.9 ? 1.0 : 0.0;");
    expect(cpu.vs).not.toContain("thermal_compute(");
  });
});

describe("assembled ThermalRasterLayer", () => {
  it("replaces only the fragment shader and keeps the BitmapLayer vertex shader", () => {
    const { vs, fs } = assemble(new ThermalRasterLayer({ id: "r" }));
    expect(fs).toContain("#define SHADER_NAME thermal-raster-fragment-shader");
    expect(fs).toContain("thermal_fetchRG(thermalRaster_textureA, uv)");
    expect(vs).toContain("#define SHADER_NAME bitmap-layer-vertex-shader");
  });
});
