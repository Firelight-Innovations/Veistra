import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareGlbs } from "./client";
import { handle, transferables } from "./diff.worker";
import { nudgeSplit, SPLIT_MAX, SPLIT_MIN } from "./split";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

function glb(name: string): ArrayBuffer {
  const bytes = readFileSync(join(fixtures, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * `glb` with one material, textured from `uri`, on every primitive. Here in
 * Node an image load throws (there is no DOM to decode with), so only a parse
 * that skips textures gets through.
 */
function withTexture(glb: ArrayBuffer, uri: string): ArrayBuffer {
  const view = new DataView(glb);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
  json.images = [{ uri }];
  json.textures = [{ source: 0 }];
  json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  for (const mesh of json.meshes) for (const p of mesh.primitives) p.material = 0;
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const head = new TextEncoder().encode(text);
  const rest = new Uint8Array(glb, 20 + jsonLength);
  const out = new Uint8Array(20 + head.length + rest.length);
  out.set(new Uint8Array(glb, 0, 20));
  out.set(head, 20);
  out.set(rest, 20 + head.length);
  const outView = new DataView(out.buffer);
  outView.setUint32(8, out.length, true);
  outView.setUint32(12, head.length, true);
  return out.buffer;
}

describe("the diff worker", () => {
  it("parses and diffs two glbs, and hands back every class's buffer to transfer", async () => {
    const reply = await handle({ a: glb("cube-a.glb"), b: glb("cube-b.glb") });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.result.counts).toEqual({ added: 8, changed: 2, removed: 0, unchanged: 10 });
    expect(transferables(reply)).toHaveLength(4);
  });

  it("answers a glb it cannot read with the reason, not a throw", async () => {
    const reply = await handle({ a: new ArrayBuffer(8), b: glb("cube-b.glb") });
    expect(reply).toMatchObject({ ok: false });
  });

  it("never loads a texture: a missing image costs the diff nothing", async () => {
    const textured = withTexture(glb("cube-a.glb"), "missing.png");
    const reply = await handle({ a: textured, b: textured });
    expect(reply.ok && reply.result.counts.unchanged).toBe(12);
  });
});

describe("compareGlbs", () => {
  it("runs on this thread where there is no Worker, and leaves the caller's bytes alone", async () => {
    const a = glb("cube-a.glb");
    const b = glb("cube-b.glb");
    const outcome = await compareGlbs(a, b);
    expect(outcome.where).toBe("thread");
    expect(outcome.result.counts.added).toBe(8);
    expect(a.byteLength).toBeGreaterThan(0);
  });

  it("rejects at once when already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(compareGlbs(glb("cube-a.glb"), glb("cube-b.glb"), abort.signal)).rejects.toThrow(
      "aborted",
    );
  });
});

describe("nudgeSplit", () => {
  it("moves the divider a step at a time and stops at the edges", () => {
    expect(nudgeSplit(0.5, "b")).toBe(0.35);
    expect(nudgeSplit(0.5, "a")).toBe(0.65);
    expect(nudgeSplit(0.2, "b")).toBe(SPLIT_MIN);
    expect(nudgeSplit(0.8, "a")).toBe(SPLIT_MAX);
  });
});
