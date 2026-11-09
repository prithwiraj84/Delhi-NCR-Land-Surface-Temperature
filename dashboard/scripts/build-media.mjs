/**
 * Build the static images of the content pages from the REAL web bundle in public/data:
 *
 *   public/media/lst-<mode>-<year>.webp        250 m LST rasters coloured with the dashboard's
 *                                              own ramps (solar = day, nocturne = night)
 *   public/media/lst-<mode>-<year>-thumb.webp  small versions for the year strip
 *   public/media/lst-day-2050-ssp245.webp      1 km SSP2-4.5 p50 projection (cube, UTM grid)
 *   public/media/hero-og.png                   PNG for the social preview card (Satori: no webp)
 *   public/media/districts.json                district outlines as SVG paths in the raster frame
 *   public/media/media.json                    what was written (sizes, domains, years)
 *
 * Raster encoding (raster_index.json): R = 0 nodata, else lo + (R - 1) * (hi - lo) / 254 °C.
 * Run with `npm run media` after copying a new bundle into public/data. The outputs are
 * committed, so the Next.js build itself never needs sharp.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { LUTS } from "../src/design/ramps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DATA = path.join(root, "public", "data");
const OUT = path.join(root, "public", "media");
fs.mkdirSync(OUT, { recursive: true });

const index = JSON.parse(fs.readFileSync(path.join(DATA, "raster_index.json"), "utf8"));
const RAMP = { day: "solar", night: "nocturne" };

/** Colour an encoded raster PNG with a ramp LUT; nodata -> transparent. */
async function colourRaster(file, lo, hi, ramp) {
  const { data, info } = await sharp(path.join(DATA, file)).raw().toBuffer({ resolveWithObject: true });
  const lut = LUTS[ramp];
  const out = Buffer.alloc(info.width * info.height * 4);
  const [dlo, dhi] = index.domains[ramp === "solar" ? "day" : "night"];
  for (let i = 0, p = 0; i < info.width * info.height; i += 1, p += info.channels) {
    const r = data[p];
    if (r === 0) continue;
    const v = lo + ((r - 1) * (hi - lo)) / 254;
    const t = Math.max(0, Math.min(1, (v - dlo) / (dhi - dlo)));
    const k = Math.round(t * 255) * 3;
    out[i * 4] = lut[k];
    out[i * 4 + 1] = lut[k + 1];
    out[i * 4 + 2] = lut[k + 2];
    out[i * 4 + 3] = 255;
  }
  return { buf: out, width: info.width, height: info.height };
}

const written = { rasters: [], projection: null, domains: index.domains, bounds: index.bounds };

for (const [key, fr] of Object.entries(index.frames)) {
  const ramp = RAMP[fr.mode];
  if (!ramp) continue;
  const { buf, width, height } = await colourRaster(fr.file, fr.lo, fr.hi, ramp);
  const img = () => sharp(buf, { raw: { width, height, channels: 4 } });
  const big = `lst-${fr.mode}-${fr.year}.webp`;
  const thumb = `lst-${fr.mode}-${fr.year}-thumb.webp`;
  await img().resize({ width: 960 }).webp({ quality: 82, alphaQuality: 90, effort: 6 }).toFile(path.join(OUT, big));
  await img().resize({ width: 320 }).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, thumb));
  if (fr.mode === "day" && fr.year === 2025) {
    await img().resize({ width: 560 }).png({ compressionLevel: 9, palette: true }).toFile(path.join(OUT, "hero-og.png"));
  }
  written.rasters.push({ key, mode: fr.mode, year: fr.year, tier: fr.tier, file: big, thumb, width: 960, height: Math.round((960 * height) / width) });
  console.log("raster", key);
}

// ---- 2050 SSP2-4.5 day p50 from the projection cube (1 km UTM grid) ------------------------
function readLstb(file) {
  let bytes = fs.readFileSync(file);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const headerLen = bytes.readUInt32LE(8);
  const header = JSON.parse(bytes.subarray(12, 12 + headerLen).toString("utf8"));
  const start = 12 + headerLen + ((8 - ((12 + headerLen) % 8)) % 8);
  const cols = {};
  const Ctor = { int16: Int16Array, uint8: Uint8Array, int32: Int32Array, float32: Float32Array, uint16: Uint16Array };
  for (const c of header.columns) {
    const T = Ctor[c.dtype];
    const ab = bytes.buffer.slice(bytes.byteOffset + start + c.byte_offset, bytes.byteOffset + start + c.byte_offset + c.byte_length);
    cols[c.name] = { ...c, raw: new T(ab) };
  }
  return { header, cols };
}
const cells = readLstb(path.join(DATA, "cells.lstb.gz"));
const cube = readLstb(path.join(DATA, "cube_ssp245_day.lstb.gz"));
const grid = cells.header.meta.grid;
const f = cube.header.meta.frames.indexOf(2050);
if (f >= 0) {
  const n = cells.header.n;
  const p50 = cube.cols.p50;
  const lut = LUTS.solar;
  const [dlo, dhi] = index.domains.day;
  const buf = Buffer.alloc(grid.width * grid.height * 4);
  for (let i = 0; i < n; i += 1) {
    const raw = p50.raw[f * n + i];
    if (raw === p50.nodata) continue;
    const v = raw * p50.scale + p50.offset;
    const t = Math.max(0, Math.min(1, (v - dlo) / (dhi - dlo)));
    const k = Math.round(t * 255) * 3;
    const o = (cells.cols.row.raw[i] * grid.width + cells.cols.col.raw[i]) * 4;
    buf[o] = lut[k];
    buf[o + 1] = lut[k + 1];
    buf[o + 2] = lut[k + 2];
    buf[o + 3] = 255;
  }
  await sharp(buf, { raw: { width: grid.width, height: grid.height, channels: 4 } })
    .resize({ width: 960, kernel: "nearest" })
    .webp({ quality: 82, alphaQuality: 90, effort: 6 })
    .toFile(path.join(OUT, "lst-day-2050-ssp245.webp"));
  written.projection = { file: "lst-day-2050-ssp245.webp", scenario: "ssp245", year: 2050, grid: "EPSG:32643 1 km" };
  console.log("projection 2050");
}

// ---- District outlines as SVG paths in the raster's lon/lat frame -------------------------
const districts = JSON.parse(fs.readFileSync(path.join(DATA, "districts.geojson"), "utf8"));
const [w0, s0, e0, n0] = index.bounds;
const VW = 1000;
const VH = Math.round((VW * (n0 - s0)) / (e0 - w0));
const px = ([lon, lat]) => `${(((lon - w0) / (e0 - w0)) * VW).toFixed(1)},${(((n0 - lat) / (n0 - s0)) * VH).toFixed(1)}`;
const ring = (r) => `M${r.map(px).join("L")}Z`;
const shapes = districts.features.map((ft) => {
  const g = ft.geometry;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return { name: ft.properties?.name ?? ft.properties?.shapeName ?? "", d: polys.map((p) => p.map(ring).join("")).join("") };
});
fs.writeFileSync(path.join(OUT, "districts.json"), JSON.stringify({ viewBox: [0, 0, VW, VH], districts: shapes }));
// The same outlines as a standalone overlay image (keeps ~65 kB of paths out of every HTML page).
fs.writeFileSync(
  path.join(OUT, "districts.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet"><g fill="none" stroke="rgba(10,11,16,0.6)" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round">${shapes
    .map((s) => `<path d="${s.d}"/>`)
    .join("")}</g></svg>`,
);
fs.writeFileSync(path.join(OUT, "media.json"), JSON.stringify(written, null, 2));
console.log("districts", shapes.length, "->", OUT);
