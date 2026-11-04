/**
 * Truevision TGA, decoded to RGBA. Still the default texture export of a lot of
 * game-art tooling, and the one common raster format a browser's `<img>` will
 * not draw (issue #342).
 *
 * Covers what those tools write: true-colour (16, 24 and 32 bit), greyscale and
 * colour-mapped images, raw or run-length encoded, in either row order.
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, rows top-down. */
  rgba: Uint8ClampedArray;
}

const HEADER = 18;
const MAX_SIDE = 16384;

/** Throws a sentence a person can read when the bytes are not a TGA this handles. */
export function decodeTga(bytes: Uint8Array): DecodedImage {
  if (bytes.length < HEADER) throw new Error("This file is too short to be a TGA image.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const mapType = bytes[1];
  const type = bytes[2];
  const mapFirst = view.getUint16(3, true);
  const mapLength = view.getUint16(5, true);
  const mapDepth = bytes[7];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const depth = bytes[16];
  const descriptor = bytes[17];

  const rle = type >= 9;
  const kind = rle ? type - 8 : type;
  if (![1, 2, 3].includes(kind)) throw new Error(`TGA image type ${type} is not supported.`);
  if (width === 0 || height === 0 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`A ${width} × ${height} TGA cannot be shown.`);
  }

  let at = HEADER + idLength;
  const readColour = colourReader(bytes, kind === 1 ? mapDepth : depth, kind === 3);
  let palette: Uint8Array | null = null;
  if (mapType === 1) {
    const entry = Math.ceil(mapDepth / 8);
    palette = new Uint8Array(mapLength * 4);
    for (let i = 0; i < mapLength; i += 1) palette.set(readColour(at + i * entry), i * 4);
    at += mapLength * entry;
  }
  if (kind === 1 && palette === null) throw new Error("This colour-mapped TGA has no palette.");

  const stride = Math.ceil(depth / 8);
  const pixelAt = (offset: number): ArrayLike<number> => {
    if (kind !== 1) return readColour(offset);
    const index = (stride === 2 ? view.getUint16(offset, true) : bytes[offset]) - mapFirst;
    return (palette as Uint8Array).subarray(index * 4, index * 4 + 4);
  };

  // Decode in file order, then place each row by the descriptor's origin bits.
  const count = width * height;
  const pixels = new Uint8ClampedArray(count * 4);
  let written = 0;
  const need = (bytesWanted: number) => {
    if (at + bytesWanted > bytes.length) throw new Error("This TGA image is truncated.");
  };
  while (written < count) {
    let run = 1;
    let repeat = false;
    if (rle) {
      need(1);
      const packet = bytes[at];
      at += 1;
      run = (packet & 0x7f) + 1;
      repeat = (packet & 0x80) !== 0;
    }
    run = Math.min(run, count - written);
    need(repeat ? stride : stride * run);
    for (let i = 0; i < run; i += 1) {
      pixels.set(pixelAt(repeat ? at : at + i * stride), (written + i) * 4);
    }
    at += repeat ? stride : stride * run;
    written += run;
  }

  return { width, height, rgba: orient(pixels, width, height, descriptor, depth) };
}

/** One colour of `depth` bits at an offset, as RGBA. TGA stores BGR(A), little-endian. */
function colourReader(bytes: Uint8Array, depth: number, grey: boolean) {
  const out = new Uint8Array(4);
  return (offset: number): Uint8Array => {
    if (grey || depth === 8) {
      out[0] = out[1] = out[2] = bytes[offset];
      out[3] = 255;
    } else if (depth === 15 || depth === 16) {
      const value = bytes[offset] | (bytes[offset + 1] << 8);
      out[0] = ((value >> 10) & 0x1f) * 8.226;
      out[1] = ((value >> 5) & 0x1f) * 8.226;
      out[2] = (value & 0x1f) * 8.226;
      out[3] = depth === 16 && (value & 0x8000) === 0 ? 0 : 255;
    } else if (depth === 24 || depth === 32) {
      out[0] = bytes[offset + 2];
      out[1] = bytes[offset + 1];
      out[2] = bytes[offset];
      out[3] = depth === 32 ? bytes[offset + 3] : 255;
    } else {
      throw new Error(`${depth}-bit TGA colour is not supported.`);
    }
    return out;
  };
}

/**
 * Rows top-down and columns left-to-right, whatever the file used. Also: a
 * 16/32-bit image whose alpha is zero everywhere was written by a tool that
 * ignored alpha, not one that meant "invisible" — drawn opaque, as other
 * viewers do.
 */
function orient(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  descriptor: number,
  depth: number,
): Uint8ClampedArray {
  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  const out = new Uint8ClampedArray(pixels.length);
  let anyAlpha = false;
  for (let y = 0; y < height; y += 1) {
    const sourceRow = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const sourceX = rightToLeft ? width - 1 - x : x;
      const from = (sourceRow * width + sourceX) * 4;
      const to = (y * width + x) * 4;
      out.set(pixels.subarray(from, from + 4), to);
      if (pixels[from + 3] !== 0) anyAlpha = true;
    }
  }
  if (!anyAlpha && (depth === 16 || depth === 32)) {
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }
  return out;
}
