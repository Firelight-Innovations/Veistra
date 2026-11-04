import { describe, expect, it } from "vitest";
import { formatBlenderVersion, parseBlend, readBlend } from "./blend";

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

/** A little-endian block: header in the given layout, then `data`. */
function block(layout: "bhead4" | "small8" | "large8", code: string, data: number[]): number[] {
  const head = new DataView(
    new ArrayBuffer(layout === "bhead4" ? 20 : layout === "small8" ? 24 : 32),
  );
  ascii(code.padEnd(4, "\0")).forEach((c, i) => head.setUint8(i, c));
  if (layout === "large8") head.setBigInt64(16, BigInt(data.length), true);
  else head.setInt32(4, data.length, true);
  return [...new Uint8Array(head.buffer), ...data];
}

/** A 2×2 thumbnail — top row red, green; bottom row blue, white — stored bottom row first, as Blender does. */
function thumbData(): number[] {
  const size = new DataView(new ArrayBuffer(8));
  size.setInt32(0, 2, true);
  size.setInt32(4, 2, true);
  const bottom = [0, 0, 255, 255, 255, 255, 255, 255];
  const top = [255, 0, 0, 255, 0, 255, 0, 255];
  return [...new Uint8Array(size.buffer), ...bottom, ...top];
}

function blendFile(header: string, layout: "bhead4" | "small8" | "large8"): Uint8Array {
  return new Uint8Array([
    ...ascii(header),
    ...block(layout, "REND", [1, 2, 3, 4]),
    ...block(layout, "TEST", thumbData()),
    ...block(layout, "GLOB", [0, 0, 0, 0]),
  ]);
}

describe("parseBlend", () => {
  it.each([
    ["BLENDER_v279", "bhead4", "2.79"],
    ["BLENDER-v402", "small8", "4.2"],
    ["BLENDER17-01v0500", "large8", "5.0"],
  ] as const)("reads %s's version and its thumbnail, top row first", (header, layout, version) => {
    const read = parseBlend(blendFile(header, layout), "none");
    if (!read.ok) throw new Error(read.reason);

    expect(read.info.version).toBe(version);
    const thumb = read.info.thumbnail;
    expect(thumb?.width).toBe(2);
    expect(thumb?.height).toBe(2);
    expect(Array.from(thumb?.rgba.subarray(0, 4) ?? [])).toEqual([255, 0, 0, 255]);
    expect(Array.from(thumb?.rgba.subarray(8, 12) ?? [])).toEqual([0, 0, 255, 255]);
  });

  it("reports no thumbnail when scene data begins first", () => {
    const bytes = new Uint8Array([
      ...ascii("BLENDER-v402"),
      ...block("small8", "GLOB", [0, 0, 0, 0]),
      ...block("small8", "TEST", thumbData()),
    ]);
    const read = parseBlend(bytes, "none");
    expect(read.ok && read.info.thumbnail).toBe(null);
  });

  it("reports no thumbnail when the head read stops inside it", () => {
    const whole = blendFile("BLENDER-v402", "small8");
    const read = parseBlend(whole.subarray(0, whole.length - 30), "none");
    expect(read.ok && read.info.thumbnail).toBe(null);
  });

  it("refuses bytes that are not a .blend", () => {
    const read = parseBlend(new Uint8Array(ascii("PK\u0003\u0004 not a blend")), "none");
    expect(read).toEqual({ ok: false, reason: "This is not a .blend file." });
  });
});

describe("readBlend", () => {
  it("reads through gzip compression, even cut short", async () => {
    const raw = blendFile("BLENDER-v402", "small8");
    const gz = await new Response(
      new Blob([raw as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const cut = new Uint8Array(gz).subarray(0, gz.byteLength - 8);

    const read = await readBlend(cut);
    if (!read.ok) throw new Error(read.reason);
    expect(read.info.compression).toBe("gzip");
    expect(read.info.thumbnail?.width).toBe(2);
  });
});

describe("formatBlenderVersion", () => {
  it("splits off the last two digits as the minor version", () => {
    expect(formatBlenderVersion(279)).toBe("2.79");
    expect(formatBlenderVersion(402)).toBe("4.2");
    expect(formatBlenderVersion(500)).toBe("5.0");
  });
});
