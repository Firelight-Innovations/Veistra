import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@veistra/bridge", () => ({ invoke: vi.fn(), openIn: vi.fn(), subscribe: vi.fn() }));

import { invoke, openIn } from "@veistra/bridge";
import { TARGET_MARK, type EditorReport } from "../../../shared/editorMention";
import {
  editorChip,
  editorHits,
  matchingHits,
  opensInEditor,
  revealChip,
  type EditorReports,
} from "./editorMentions";

const godot: EditorReport = {
  tool: "godot",
  project: "game",
  scene: "res://levels/main.tscn",
  scenes: ["res://levels/main.tscn", "res://ui/hud.tscn"],
  nodes: [
    { path: "Main", type: "Node3D" },
    { path: "Main/Enemy_02", type: "CharacterBody3D" },
  ],
  selected: ["Main/Enemy_02"],
};
const blender: EditorReport = {
  tool: "blender",
  scene: "art/crate.blend",
  scenes: [],
  nodes: [
    { path: "Camera", type: "CAMERA" },
    { path: "Crate", type: "MESH" },
  ],
  selected: ["Crate"],
};
const reports: EditorReports = { godot, blender };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openIn)
    .mockReset()
    .mockResolvedValue(undefined as never);
});

describe("the @ menu's editor rows", () => {
  it("lists Godot's nodes, selected first, then its open scenes, then Blender's objects", () => {
    const hits = editorHits(reports);
    expect(hits.map((h) => [h.kind, h.title])).toEqual([
      ["godot-node", "Enemy_02"],
      ["godot-node", "Main"],
      ["godot-scene", "main.tscn"],
      ["godot-scene", "hud.tscn"],
      ["blender-object", "Crate"],
      ["blender-object", "Camera"],
    ]);
    expect(hits[0]).toMatchObject({
      uri: "editor:godot:node:Main/Enemy_02",
      detail: "CharacterBody3D · main.tscn",
    });
    expect(hits[4]).toMatchObject({
      uri: "editor:blender:object:Crate",
      detail: "mesh · crate.blend",
    });
  });

  it("has nothing for an editor that is not running", () => {
    expect(editorHits({ godot: null })).toEqual([]);
  });

  it("matches what was typed against the name and the detail", () => {
    const hits = editorHits(reports);
    expect(matchingHits(hits, "enemy").map((h) => h.title)).toEqual(["Enemy_02"]);
    expect(matchingHits(hits, "MESH").map((h) => h.title)).toEqual(["Crate"]);
    expect(matchingHits(hits, " ")).toHaveLength(hits.length);
  });
});

describe("the chip a picked row becomes", () => {
  it("stores a node as a target the pane can select again", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "ctx_9" });
    const chip = await editorChip("editor:godot:node:Main/Enemy_02", reports);
    expect(chip).toEqual({
      uri: "veistra://context/ctx_9",
      title: "Godot · Enemy_02",
      kind: "godot-node",
    });
    const [method, params] = vi.mocked(invoke).mock.calls[0] as [string, { text: string }];
    expect(method).toBe("context/put");
    expect(JSON.parse(params.text)).toEqual({
      veistra: TARGET_MARK,
      tool: "godot",
      project: "game",
      scene: "res://levels/main.tscn",
      nodes: [{ path: "Main/Enemy_02", type: "CharacterBody3D" }],
    });
  });

  it("references a scene as its file, storing nothing", async () => {
    expect(await editorChip("editor:godot:scene:res://ui/hud.tscn", reports)).toEqual({
      uri: "veistra://file/game/ui/hud.tscn",
      title: "hud.tscn",
      kind: "godot-scene",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is nothing once the editor stops reporting", async () => {
    expect(await editorChip("editor:blender:object:Crate", { blender: null })).toBeNull();
    expect(await editorChip("file:x", reports)).toBeNull();
  });
});

describe("a sent chip clicked", () => {
  it("resolves a context chip and opens its editor's pane on what it holds", async () => {
    const target = {
      veistra: TARGET_MARK,
      tool: "blender",
      scene: "art/crate.blend",
      nodes: [{ path: "Crate" }],
    };
    vi.mocked(invoke).mockResolvedValue({
      kind: "context",
      parts: [{ type: "json", value: target }],
    });
    expect(await revealChip("veistra://context/ctx_9", reports)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("refs/resolve", { uri: "veistra://context/ctx_9" });
    expect(openIn).toHaveBeenCalledWith("blender-viewer", {
      reveal: { tool: "blender", scene: "art/crate.blend", nodes: ["Crate"] },
    });
  });

  it("opens a .blend without asking the host, and leaves anything else alone", async () => {
    expect(await revealChip("veistra://file/art/crate.blend", reports)).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(openIn).toHaveBeenCalledWith("blender-viewer", {
      reveal: { tool: "blender", file: "art/crate.blend" },
    });
    vi.mocked(openIn).mockClear();
    expect(await revealChip("veistra://file/notes.md", reports)).toBe(false);
    vi.mocked(invoke).mockRejectedValue(new Error("gone"));
    expect(await revealChip("veistra://context/ctx_0", reports)).toBe(false);
    expect(openIn).not.toHaveBeenCalled();
  });

  it("is a button only for an editor's own chip or a file an editor opens", () => {
    expect(opensInEditor("veistra://context/ctx_9", "godot-node", reports)).toBe(true);
    expect(opensInEditor("veistra://context/ctx_9", "blender", reports)).toBe(true);
    expect(opensInEditor("veistra://context/ctx_9", "godot-selection", reports)).toBe(false);
    expect(opensInEditor("veistra://context/ctx_9", "context", reports)).toBe(false);
    expect(opensInEditor("veistra://file/game/player.gd", "file", reports)).toBe(true);
    expect(opensInEditor("veistra://file/notes.md", "file", reports)).toBe(false);
  });
});
