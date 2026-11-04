/**
 * What a `.blend` says about itself without Blender: the version that saved it,
 * and the thumbnail Blender embeds near the front (issue #342).
 *
 * The layout follows Blender's own pure-Python reader,
 * `scripts/modules/_blendfile_header.py`: a 12-byte legacy header
 * (`BLENDER-v402`) or the 17-byte one Blender 5 writes (`BLENDER17-01v0500`),
 * then blocks, each a fixed header and `len` bytes. The thumbnail is the `TEST`
 * block — two ints, width and height, then RGBA rows bottom-up, as an ImBuf
 * holds them. Blender writes it before any scene data, so the first few blocks
 * are all that is ever walked.
 */

export interface BlendThumbnail {
  width: number;
  height: number;
  /** RGBA, rows top-down — already flipped from Blender's bottom-up order. */
  rgba: Uint8ClampedArray;
}

export interface BlendInfo {
  /** As Blender prints it: `4.2`, `2.79`, `5.0`. */
  version: string;
  compression: "none" | "gzip" | "zstd";
  thumbnail: BlendThumbnail | null;
}

export type BlendRead = { ok: true; info: BlendInfo } | { ok: false; reason: string };

/** Blocks walked before giving up on a thumbnail. Only `REND` blocks precede it. */
const MAX_BLOCKS_BEFORE_THUMB = 64;
/** A thumbnail bigger than this is a corrupt length, not a picture. */
const MAX_THUMB_SIDE = 1024;

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

const GZIP_MAGIC = [0x1f, 0x8b];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

/**
 * Read a `.blend` from its first bytes. A compressed file is decompressed only
 * as far as the bytes given reach, which is enough: the thumbnail is near the
 * front of the uncompressed stream too.
 */
export async function readBlend(head: Uint8Array): Promise<BlendRead> {
  if (startsWith(head, GZIP_MAGIC)) return parseBlend(await inflate(head, "gzip"), "gzip");
  if (startsWith(head, ZSTD_MAGIC)) {
    const raw = await inflate(head, "zstd").catch(() => null);
    if (raw === null) {
      return {
        ok: false,
        reason:
          "This .blend is saved with Zstandard compression, which this preview cannot read yet.",
      };
    }
    return parseBlend(raw, "zstd");
  }
  return parseBlend(head, "none");
}

/**
 * Decompress as much of a possibly truncated stream as it yields. A head read
 * cuts the stream mid-way, so the decoder's complaint about the missing end is
 * expected and ignored — the bytes before it are good.
 */
async function inflate(compressed: Uint8Array, format: string): Promise<Uint8Array> {
  const stream = new DecompressionStream(format as CompressionFormat);
  const writer = stream.writable.getWriter();
  writer.write(compressed as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // Truncated input: keep what decoded. An unknown format throws in the
    // constructor above, never here.
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface Layout {
  headerSize: number;
  littleEndian: boolean;
  /** Bytes in one block header, and where `len` sits inside it. */
  bheadSize: number;
  lenAt: number;
  lenIs64: boolean;
  version: number;
}

function layoutOf(bytes: Uint8Array): Layout | string {
  if (bytes.length < 12 || ascii(bytes, 0, 7) !== "BLENDER") return "This is not a .blend file.";
  const pointer = ascii(bytes, 7, 8);

  if (pointer === "_" || pointer === "-") {
    const endian = ascii(bytes, 8, 9);
    const version = Number(ascii(bytes, 9, 12));
    if ((endian !== "v" && endian !== "V") || !Number.isInteger(version)) {
      return "This .blend has a header this preview does not recognise.";
    }
    const pointerSize = pointer === "_" ? 4 : 8;
    // BHead4: code, len, old(u32), SDNAnr, nr. SmallBHead8: the same with a u64 `old`.
    return {
      headerSize: 12,
      littleEndian: endian === "v",
      bheadSize: 16 + pointerSize,
      lenAt: 4,
      lenIs64: false,
      version,
    };
  }

  // `BLENDER17-01v0500`: header size, pointer size, file-format version, endian, version.
  if (bytes.length < 17 || ascii(bytes, 7, 13) !== "17-01v") {
    return "This .blend is from a newer Blender than this preview understands.";
  }
  const version = Number(ascii(bytes, 13, 17));
  if (!Number.isInteger(version))
    return "This .blend has a header this preview does not recognise.";
  // LargeBHead8: code, SDNAnr, old(u64), len(i64), nr(i64).
  return { headerSize: 17, littleEndian: true, bheadSize: 32, lenAt: 16, lenIs64: true, version };
}

/** `402` → `4.2`, `279` → `2.79`, `500` → `5.0`: the last two digits are the minor version. */
export function formatBlenderVersion(version: number): string {
  return `${Math.floor(version / 100)}.${version % 100}`;
}

export function parseBlend(bytes: Uint8Array, compression: BlendInfo["compression"]): BlendRead {
  const layout = layoutOf(bytes);
  if (typeof layout === "string") return { ok: false, reason: layout };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info: BlendInfo = {
    version: formatBlenderVersion(layout.version),
    compression,
    thumbnail: null,
  };

  let at = layout.headerSize;
  for (let block = 0; block < MAX_BLOCKS_BEFORE_THUMB; block += 1) {
    if (at + layout.bheadSize > bytes.length) break;
    const code = ascii(bytes, at, at + 4).replace(/\0+$/, "");
    const len = layout.lenIs64
      ? Number(view.getBigInt64(at + layout.lenAt, layout.littleEndian))
      : view.getInt32(at + layout.lenAt, layout.littleEndian);
    const data = at + layout.bheadSize;

    if (code === "TEST") {
      info.thumbnail = thumbnailAt(bytes, view, data, len, layout.littleEndian);
      break;
    }
    // Scene data has begun; Blender writes the thumbnail before any of it.
    if (code === "GLOB" || code === "DNA1" || code === "ENDB" || len < 0) break;
    at = data + len;
  }
  return { ok: true, info };
}

function thumbnailAt(
  bytes: Uint8Array,
  view: DataView,
  data: number,
  len: number,
  littleEndian: boolean,
): BlendThumbnail | null {
  if (data + 8 > bytes.length) return null;
  const width = view.getInt32(data, littleEndian);
  const height = view.getInt32(data + 4, littleEndian);
  const pixels = width * height * 4;
  const sane = width > 0 && height > 0 && width <= MAX_THUMB_SIDE && height <= MAX_THUMB_SIDE;
  if (!sane || 8 + pixels > len || data + 8 + pixels > bytes.length) return null;

  const rgba = new Uint8ClampedArray(pixels);
  const row = width * 4;
  for (let y = 0; y < height; y += 1) {
    const from = data + 8 + (height - 1 - y) * row;
    rgba.set(bytes.subarray(from, from + row), y * row);
  }
  return { width, height, rgba };
}
