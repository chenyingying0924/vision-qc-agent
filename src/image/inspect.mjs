/**
 * Dependency-free image probing and deterministic colour metrics.
 *
 * The vision model judges semantics ("is the model posing awkwardly?"); this
 * module supplies the measurements it should not be trusted to guess
 * (pixel size, background whiteness, saturation, aspect ratio) plus the
 * ground truth the rules compare against.
 *
 * @module vision-qc-agent/image/inspect
 */
import { inflateSync } from "node:zlib";

const SUPPORTED_FORMATS = ["png", "jpeg", "webp", "gif"];

/** Sniff the container format from magic bytes. */
export function detectFormat(buffer) {
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
  if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  if (buffer.length > 6 && buffer.toString("ascii", 0, 3) === "GIF") return "gif";
  return "unknown";
}

export function mediaType(format) {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSOF) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

function webpSize(buffer) {
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length > 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length > 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length > 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: 0, height: 0 };
}

function gifSize(buffer) {
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

/**
 * Read container-level facts.
 * @param {Buffer} buffer - raw image bytes.
 * @returns {{format: string, mediaType: string, width: number, height: number, bytes: number, megapixels: number, aspect: number, aspectLabel: string, rectangle: boolean}}
 */
export function inspectImage(buffer) {
  const format = detectFormat(buffer);
  let size = { width: 0, height: 0 };
  if (format === "png") size = pngSize(buffer);
  else if (format === "jpeg") size = jpegSize(buffer);
  else if (format === "webp") size = webpSize(buffer);
  else if (format === "gif") size = gifSize(buffer);
  const { width, height } = size;
  const aspect = width > 0 && height > 0 ? width / height : 0;
  return {
    format,
    supported: SUPPORTED_FORMATS.includes(format),
    mediaType: mediaType(format),
    width,
    height,
    bytes: buffer.length,
    megapixels: Number(((width * height) / 1_000_000).toFixed(2)),
    aspect: Number(aspect.toFixed(3)),
    aspectLabel: aspectLabel(aspect),
    rectangle: width > 0 && height > 0,
  };
}

/** Bucket a width/height ratio into the label e-commerce platforms actually use. */
export function aspectLabel(aspect) {
  if (!aspect) return "unknown";
  if (Math.abs(aspect - 1) <= 0.03) return "square-1x1";
  if (Math.abs(aspect - 0.75) <= 0.04) return "portrait-3x4";
  if (Math.abs(aspect - 0.8) <= 0.04) return "portrait-4x5";
  if (Math.abs(aspect - 1.333) <= 0.05) return "landscape-4x3";
  if (Math.abs(aspect - 16 / 9) <= 0.06) return "landscape-16x9";
  if (aspect < 1) return "portrait";
  return "landscape";
}

/* ------------------------------------------------------------------ */
/* Pixel metrics (PNG only: the only container we can decode natively) */
/* ------------------------------------------------------------------ */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const prevStart = outStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[lineStart + x];
      const left = x >= channels ? out[outStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + left; break;
        case 2: value = rawByte + up; break;
        case 3: value = rawByte + ((left + up) >> 1); break;
        case 4: value = rawByte + paeth(left, up, upLeft); break;
        default: value = rawByte;
      }
      out[outStart + x] = value & 0xff;
    }
  }
  return out;
}

/**
 * Decode a PNG just far enough to sample pixels.
 * @returns {{width: number, height: number, channels: number, pixels: Buffer}|undefined}
 */
function decodePng(buffer) {
  if (detectFormat(buffer) !== "png") return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 2;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return undefined;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) return undefined;
  try {
    const raw = inflateSync(Buffer.concat(idat));
    const pixels = unfilter(raw, width, height, channels);
    return { width, height, channels, pixels };
  } catch {
    return undefined;
  }
}

function pixelAt(decoded, x, y) {
  const { channels, pixels, width } = decoded;
  const index = (y * width + x) * channels;
  if (channels === 1 || channels === 2) {
    const v = pixels[index];
    return [v, v, v];
  }
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
}

/**
 * Deterministic colour/brightness metrics for a PNG.
 * Uses a bounded pixel sample so a 6000px hero image stays fast.
 * @returns {object|undefined} metrics, or undefined for formats we cannot decode.
 */
