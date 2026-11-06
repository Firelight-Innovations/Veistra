import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@veistra/bridge", () => ({ invoke: vi.fn() }));
vi.mock("./rpc", () => ({
  editorEdit: vi.fn(),
  editorOpenScene: vi.fn(),
  editorSelect: vi.fn(),
}));

import { editorEdit, editorOpenScene, editorSelect, type EditorInfo } from "./rpc";
import { godotPlace, godotReport, launchSceneFor, revealInGodot } from "./reveal";

const editor = {
  project: "game",
  view: {
    scene: "res://levels/main.tscn",
    open: ["res://levels/main.tscn", "res://ui/hud.tscn"],
    selected: [{ path: "Main/Enemy_02", type: "CharacterBody3D", script: "res://enemy.gd" }],
    nodes: [
      { path: "Main", type: "Node3D" },
      { path: "Main/Enemy_02", type: "CharacterBody3D" },
    ],
  },
} as unknown as EditorInfo;

beforeEach(() => {
  vi.mocked(editorEdit).mockReset().mockResolvedValue({ path: "" });
  vi.mocked(editorOpenScene).mockReset().mockResolvedValue({ scene: "" });
  vi.mocked(editorSelect).mockReset().mockResolvedValue({ missing: [] });
});

describe("what the Godot pane reports", () => {
  it("lists the edited scene's nodes, the open scenes and the selection", () => {
    expect(godotReport(editor)).toEqual({
      tool: "godot",
      project: "game",
      scene: "res://levels/main.tscn",
      scenes: ["res://levels/main.tscn", "res://ui/hud.tscn"],
      nodes: [
        { path: "Main", type: "Node3D" },
        { path: "Main/Enemy_02", type: "CharacterBody3D" },
      ],
      selected: ["Main/Enemy_02"],
    });
    expect(godotReport(null)).toBeNull();
  });

  it("gives a dock mention the project, the environment and each node's type and script", () => {
    const place = godotPlace(editor, "C:/env");
    expect(place).toMatchObject({ project: "game", root: "C:/env" });
    expect(place.node?.("Main/Enemy_02")).toEqual({
      type: "CharacterBody3D",
      script: "res://enemy.gd",
    });
    expect(place.node?.("Main")).toEqual({ type: "Node3D" });
  });
});

describe("a chip shown in the running Godot", () => {
  it("opens the node's scene when another is edited, then selects it", async () => {
    const said = await revealInGodot(
      {
        tool: "godot",
        project: "game",
        scene: "res://ui/hud.tscn",
        nodes: ["HUD/Bar", "HUD/Gone"],
      },
      editor,
    );
    expect(editorOpenScene).toHaveBeenCalledWith("res://ui/hud.tscn");
    expect(editorSelect).toHaveBeenCalledWith(["HUD/Bar", "HUD/Gone"]);
    expect(said).toBeNull();
  });

  it("names the nodes the scene no longer has", async () => {
    vi.mocked(editorSelect).mockResolvedValue({ missing: ["Main/Gone"] });
    const said = await revealInGodot(
      { tool: "godot", scene: "res://levels/main.tscn", nodes: ["Main/Gone"] },
      editor,
    );
    expect(editorOpenScene).not.toHaveBeenCalled();
    expect(said).toBe("Not in the scene now: Main/Gone.");
  });

  it("opens a script by its res:// path, and refuses one from another project", async () => {
    expect(await revealInGodot({ tool: "godot", file: "game/enemy.gd" }, editor)).toBeNull();
    expect(editorEdit).toHaveBeenCalledWith("res://enemy.gd");
    expect(await revealInGodot({ tool: "godot", file: "other/a.gd" }, editor)).toBe(
      "other/a.gd is not in the project game.",
    );
    expect(await revealInGodot({ tool: "godot", project: "other", nodes: ["A"] }, editor)).toBe(
      "That is in the project other; this editor has game open.",
    );
  });
});

describe("a scene opened from the Explorer", () => {
  const projects = [{ rel: "." }, { rel: "games/hall" }];

  it("starts the innermost project holding it, on that scene", () => {
    expect(launchSceneFor({ tool: "godot", file: "games/hall/levels/a.tscn" }, projects)).toEqual({
      project: "games/hall",
      scene: "res://levels/a.tscn",
    });
    expect(launchSceneFor({ tool: "godot", file: "menu.scn" }, projects)).toEqual({
      project: ".",
      scene: "res://menu.scn",
    });
  });

  it("is nothing for a script, a node reveal, or a file in no project", () => {
    expect(launchSceneFor({ tool: "godot", file: "player.gd" }, projects)).toBeNull();
    expect(
      launchSceneFor({ tool: "godot", scene: "res://a.tscn", nodes: ["A"] }, projects),
    ).toBeNull();
    expect(launchSceneFor({ tool: "godot", file: "x/a.tscn" }, [{ rel: "games/hall" }])).toBeNull();
    expect(launchSceneFor(null, projects)).toBeNull();
  });
});
