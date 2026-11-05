import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@veistra/bridge", () => ({ invoke: vi.fn() }));

import { invoke } from "@veistra/bridge";
import {
  asTarget,
  envPath,
  mentionItems,
  putTarget,
  resPath,
  revealFile,
  revealFor,
  revealOf,
  sendMention,
  targetLabel,
  TARGET_MARK,
  type EditorReport,
  type EditorTarget,
  type MentionEvent,
} from "./editorMention";

const mocked = vi.mocked(invoke);

const godot: EditorReport = {
  tool: "godot",
  project: "game",
  scene: "res://levels/main.tscn",
  scenes: ["res://levels/main.tscn"],
  nodes: [{ path: "Main/Enemy_02", type: "CharacterBody3D" }],
  selected: ["Main/Enemy_02"],
};

const mention = (over: Partial<MentionEvent>): MentionEvent => ({
  seq: 1,
  n: 7,
  t: 0,
  kind: "mention",
  what: "selection",
  scene: null,
  nodes: [],
  path: null,
  pngBase64: null,
  pngProblem: null,
  ...over,
});

beforeEach(() => {
  mocked
    .mockReset()
    .mockImplementation(async (method) =>
      method === "context/put" ? { id: "ctx_1" } : { delivered: 1 },
    );
});

describe("res:// and environment paths", () => {
  it("maps a project's res:// path to the environment and back", () => {
    expect(envPath("game", "res://levels/main.tscn")).toBe("game/levels/main.tscn");
    expect(envPath(".", "res://main.tscn")).toBe("main.tscn");
    expect(resPath("game", "game/levels/main.tscn")).toBe("res://levels/main.tscn");
    expect(resPath(".", "main.tscn")).toBe("res://main.tscn");
  });

  it("refuses a path that climbs out or lies in another project", () => {
    expect(envPath("game", "res://../secret.txt")).toBeNull();
    expect(envPath("game", "user://save.json")).toBeNull();
    expect(resPath("game", "other/main.tscn")).toBeNull();
    expect(resPath("game", "game/../x.tscn")).toBeNull();
  });
});

describe("the item a node or object becomes", () => {
  const target: EditorTarget = {
    veistra: TARGET_MARK,
    tool: "blender",
    scene: "art/crate.blend",
    nodes: [{ path: "Crate", type: "MESH" }],
  };

  it("is JSON the pane can select again, keyed by what it names, with a chip kind", async () => {
    const item = await putTarget(target);
    const [method, params] = mocked.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("context/put");
    expect(params.kind).toBe("json");
    expect(params.key).toBe("blender/art/crate.blend/mention/Crate");
    expect(params.label).toBe("Blender · Crate");
    expect(asTarget(JSON.parse(params.text as string))).toEqual(target);
    expect(item).toEqual({ id: "ctx_1", chipKind: "blender-object" });
  });

  it("counts several things in its label", () => {
    expect(targetLabel({ ...target, nodes: [{ path: "A" }, { path: "B" }] })).toBe(
      "Blender · 2 objects",
    );
  });

  it("is not a target without the mark, a known tool and named nodes", () => {
    expect(asTarget({ ...target, veistra: "x" })).toBeNull();
    expect(asTarget({ ...target, tool: "maya" })).toBeNull();
    expect(asTarget({ ...target, nodes: [{}] })).toBeNull();
    expect(asTarget(null)).toBeNull();
  });
});

