import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@veistra/bridge", () => ({ invoke }));

import type { MarkupJson } from "@veistra/markup";
import { base64Blob, keepMarkup, markupJsonText, putFrame, putMarkup, treeText } from "./context";
import type { GodotNode } from "./rpc";

const nodes: GodotNode[] = [
  {
    path: "World",
    name: "World",
    type: "Node3D",
    children: [
      {
        path: "World/Player",
        name: "Player",
        type: "CharacterBody3D",
        script: "res://player.gd",
        children: [],
      },
      {
        path: "World/Wing",
        name: "Wing",
        type: "Node3D",
        instance: "res://wing.tscn",
        children: [],
      },
    ],
  },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ id: "ctx-1" });
});

describe("treeText", () => {
  it("indents by depth and names the script or scene behind a node", () => {
    expect(
      treeText({ scenePath: "res://main.tscn", source: "headless", nodes }).split("\n"),
    ).toEqual([
      "Godot scene res://main.tscn (read by Godot)",
      "World (Node3D)",
      "  Player (CharacterBody3D) - script res://player.gd",
      "  Wing (Node3D) - scene res://wing.tscn",
    ]);
  });

  it("says when the tree came from the scene file", () => {
    expect(treeText({ scenePath: "res://m.tscn", source: "parsed", nodes: [] })).toContain(
      "read from the scene file",
    );
  });
});

describe("putFrame", () => {
  it("sends the frame as an image with its bytes", async () => {
    await putFrame("QUJD", "res://main.tscn");
    expect(invoke).toHaveBeenCalledWith("context/put", {
      key: "godot/main.tscn/frame",
      kind: "image",
      title: "res://main.tscn - rendered view",
      label: "Godot - rendered view",
      bytesBase64: "QUJD",
      prompt: expect.stringContaining("res://main.tscn renders right now"),
    });
  });
});

const markup: MarkupJson = {
  version: 1,
  source: { kind: "scene", glb: ".veistra/preview/godot/main_tscn.glb" },
  size: { width: 640, height: 360 },
  pins: [{ n: 1, note: "too tall", nodePath: "World/Player" }],
  annotations: [],
  excalidraw: { elements: [], appState: { viewBackgroundColor: "transparent" } },
};

describe("markupJsonText", () => {
  it("keeps the whole document when it fits", () => {
    expect(JSON.parse(markupJsonText(markup))).toEqual(markup);
  });

  it("leaves out the raw drawing, and says so, when the document is too large for the store", () => {
    const stroke = {
      id: "s",
      type: "freedraw",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      points: Array.from({ length: 30000 }, (_, i): [number, number] => [i, i]),
    };
    const big: MarkupJson = {
      ...markup,
      excalidraw: { elements: [stroke], appState: { viewBackgroundColor: "transparent" } },
    };
    const parsed = JSON.parse(markupJsonText(big));
    expect(parsed.excalidrawOmitted).toBe(true);
    expect(parsed.excalidraw.elements).toEqual([]);
    expect(parsed.pins).toEqual(markup.pins);
    expect(parsed.source).toEqual(markup.source);
  });
});

describe("putMarkup", () => {
  it("sends the JSON and the picture under stable keys and returns the picture's item", async () => {
    invoke.mockResolvedValueOnce({ id: "ctx-json" }).mockResolvedValueOnce({ id: "ctx-png" });
    const png = new Blob([new Uint8Array([65, 66, 67])]);
    const ref = await putMarkup(png, markup, "res://main.tscn");
    expect(ref).toEqual({ id: "ctx-png", attached: [{ id: "ctx-json" }] });
    const first = invoke.mock.calls[0]![1] as { key: string; kind: string; text: string };
    expect(first.key).toBe("godot/main.tscn/markup-json");
    expect(first.kind).toBe("json");
    expect(JSON.parse(first.text)).toEqual(markup);
    expect(invoke).toHaveBeenNthCalledWith(2, "context/put", {
      key: "godot/main.tscn/markup",
      kind: "image",
      title: "res://main.tscn - markup",
      label: "Godot - markup",
      bytesBase64: "QUJD",
      prompt: expect.stringContaining("My markup of res://main.tscn"),
    });
  });
});

describe("keepMarkup", () => {
  it("saves the picture as base64 and the JSON as text under the scene", async () => {
    invoke.mockResolvedValue({ savedAt: 1 });
    await keepMarkup(new Blob([new Uint8Array([65, 66, 67])]), markup, "res://main.tscn");
    expect(invoke).toHaveBeenCalledWith("godot-viewer/markup-save", {
      scene: "res://main.tscn",
      pngBase64: "QUJD",
      json: JSON.stringify(markup),
    });
  });
});

describe("base64Blob", () => {
  it("round-trips the bytes", async () => {
    const blob = base64Blob("QUJD");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
  });
});
