import { describe, expect, it } from "vitest";
import type { Subject } from "./viewerSubjects";
import {
  resolveFileTabTarget,
  resolveViewerTarget,
  type TargetLayout,
  type TargetPane,
} from "./viewerTarget";

const shows = (path: string, extra: Partial<Subject> = {}): Subject => ({
  path,
  preview: false,
  dirty: false,
  ...extra,
});

function layout(
  panes: TargetPane[],
  subjects: Record<string, Subject | undefined>,
  extra: Partial<TargetLayout> = {},
): TargetLayout {
  const viewerIds = panes.flatMap((p) => p.tabs).filter((id) => id.startsWith("viewer"));
  return {
    panes,
    viewerIds,
    subjectOf: (id) => subjects[id],
    lastViewerPaneId: null,
    sourcePaneId: null,
    ...extra,
  };
}

// Braden's layout: Canvas | File Explorer on the left, an empty viewer on the right.
const LEFT: TargetPane = { id: "left", tabs: ["canvas-1", "files-1"], area: 500 };
const RIGHT: TargetPane = { id: "right", tabs: ["viewer-1"], area: 800 };

describe("a file already open", () => {
  it("focuses the viewer that has it, in any pane", () => {
    const l = layout([LEFT, RIGHT], { "viewer-1": shows("C:\\p\\a.ts") }, { sourcePaneId: "left" });
    expect(resolveViewerTarget(l, "c:/p/a.ts", false)).toEqual({ kind: "focus", id: "viewer-1" });
  });

  it("keeps POSIX paths case sensitive", () => {
    const l = layout([LEFT, RIGHT], { "viewer-1": shows("/p/A.ts") }, { sourcePaneId: "left" });
    expect(resolveViewerTarget(l, "/p/a.ts", false).kind).toBe("new");
  });
});

describe("the empty viewer", () => {
  it("takes the file, instead of a new tab opening in the Explorer's pane", () => {
    const l = layout([LEFT, RIGHT], {}, { sourcePaneId: "left" });
    expect(resolveViewerTarget(l, "/p/a.ts", true)).toEqual({ kind: "reuse", id: "viewer-1" });
    expect(resolveViewerTarget(l, "/p/a.ts", false)).toEqual({ kind: "reuse", id: "viewer-1" });
  });

  it("is filled before a peek viewer is taken over", () => {
    const panes = [LEFT, { id: "right", tabs: ["viewer-1", "viewer-2"], area: 800 }];
    const l = layout(panes, { "viewer-1": shows("/p/a.ts", { preview: true }) });
    expect(resolveViewerTarget(l, "/p/b.ts", true)).toEqual({ kind: "reuse", id: "viewer-2" });
  });
});

describe("a new viewer tab", () => {
  it("joins the pane that most recently had a viewer focused", () => {
    const panes = [
      { id: "a", tabs: ["files-1", "viewer-1"], area: 300 },
      { id: "b", tabs: ["viewer-2"], area: 900 },
    ];
    const subjects = { "viewer-1": shows("/p/a.ts"), "viewer-2": shows("/p/b.ts") };
    const l = layout(panes, subjects, { lastViewerPaneId: "b", sourcePaneId: "a" });
    expect(resolveViewerTarget(l, "/p/c.ts", false)).toEqual({ kind: "new", paneId: "b" });
  });

  it("falls back to the first viewer's pane when that pane no longer has a viewer", () => {
    const panes = [LEFT, RIGHT];
    const l = layout(panes, { "viewer-1": shows("/p/a.ts") }, { lastViewerPaneId: "left" });
    expect(resolveViewerTarget(l, "/p/c.ts", false)).toEqual({ kind: "new", paneId: "right" });
  });

  it("takes over a clean peek with a single click, but never a dirty one", () => {
    const l = layout([LEFT, RIGHT], { "viewer-1": shows("/p/a.ts", { preview: true }) });
    expect(resolveViewerTarget(l, "/p/c.ts", true)).toEqual({ kind: "reuse", id: "viewer-1" });
    const dirty = layout([LEFT, RIGHT], {
      "viewer-1": shows("/p/a.ts", { preview: true, dirty: true }),
    });
    expect(resolveViewerTarget(dirty, "/p/c.ts", true).kind).toBe("new");
  });
});

describe("no viewer at all", () => {
  it("opens in the largest pane that is not the asking one", () => {
    const panes = [
      { id: "src", tabs: ["files-1"], area: 400 },
      { id: "small", tabs: ["home-1"], area: 200 },
      { id: "big", tabs: ["canvas-1"], area: 900 },
    ];
    const l = layout(panes, {}, { sourcePaneId: "src" });
    expect(resolveViewerTarget(l, "/p/a.ts", false)).toEqual({ kind: "new", paneId: "big" });
  });

  it("uses layout order among unmeasured panes", () => {
    const panes = [
      { id: "src", tabs: ["files-1"], area: 0 },
      { id: "x", tabs: ["a-1"], area: 0 },
      { id: "y", tabs: ["b-1"], area: 0 },
    ];
    const l = layout(panes, {}, { sourcePaneId: "src" });
    expect(resolveViewerTarget(l, "/p/a.ts", false)).toEqual({ kind: "new", paneId: "x" });
  });

  it("opens in the asking pane only when it is the only pane", () => {
    const only = { id: "only", tabs: ["files-1"], area: 900 };
    const l = layout([only], {}, { sourcePaneId: "only" });
    expect(resolveViewerTarget(l, "/p/a.ts", false)).toEqual({ kind: "new", paneId: "only" });
  });

  it("still picks a pane when the asker is unknown", () => {
    const l = layout([LEFT, { id: "r", tabs: ["x-1"], area: 999 }], {});
    expect(resolveViewerTarget(l, "/p/a.ts", false)).toEqual({ kind: "new", paneId: "r" });
  });
});

// Blender runs one editor per tab, so a .blend never takes over another tab.
describe("a file that opens in its own editor tab", () => {
  const blender = (ids: string[]) => ({ id: "right", tabs: ids, area: 800 });
  const tabs = (panes: TargetPane[], subjects: Record<string, Subject | undefined>) =>
    layout(panes, subjects, {
      viewerIds: panes.flatMap((p) => p.tabs).filter((id) => id.startsWith("blender")),
      sourcePaneId: "left",
    });

  it("focuses the tab already on it", () => {
    const l = tabs([LEFT, blender(["blender-1", "blender-2"])], {
      "blender-1": shows("C:\\p\\a.blend"),
      "blender-2": shows("C:\\p\\b.blend"),
    });
    expect(resolveFileTabTarget(l, "c:/p/b.blend")).toEqual({ kind: "focus", id: "blender-2" });
  });

  it("opens a new tab beside the others rather than reusing one on another file or none", () => {
    const l = tabs([LEFT, blender(["blender-1", "blender-2"])], {
      "blender-1": shows("/p/a.blend"),
    });
    expect(resolveFileTabTarget(l, "/p/c.blend")).toEqual({ kind: "new", paneId: "right" });
  });

  it("with no tab of the app yet, opens beside the asker", () => {
    const l = tabs([LEFT, { id: "right", tabs: ["viewer-1"], area: 800 }], {});
    expect(resolveFileTabTarget(l, "/p/a.blend")).toEqual({ kind: "new", paneId: "right" });
  });
});
