import { describe, expect, it } from "vitest";
import { decodeTga } from "./tga";

function header(fields: { type: number; depth: number; descriptor?: number; map?: number[] }) {
  const h = new Uint8Array(18);
  const view = new DataView(h.buffer);
  h[2] = fields.type;
  if (fields.map) {
    h[1] = 1;
    view.setUint16(5, fields.map[0], true);
    h[7] = fields.map[1];
  }
  view.setUint16(12, 2, true);
  view.setUint16(14, 2, true);
  h[16] = fields.depth;
  h[17] = fields.descriptor ?? 0;
  return [...h];
}

const BGR = { red: [0, 0, 255], green: [0, 255, 0], blue: [255, 0, 0], white: [255, 255, 255] };
const RGBA = { red: [255, 0, 0, 255], green: [0, 255, 0, 255], blue: [0, 0, 255, 255] };

const pixel = (image: ReturnType<typeof decodeTga>, x: number, y: number) =>
  Array.from(image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));

describe("decodeTga", () => {
  it("flips a bottom-up 24-bit image so its first row is the top", () => {
    // Bottom row: blue, white. Top row: red, green.
    const bytes = new Uint8Array([
      ...header({ type: 2, depth: 24 }),
      ...BGR.blue,
      ...BGR.white,
      ...BGR.red,
      ...BGR.green,
    ]);
    const image = decodeTga(bytes);
    expect(pixel(image, 0, 0)).toEqual(RGBA.red);
    expect(pixel(image, 1, 0)).toEqual(RGBA.green);
    expect(pixel(image, 0, 1)).toEqual(RGBA.blue);
  });

  it("keeps a top-down image's order and reads 32-bit alpha", () => {
    const bytes = new Uint8Array([
      ...header({ type: 2, depth: 32, descriptor: 0x28 }),
      ...[0, 0, 255, 128],
      ...[0, 255, 0, 255],
      ...[255, 0, 0, 255],
      ...[255, 255, 255, 255],
    ]);
    expect(pixel(decodeTga(bytes), 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it("draws 32-bit pixels opaque when no pixel has any alpha", () => {
    const bytes = new Uint8Array([
      ...header({ type: 2, depth: 32, descriptor: 0x20 }),
      ...[0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0],
    ]);
    expect(pixel(decodeTga(bytes), 1, 1)).toEqual(RGBA.red);
  });

  it("expands run-length packets, both repeated and literal", () => {
    // One repeat packet of 3 reds, then one literal packet of a single green.
    const bytes = new Uint8Array([
      ...header({ type: 10, depth: 24, descriptor: 0x20 }),
      0x82,
      ...BGR.red,
      0x00,
      ...BGR.green,
    ]);
    const image = decodeTga(bytes);
    expect(pixel(image, 1, 0)).toEqual(RGBA.red);
    expect(pixel(image, 0, 1)).toEqual(RGBA.red);
    expect(pixel(image, 1, 1)).toEqual(RGBA.green);
  });

  it("looks colour-mapped pixels up in the palette", () => {
    const bytes = new Uint8Array([
      ...header({ type: 1, depth: 8, descriptor: 0x20, map: [2, 24] }),
      ...BGR.red,
      ...BGR.blue,
      ...[1, 0, 0, 1],
    ]);
    const image = decodeTga(bytes);
    expect(pixel(image, 0, 0)).toEqual(RGBA.blue);
    expect(pixel(image, 1, 0)).toEqual(RGBA.red);
  });

  it("refuses a truncated file and an unknown type with a readable sentence", () => {
    expect(() => decodeTga(new Uint8Array([...header({ type: 2, depth: 24 }), 1, 2]))).toThrow(
      /truncated/,
    );
    expect(() => decodeTga(new Uint8Array(header({ type: 32, depth: 24 })))).toThrow(/type 32/);
  });
});
