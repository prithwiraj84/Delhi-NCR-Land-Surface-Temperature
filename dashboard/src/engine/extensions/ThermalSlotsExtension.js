/**
 * ThermalSlotsExtension (UI_SPEC §6.2, milestone M2): the GPU half of the two-slot contract.
 *
 * Adds three instanced attributes to a ThermalColumnLayer:
 *   instanceValueA / instanceValueB  float32 display values of the two slots (SLOT_NODATA = nodata)
 *   instanceThermalAux               uint8×4 raw: VSUP code A, VSUP code B, AOA bits, brush flag
 * supplied as binary `data.attributes.{getValueA, getValueB, getThermalAux}`. They are rebound
 * only when the frame bracket (or the layer content) changes — 2 × n × 4 B — while scrubbing
 * changes only uniforms, so a 55k-cell scrub costs one uniform-buffer write per frame.
 *
 * Uniforms come from the layer prop `thermal` (an object the engine rebuilds per frame; see
 * THERMAL_UNIFORM_TYPES in shaders/thermal.glsl.js) and the atlas texture from `thermalLut`
 * (a luma Texture owned by the engine, shared by every layer). Elevation is injected through
 * `vs:DECKGL_FILTER_SIZE` with `getElevation` the constant 0 — no deck.gl source is patched.
 */

import { LayerExtension } from "@deck.gl/core";
import { thermalColumnModule, thermalSlotsModule } from "../shaders/thermal.glsl.js";

const slotsModule = { ...thermalSlotsModule, dependencies: [thermalColumnModule] };

const DEFAULT_THERMAL = Object.freeze({
  slotA: [0, 1, 0, 0],
  slotB: [0, 1, 0, 0],
  shape: [0, 0, 0.08, 0],
  lonRange: [0, 1, 1, 0],
  radial: [0, 0, 1, 0],
  planar: [0, 0, 1, 1],
  height: [0, 0, 1, 6],
  elev: [3000, 1000, 1000, 1],
  fx: [1, 1, 0, 0],
});

const defaultProps = {
  thermal: { type: "object", value: DEFAULT_THERMAL, compare: false },
  thermalLut: { type: "object", value: null, compare: false },
  getValueA: { type: "accessor", value: 0 },
  getValueB: { type: "accessor", value: 0 },
  getThermalAux: { type: "accessor", value: [0, 0, 0, 1] },
};

export default class ThermalSlotsExtension extends LayerExtension {
  getShaders() {
    return { modules: [slotsModule], defines: { THERMAL_SLOTS: 1 } };
  }

  initializeState() {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      instanceValueA: { size: 1, type: "float32", accessor: "getValueA", defaultValue: 0 },
      instanceValueB: { size: 1, type: "float32", accessor: "getValueB", defaultValue: 0 },
      instanceThermalAux: { size: 4, type: "uint8", accessor: "getThermalAux", defaultValue: [0, 0, 0, 1] },
    });
  }

  draw() {
    const { thermal, thermalLut } = this.props;
    const props = { ...DEFAULT_THERMAL, ...(thermal ?? {}) };
    if (thermalLut) props.lutTexture = thermalLut;
    this.setShaderModuleProps({ thermal: props });
  }
}

ThermalSlotsExtension.extensionName = "ThermalSlotsExtension";
ThermalSlotsExtension.defaultProps = defaultProps;
