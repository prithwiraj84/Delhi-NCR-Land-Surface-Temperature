/**
 * Minimal synchronous PNG encoder for the in-memory fixture rasters (8-bit RGB, filter 0, zlib
 * "stored" deflate blocks). Lossless by construction, so the decoded R/G bytes equal what the
 * fixture wrote — the same guarantee the notebook's Pillow PNGs give the dashboard.
 * Not size-optimised (stored blocks); fixture rasters are tiny.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream made of stored (uncompressed) deflate blocks. */
function zlibStored(data) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b += 1) {
    const start = b * 65535;
    const len = Math.min(65535, data.length - start);
    out[o] = b === blocks - 1 ? 1 : 0;
    out[o + 1] = len & 0xff;
    out[o + 2] = (len >>> 8) & 0xff;
    out[o + 3] = ~len & 0xff;
    out[o + 4] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o + 5);
    o += 5 + len;
  }
  const ad = adler32(data);
  out[o] = (ad >>> 24) & 0xff;
  out[o + 1] = (ad >>> 16) & 0xff;
  out[o + 2] = (ad >>> 8) & 0xff;
  out[o + 3] = ad & 0xff;
  return out;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * Encode interleaved RGB bytes (length width·height·3) as a PNG.
 * @returns {Uint8Array}
 */
export function encodePngRgb(width, height, rgb) {
  if (rgb.length !== width * height * 3) throw new Error(`encodePngRgb: expected ${width * height * 3} bytes, got ${rgb.length}`);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const filtered = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    filtered[y * (stride + 1)] = 0;
    filtered.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(filtered)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
