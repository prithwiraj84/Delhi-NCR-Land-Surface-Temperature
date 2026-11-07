/**
 * ScreenSplitExtension (UI_SPEC D11, §3.10): compare by discarding fragments on one side of a
 * screen-space divider. Two instances of the same layer (A keeps the left, B the right) share
 * one camera, so the split works at any pitch and bearing, on columns and rasters alike, and
 * picking stays per-side because the picking pass runs the same discard.
 *
 * Props: `splitEnabled` (bool), `splitSide` ("left" | "right": the side this instance KEEPS),
 * `splitX` (divider position as a fraction 0..1 of the canvas width).
 */

import { LayerExtension } from "@deck.gl/core";
import { screenSplitModule } from "../shaders/thermal.glsl.js";

const defaultProps = {
  splitEnabled: false,
  splitSide: "left",
  splitX: 0.5,
};

/** Drawing-buffer width in device pixels (gl_FragCoord space), with safe fallbacks. */
function bufferWidth(layer) {
  try {
    const ctx = layer.context.device.getDefaultCanvasContext?.() ?? layer.context.device.canvasContext;
    const size = ctx?.getDrawingBufferSize?.();
    if (size && size[0] > 0) return size[0];
  } catch (_error) {
    // fall through to the viewport estimate
  }
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return Math.max(1, (layer.context.viewport?.width ?? 1) * dpr);
}

export default class ScreenSplitExtension extends LayerExtension {
  getShaders() {
    return { modules: [screenSplitModule] };
  }

  draw() {
    const { splitEnabled, splitSide, splitX } = this.props;
    const x = Number.isFinite(splitX) ? Math.max(0, Math.min(1, splitX)) : 0.5;
    this.setShaderModuleProps({
      screenSplit: { split: [splitEnabled ? 1 : 0, splitSide === "right" ? 1 : 0, x, bufferWidth(this)] },
    });
  }
}

ScreenSplitExtension.extensionName = "ScreenSplitExtension";
ScreenSplitExtension.defaultProps = defaultProps;
