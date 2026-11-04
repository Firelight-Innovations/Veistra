/** The Blender toolbar chip: stale, fresh, unexported and exporting. */
import { describe, expect, it } from "vitest";
import { exportChip } from "./chip";
import type { BlenderViewerState, ExportJob } from "./rpc";

const NOW = 1_700_000_000_000;

const IDLE: ExportJob = {
  running: false,
  blend: null,
  startedAt: null,
  finishedAt: null,
  step: 0,
  total: 0,
  label: "",
  log: [],
  outcome: null,
  error: null,
  warnings: [],
};

const EXPORTED: BlenderViewerState = {
  blender: {
    found: true,
    path: "C:/b/blender.exe",
    source: "path",
    version: "4.2",
    major: 4,
    supported: true,
    configuredMissing: false,
  },
  project: true,
  readOnly: false,
  editor: { surface: "embedded", reason: null, code: null },
  environment: { kind: "localWorktree", branch: "wt/bed" },
  blends: [{ path: "C:/p/bed.blend", rel: "bed.blend", mtime: 1, size: 1 }],
  blend: "C:/p/bed.blend",
  rel: "bed.blend",
  model: "C:/p/.veistra/bed.glb",
  exportedAt: NOW - 3 * 60_000,
  stale: false,
  parts: [],
  renders: [],
  job: IDLE,
};

describe("exportChip", () => {
  it("says Up to date for an export that matches the .blend, with its age as the tooltip", () => {
    expect(exportChip(EXPORTED, NOW)).toEqual({
      tone: "success",
      label: "Up to date",
      title: "Rendered 3m ago.",
    });
  });

  it("warns when the .blend changed after the export", () => {
    expect(exportChip({ ...EXPORTED, stale: true }, NOW)).toMatchObject({
      tone: "warning",
      label: "Changed after export",
    });
  });

  it("says No export for a file that has never been exported, stale or not", () => {
    const none = { ...EXPORTED, model: null, exportedAt: undefined, stale: true };
    expect(exportChip(none, NOW)).toMatchObject({ tone: "idle", label: "No export" });
  });

  it("says Exporting only while this file is the one being exported", () => {
    const running = { ...IDLE, running: true, blend: "bed.blend" };
    expect(exportChip({ ...EXPORTED, job: running }, NOW)?.label).toBe("Exporting");
    const other = { ...IDLE, running: true, blend: "chair.blend" };
    expect(exportChip({ ...EXPORTED, job: other }, NOW)?.label).toBe("Up to date");
  });

  it("draws nothing when there is no .blend to describe", () => {
    expect(exportChip({ ...EXPORTED, rel: null, blend: null, blends: [] }, NOW)).toBeNull();
  });
});
