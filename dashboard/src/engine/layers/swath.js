/**
 * Boot-only SwathSweepLayer (UI_SPEC §3.1, §6.1 item 9): a 60 km Landsat-like descending swath
 * band sweeping NE → SW across the study area once, while the first frame develops behind it.
 * Drawn as two PathLayers (soft band + crisp leading edge) — chrome, never data. It is skipped
 * under Reduced / Off motion and shown once per session (the engine decides).
 */

import { PathLayer } from "@deck.gl/layers";
import { ALWAYS_ON_TOP } from "./overlays.js";

const SIGNAL = [69, 224, 255];
/** Landsat ground track heading ≈ 192° (descending, slightly west of south). */
const TRACK_TILT = 0.21;

/**
 * Swath centreline at progress t ∈ [0, 1] over bounds [W, S, E, N]: a line along the ground
 * track, offset perpendicular from the NE corner (t = 0) to the SW corner (t = 1).
 */
export function swathPath([west, south, east, north], t) {
  const cx = east + (west - east) * t;
  const cy = north + (south - north) * t;
  const len = Math.max(east - west, north - south) * 1.6;
  // Perpendicular to the sweep direction (NE→SW), i.e. roughly NW–SE, tilted like a track.
  const dx = 1;
  const dy = 1 + TRACK_TILT;
  const k = len / Math.hypot(dx, dy);
  return [
    [cx - dx * k, cy + dy * k],
    [cx + dx * k, cy - dy * k],
  ];
}

/** The boot swath layers at progress t (empty when t is outside (0, 1)). */
export function createSwathLayers({ bounds, t }) {
  if (!bounds || !(t > 0 && t < 1)) return [];
  const path = swathPath(bounds, t);
  const fade = Math.sin(Math.PI * t);
  return [
    new PathLayer({
      id: "boot-swath-band",
      data: [{ path }],
      getPath: (d) => d.path,
      getColor: [...SIGNAL, Math.round(38 * fade)],
      getWidth: 60000,
      widthUnits: "meters",
      capRounded: false,
      pickable: false,
      parameters: ALWAYS_ON_TOP,
    }),
    new PathLayer({
      id: "boot-swath-edge",
      data: [{ path }],
      getPath: (d) => d.path,
      getColor: [...SIGNAL, Math.round(150 * fade)],
      getWidth: 1,
      widthUnits: "pixels",
      pickable: false,
      parameters: ALWAYS_ON_TOP,
    }),
  ];
}
