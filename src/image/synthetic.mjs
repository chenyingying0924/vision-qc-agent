/**
 * Synthetic PNG encoding — used to derive test fixtures and offline probes
 * without any image library.
 *
 * @module vision-qc-agent/image/synthetic
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode an RGB pixel provider into a PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} shade
 * @returns {Buffer} PNG bytes.
 */
export function encodePng(width, height, shade) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = shade(x, y);
      const index = rowStart + 1 + x * 3;
      raw[index] = Math.max(0, Math.min(255, Math.round(r)));
      raw[index + 1] = Math.max(0, Math.min(255, Math.round(g)));
      raw[index + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Shader factories. Each takes the image size and returns either a constant
 * RGB tuple or an `(x, y) => [r, g, b]` function.
 */
const SHADERS = {
  white: () => [255, 255, 255],
  gradient: (width, height) => (x, y) => [
    40 + (200 * x) / width,
    60 + (160 * y) / height,
    180 - (120 * x) / width,
  ],
  checker: () => (x, y) => (Math.floor(x / 40) + Math.floor(y / 40)) % 2 === 0
    ? [245, 245, 245]
    : [22, 26, 36],
  /** A plausible "product on white" fixture: white field, centred dark subject. */
  subject: (width, height) => (x, y) => {
    const cx = width / 2;
    const cy = height / 2;
    const inside = Math.abs(x - cx) < width * 0.2 && Math.abs(y - cy) < height * 0.28;
    return inside ? [38, 82, 140] : [252, 252, 252];
  },
};

/**
 * Write one synthetic fixture to disk.
 * @param {string} path - output path.
 * @param {{size?: number, width?: number, height?: number, kind?: keyof SHADERS}} options
 * @returns {string} the written path.
 */
export function writeSyntheticPng(path, options = {}) {
  const width = options.width ?? options.size ?? 800;
  const height = options.height ?? options.size ?? width;
  const factory = SHADERS[options.kind ?? "subject"];
  if (!factory) throw new Error(`unknown synthetic kind "${options.kind}"`);
  const candidate = factory(width, height);
  const shade = typeof candidate === "function" ? candidate : () => candidate;
  writeFileSync(path, encodePng(width, height, shade));
  return path;
}

export { SHADERS };