export function analyzePngMetrics(buffer, options = {}) {
  const decoded = decodePng(buffer);
  if (!decoded) return undefined;
  const { width, height } = decoded;
  const budget = Number(options.sampleBudget) || 40_000;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / budget)));

  const histogram = new Array(16).fill(0);
  let lumaSum = 0;
  let lumaSqSum = 0;
  let saturatedPixels = 0;
  let nearWhite = 0;
  let veryWhite = 0;
  let coloredPixels = 0;
  let count = 0;
  // Subject-weighted colour: only vivid pixels, so a white backdrop cannot
  // wash out the garment colour used by the SKU consistency check.
  let subjectR = 0;
  let subjectG = 0;
  let subjectB = 0;
  let subjectPixels = 0;

  const rows = [];
  for (let y = 0; y < height; y += step) {
    let rowLuma = 0;
    let rowCount = 0;
    for (let x = 0; x < width; x += step) {
      const [r, g, b] = pixelAt(decoded, x, y);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      lumaSum += luma;
      lumaSqSum += luma * luma;
      rowLuma += luma;
      rowCount += 1;
      histogram[Math.min(15, Math.floor(luma / 16))] += 1;
      if (luma > 235) nearWhite += 1;
      if (luma > 247 && saturation < 0.1) veryWhite += 1;
      if (saturation > 0.25) saturatedPixels += 1;
      if (saturation > 0.18) coloredPixels += 1;
      if (saturation > 0.22 && luma > 24 && luma < 246) {
        subjectR += r;
        subjectG += g;
        subjectB += b;
        subjectPixels += 1;
      }
      count += 1;
    }
    rows.push(rowLuma / Math.max(1, rowCount));
  }

  // Border band statistics: the outer 6% ring approximates the backdrop.
  const band = Math.max(1, Math.floor(Math.min(width, height) * 0.06));
  let borderSum = 0;
  let borderSqSum = 0;
  let borderCount = 0;
  let borderWhiteness = 0;
  const collect = (x, y) => {
    const [r, g, b] = pixelAt(decoded, x, y);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    borderSum += luma;
    borderSqSum += luma * luma;
    if (luma > 235 && saturation < 0.12) borderWhiteness += 1;
    borderCount += 1;
  };
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < band; x += step) collect(x, y);
    for (let x = Math.max(0, width - band); x < width; x += step) collect(x, y);
  }
  for (let x = 0; x < width; x += step) {
    for (let y = 0; y < band; y += step) collect(x, y);
    for (let y = Math.max(0, height - band); y < height; y += step) collect(x, y);
  }

  const lumaMean = lumaSum / count;
  const variance = Math.max(0, lumaSqSum / count - lumaMean * lumaMean);
  const borderLuma = borderSum / Math.max(1, borderCount);
  const borderVariance = Math.max(0, borderSqSum / Math.max(1, borderCount) - borderLuma * borderLuma);

  // Subject-centre signal: background-subtracted "ink" mass inside the middle third.
  let centerInk = 0;
  let totalInk = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const [r, g, b] = pixelAt(decoded, x, y);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const ink = Math.abs(luma - borderLuma) > 24 || saturation > 0.22 ? 1 : 0;
      totalInk += ink;
      if (x > width / 3 && x < (2 * width) / 3 && y > height / 3 && y < (2 * height) / 3) {
        centerInk += ink;
      }
    }
  }

  // Row-profile spikes: a cheap proxy for high-contrast text/mark regions.
  const mean = rows.reduce((a, b) => a + b, 0) / Math.max(1, rows.length);
  const sd = Math.sqrt(
    rows.reduce((acc, value) => acc + (value - mean) ** 2, 0) / Math.max(1, rows.length),
  );
  let spikeRows = 0;
  for (let i = 1; i < rows.length - 1; i += 1) {
    const second = Math.abs(rows[i - 1] - 2 * rows[i] + rows[i + 1]);
    if (second > 12) spikeRows += 1;
  }

  return {
    sampledPixels: count,
    sampleStep: step,
    lumaMean: Number(lumaMean.toFixed(1)),
    lumaSd: Number(Math.sqrt(variance).toFixed(1)),
    borderLuma: Number(borderLuma.toFixed(1)),
    borderSd: Number(Math.sqrt(borderVariance).toFixed(1)),
    borderWhiteness: Number((borderWhiteness / Math.max(1, borderCount)).toFixed(3)),
    nearWhiteRatio: Number((nearWhite / count).toFixed(3)),
    veryWhiteRatio: Number((veryWhite / count).toFixed(3)),
    saturationRatio: Number((saturatedPixels / count).toFixed(3)),
    colorRatio: Number((coloredPixels / count).toFixed(3)),
    dominantLumaBucket: histogram.indexOf(Math.max(...histogram)) * 16,
    darkRatio: Number((histogram.slice(0, 5).reduce((a, b) => a + b, 0) / count).toFixed(3)),
    centerInkRatio: Number((centerInk / Math.max(1, totalInk)).toFixed(3)),
    highContrastRowRatio: Number((spikeRows / Math.max(1, rows.length)).toFixed(3)),
    subjectColor: subjectPixels > 0
      ? {
          r: Math.round(subjectR / subjectPixels),
          g: Math.round(subjectG / subjectPixels),
          b: Math.round(subjectB / subjectPixels),
          coverage: Number((subjectPixels / count).toFixed(3)),
        }
      : null,
  };
}

/**
 * One entry describing an image completely enough for prompts, rules and reports.
 * @param {{name: string, buffer: Buffer}} input - uploaded file.
 * @returns {object} the measurement bundle.
 */
export function measure(input) {
  const facts = inspectImage(input.buffer);
  const metrics = analyzePngMetrics(input.buffer);
  return {
    name: input.name,
    ...facts,
    metrics: metrics ?? null,
    metricsNote: metrics ? "png-pixel-sample" : `not-decodable-locally (${facts.format})`,
  };
}
