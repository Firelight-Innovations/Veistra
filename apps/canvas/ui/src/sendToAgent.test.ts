// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@veistra/bridge", () => ({ invoke: bridge.invoke }));

import type { SceneElement } from "./scene";
import {
  blobToBase64,
  putSelectionImage,
  putSpecCard,
  renderWithinLimit,
  selectedCount,
  selectionElements,
  specText,
} from "./sendToAgent";

beforeEach(() => bridge.invoke.mockReset().mockResolvedValue({ id: "ctx1" }));

describe("selectionElements", () => {
  const els: SceneElement[] = [
    { id: "frame", type: "frame" },
    { id: "in-frame", type: "rectangle", frameId: "frame" },
    { id: "box", type: "rectangle" },
    { id: "label", type: "text", containerId: "box" },
    { id: "other", type: "ellipse" },
    { id: "gone", type: "rectangle", isDeleted: true, frameId: "frame" },
  ];

  it("takes a frame with its members, and a shape with its bound text", () => {
    expect(selectionElements(els, { frame: true }).map((e) => e.id)).toEqual(["frame", "in-frame"]);
    expect(selectionElements(els, { box: true }).map((e) => e.id)).toEqual(["box", "label"]);
  });

  it("is empty with nothing selected, and never includes deleted elements", () => {
    expect(selectionElements(els, {})).toEqual([]);
    expect(selectionElements(els, undefined)).toEqual([]);
    expect(selectionElements(els, { gone: true })).toEqual([]);
    expect(selectionElements(els, { other: false })).toEqual([]);
  });

  it("counts only the ids that are on", () => {
    expect(selectedCount({ a: true, b: false, c: true })).toBe(2);
    expect(selectedCount(undefined)).toBe(0);
  });
});

describe("renderWithinLimit", () => {
  const blob = (size: number) => new Blob([new Uint8Array(size)]);

  it("keeps the largest scale that fits", async () => {
    const seen: number[] = [];
    const out = await renderWithinLimit(async (scale) => {
      seen.push(scale);
      return blob(scale >= 2 ? 500 : 50);
    }, 100);
    expect(seen).toEqual([2, 1]);
    expect(out.size).toBe(50);
  });

  it("says so when nothing fits", async () => {
    await expect(renderWithinLimit(async () => blob(500), 100)).rejects.toThrow(/too large/);
  });
});

describe("what is put in the store", () => {
  it("encodes a blob as bare base64", async () => {
    expect(await blobToBase64(new Blob(["hi"]))).toBe("aGk=");
  });

  it("sends a selection as an image with its bytes, named for canvas and count", async () => {
    await putSelectionImage(new Blob(["hi"]), "World", 3);
    expect(bridge.invoke).toHaveBeenCalledWith("context/put", {
      key: "canvas/World/selection",
      kind: "image",
      title: "Design - World, 3 elements",
      label: "Design - World",
      bytesBase64: "aGk=",
      prompt:
        "3 elements I selected on the design canvas World, as a picture. Use it for what I ask.",
    });
  });

  it("sends a spec card as JSON text that parses back", async () => {
    const json = JSON.stringify({ name: "Gurney", size_m: 2 }, null, 2);
    await putSpecCard("Gurney", "canvas/world.json", json);
    const params = bridge.invoke.mock.calls[0]![1] as {
      kind: string;
      title: string;
      text: string;
      prompt: string;
    };
    expect(params.kind).toBe("text");
    expect(params.prompt).toMatch(/spec card "Gurney"/);
    expect(params.title).toBe("Spec - Gurney");
    expect(params.text).toBe(specText("canvas/world.json", json));
    const body = params.text.split("```json\n")[1]!.split("\n```")[0]!;
    expect(JSON.parse(body)).toEqual({ name: "Gurney", size_m: 2 });
  });
});
