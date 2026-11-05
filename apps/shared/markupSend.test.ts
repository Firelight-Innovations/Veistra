/**
 * How a markup reaches the agent, for both viewers that have markup. One
 * implementation, so the two differ only in the key prefix and the label.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@veistra/bridge", () => ({ invoke }));

import type { MarkupJson } from "@veistra/markup";
import {
  BLENDER_TARGET,
  GODOT_TARGET,
  markupToAgent,
  putMarkup,
  putMarkupItems,
  sendMarkup,
} from "./markupFlow";

const markup: MarkupJson = {
  version: 1,
  source: { kind: "scene", glb: ".veistra/blender/bed.glb" },
  size: { width: 640, height: 360 },
  pins: [{ n: 1, note: "thinner", nodePath: "Bed/Frame" }],
  annotations: [],
  excalidraw: { elements: [], appState: { viewBackgroundColor: "transparent" } },
};
const png = () => new Blob([new Uint8Array([65, 66, 67])]);
const JSON_ITEM = { id: "json", path: "C:/env/.veistra/context/markup.json" };

beforeEach(() => {
  invoke.mockReset();
  // The JSON is put first, so the picture's prompt can name its file.
  invoke.mockResolvedValueOnce(JSON_ITEM).mockResolvedValueOnce({ id: "png" });
});

describe("putMarkupItems", () => {
  it.each([
    [GODOT_TARGET, "res://main.tscn", "godot/main.tscn", "Godot"],
    [BLENDER_TARGET, "art/bed.blend", "blender/art/bed.blend", "Blender"],
  ])("keys and labels the items for %j", async (target, subject, key, label) => {
    await putMarkupItems(target, png(), markup, subject);
    const notes = invoke.mock.calls[0]![1] as Record<string, string>;
    expect(notes.key).toBe(`${key}/markup-json`);
    expect(notes.kind).toBe("json");
    expect(notes.label).toBe(`${label} - markup JSON`);
    expect(JSON.parse(notes.text!)).toEqual(markup);
    expect(invoke).toHaveBeenNthCalledWith(2, "context/put", {
      key: `${key}/markup`,
      kind: "image",
      title: `${subject} - markup`,
      label: `${label} - markup`,
      bytesBase64: "QUJD",
      prompt: expect.stringContaining(`My markup of ${subject} in ${label}`),
    });
  });

  it("falls back to a generic name when nothing is chosen", async () => {
    await putMarkupItems(BLENDER_TARGET, png(), markup, null);
    expect(invoke.mock.calls[1]![1]).toMatchObject({ key: "blender/scene/markup" });
  });
});

describe("putMarkup", () => {
  it("returns the picture item, for a drag, carrying the JSON", async () => {
    expect(await putMarkup(BLENDER_TARGET, png(), markup, "bed.blend")).toEqual({
      id: "png",
      attached: [JSON_ITEM],
    });
  });
});

describe("sendMarkup", () => {
  it("answers the picture alone, for Send to make one chip, and types nothing", async () => {
    const items = await sendMarkup(BLENDER_TARGET, png(), markup, "bed.blend");
    expect(items).toEqual([{ id: "png", attached: [JSON_ITEM] }]);
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(["context/put", "context/put"]);
  });

  it("asks the agent through the picture's prompt, which names the JSON's file", async () => {
    await sendMarkup(GODOT_TARGET, png(), markup, "res://m.tscn");
    const [notes, picture] = invoke.mock.calls.map(([, p]) => p as { prompt?: string });
    expect(picture.prompt).toMatch(/markup of res:\/\/m\.tscn in Godot/);
    expect(picture.prompt).toContain(`The markup JSON is at ${JSON_ITEM.path}; open it.`);
    expect(notes.prompt).toMatch(/as JSON/);
  });
});

describe("markupToAgent", () => {
  it("puts one chip on the agent's prompt, the picture's, named as the strip names it", async () => {
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce({ ...JSON_ITEM, source: { label: "Blender - markup JSON" } })
      .mockResolvedValueOnce({ id: "png", source: { label: "Blender - markup" } })
      .mockResolvedValue({ delivered: 1 });
    expect(await markupToAgent(BLENDER_TARGET, png(), markup, "bed.blend")).toBe(
      "Markup sent to the agent.",
    );
    expect(invoke.mock.calls.slice(2)).toEqual([
      ["veistra/attach-to-agent", { contextId: "png", label: "Blender - markup" }],
    ]);
  });

  it("types both references at a terminal, which cannot read the prompt", async () => {
    invoke.mockResolvedValueOnce({ delivered: 0 }).mockResolvedValueOnce({ inserted: true });
    expect(await markupToAgent(GODOT_TARGET, png(), markup, "res://m.tscn")).toBe(
      "Markup sent to the agent.",
    );
    expect(invoke).toHaveBeenLastCalledWith("context/insert", { itemIds: ["png", "json"] });
  });

  it("says where the markup is when no agent took it", async () => {
    invoke
      .mockResolvedValueOnce({ delivered: 0 })
      .mockResolvedValueOnce({ inserted: false, reason: "no agent is running here" });
    expect(await markupToAgent(GODOT_TARGET, png(), markup, "res://m.tscn")).toBe(
      "The markup is in the Context strip, but no agent took it: no agent is running here.",
    );
  });
});
