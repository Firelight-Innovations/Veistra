/** The Godot Scene toolbar chip: what each state of the cached read says. */
import { describe, expect, it } from "vitest";
import { sceneChip } from "./chip";
import type { GodotViewerState, Job } from "./rpc";

const NOW = 1_700_000_000_000;

const READ: GodotViewerState = {
  project: ".",
  scenes: ["res://main.tscn", "res://hall.tscn"],
  scene: "res://main.tscn",
  renderedAt: NOW - 3 * 60_000,
  scenePath: "res://main.tscn",
  nodes: [{ path: "Main", name: "Main", type: "Node3D", children: [] }],
  source: "headless",
  godot: "4.3.stable",
  note: null,
  imageAt: null,
  job: null,
  engineFound: true,
};

function job(over: Partial<Job>): Job {
  return {
    running: false,
    phase: "",
    error: null,
    scene: "res://main.tscn",
    startedAt: NOW,
    output: [],
    ...over,
  };
}

describe("sceneChip", () => {
  it("says how long ago a cached tree was read, without claiming it is current", () => {
    const chip = sceneChip(READ, false, NOW);
    expect(chip).toMatchObject({ tone: "success", label: "Read 3m ago" });
    expect(chip?.title).toMatch(/does not notice edits/);
  });

  it("says Not read yet before the first refresh", () => {
    const chip = sceneChip({ ...READ, renderedAt: null, nodes: [] }, false, NOW);
    expect(chip).toMatchObject({ tone: "idle", label: "Not read yet" });
  });

  it("names the phase while a refresh runs", () => {
    const chip = sceneChip({ ...READ, job: job({ running: true, phase: "importing" }) }, false);
    expect(chip).toMatchObject({ tone: "info", label: "Importing..." });
  });

  it("says Failed, with the reason as its tooltip, when this scene's refresh failed", () => {
    const chip = sceneChip({ ...READ, job: job({ error: "Godot crashed" }) }, false, NOW);
    expect(chip).toEqual({ tone: "danger", label: "Failed", title: "Godot crashed" });
  });

  it("ignores a failure that belongs to another scene", () => {
    const failed = job({ error: "Godot crashed", scene: "res://hall.tscn" });
    expect(sceneChip({ ...READ, job: failed }, false, NOW)?.tone).toBe("success");
  });

  it("does not call sample data fresh", () => {
    expect(sceneChip(READ, true, NOW)).toMatchObject({ tone: "accent", label: "Sample data" });
  });

  it("draws nothing before the first answer, and No scenes for an empty project", () => {
    expect(sceneChip(null, false, NOW)).toBeNull();
    const empty = { ...READ, scenes: [], scene: null, renderedAt: null };
    expect(sceneChip(empty, false, NOW)?.label).toBe("No scenes");
  });
});