describe("mentionItems", () => {
  it("makes a Godot selection one node item, with types from the editor's state", async () => {
    const items = await mentionItems(
      "godot",
      mention({ scene: "res://levels/main.tscn", nodes: ["Main/Enemy_02"] }),
      { project: "game", root: "C:/env", node: () => ({ type: "CharacterBody3D" }) },
    );
    expect(items).toEqual([{ id: "ctx_1", chipKind: "godot-node" }]);
    const params = mocked.mock.calls[0][1] as { text: string };
    expect(JSON.parse(params.text)).toMatchObject({
      project: "game",
      scene: "res://levels/main.tscn",
      nodes: [{ path: "Main/Enemy_02", type: "CharacterBody3D" }],
    });
  });

  it("references a Godot scene where it is, and a script as plain Godot", async () => {
    const scene = await mentionItems("godot", mention({ what: "scene", scene: "res://a.tscn" }), {
      project: "game",
      root: "C:/env/",
    });
    expect(mocked.mock.calls[0][1]).toMatchObject({ kind: "file", path: "C:/env/game/a.tscn" });
    expect(scene[0].chipKind).toBe("godot-scene");
    const script = await mentionItems("godot", mention({ what: "file", path: "res://p.gd" }), {
      project: "game",
      root: "C:/env",
    });
    expect(script[0].chipKind).toBe("godot");
  });

  it("says what is missing rather than putting nothing", async () => {
    await expect(
      mentionItems("godot", mention({ what: "scene", scene: null }), { root: "C:/env" }),
    ).rejects.toThrow("named no scene");
    await expect(
      mentionItems("godot", mention({ what: "viewport", pngProblem: "No 3D view." }), {
        root: null,
      }),
    ).rejects.toThrow("No 3D view.");
  });

  it("chips what it put, and says when no agent took it", async () => {
    const done = await sendMention("blender", mention({ nodes: ["Crate"] }), {
      root: "C:/env",
      file: "crate.blend",
    });
    expect(done).toBe("In the agent's prompt.");
    expect(mocked).toHaveBeenCalledWith("veistra/attach-to-agent", {
      contextId: "ctx_1",
      label: "Context",
      kind: "blender-object",
    });
  });
});

describe("where a clicked chip goes", () => {
  it("selects the nodes a target item holds, in its tool's pane", () => {
    const value: EditorTarget = {
      veistra: TARGET_MARK,
      tool: "godot",
      project: "game",
      scene: "res://levels/main.tscn",
      nodes: [{ path: "Main/Enemy_02" }],
    };
    expect(revealFor({ kind: "context", parts: [{ type: "json", value }] }, {})).toEqual({
      app: "godot-viewer",
      reveal: {
        tool: "godot",
        project: "game",
        scene: "res://levels/main.tscn",
        nodes: ["Main/Enemy_02"],
      },
    });
    // The same JSON as text, as a store item reads back.
    const text = JSON.stringify(value);
    expect(
      revealFor({ kind: "context", parts: [{ type: "text", language: "json", text }] }, {})?.app,
    ).toBe("godot-viewer");
  });

  it("opens a .blend in Blender, and a Godot file only in the project Godot has open", () => {
    expect(revealFile("veistra://file/art/crate.blend", {})).toEqual({
      app: "blender-viewer",
      reveal: { tool: "blender", file: "art/crate.blend" },
    });
    expect(revealFile("veistra://file/game/player.gd", { godot })).toEqual({
      app: "godot-viewer",
      reveal: { tool: "godot", project: "game", file: "game/player.gd" },
    });
    expect(revealFile("veistra://file/game/player.gd", {})).toBeNull();
    expect(revealFile("veistra://file/other/player.gd", { godot })).toBeNull();
    expect(revealFile("veistra://file/notes.md", { godot })).toBeNull();
  });

  it("follows a stored file item to its file", () => {
    const r = { kind: "file", meta: { file: "veistra://file/art/crate.blend" } };
    expect(revealFor(r, {})?.app).toBe("blender-viewer");
    expect(revealFor({ kind: "context", parts: [{ type: "text", text: "hi" }] }, {})).toBeNull();
  });

  it("reads only its own tool's reveal from an open payload", () => {
    const payload = { reveal: { tool: "blender", nodes: ["Crate", 3], file: "a.blend" } };
    expect(revealOf(payload, "blender")).toEqual({
      tool: "blender",
      nodes: ["Crate"],
      file: "a.blend",
    });
    expect(revealOf(payload, "godot")).toBeNull();
    expect(revealOf({ path: "a.blend" }, "blender")).toBeNull();
  });
});
