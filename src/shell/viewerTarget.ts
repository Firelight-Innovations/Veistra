/**
 * Where a file opened from anywhere goes: which File Viewer, and if a new one
 * is needed, which pane it joins.
 *
 * Pure, so the layouts that matter are testable: the shell hands over what it
 * can see (panes, their tabs, sizes, what each viewer reports, what was focused)
 * and gets back a decision. `ToolWindow` carries the decision out.
 *
 * Order, first that applies:
 *  1. A viewer already showing the file is focused.
 *  2. A viewer with no file yet takes it, so an empty viewer is filled rather
 *     than left beside a new tab.
 *  3. A single click (`preview`) takes over the cluster's clean peek viewer.
 *  4. A new viewer opens in the pane that most recently had a viewer focused, or
 *     failing that the pane of the first viewer there is.
 *  5. With no viewer at all, in the largest pane that is not the one asking,
 *     because the asker (the Explorer, search, Canvas) is what the file is
 *     being opened *beside*.
 *  6. The asking pane, only when it is the only pane.
 */
import { normalizePath, type Subject } from "./viewerSubjects";

export interface TargetPane {
  id: string;
  /** Instance ids in this pane. */
  tabs: readonly string[];
  /** Width times height, for "the largest other pane". Zero when unmeasured. */
  area: number;
}

export interface TargetLayout {
  panes: readonly TargetPane[];
  /** Every File Viewer instance in the cluster, in layout order. */
  viewerIds: readonly string[];
  subjectOf(id: string): Subject | undefined;
  /** The pane that most recently had a File Viewer focused, if any still does. */
  lastViewerPaneId: string | null;
  /** The pane of the frame that sent the request. */
  sourcePaneId: string | null;
}

export type ViewerTarget =
  | { kind: "focus"; id: string }
  | { kind: "reuse"; id: string }
  | { kind: "new"; paneId: string | undefined };

export function resolveViewerTarget(
  layout: TargetLayout,
  path: string,
  preview: boolean,
): ViewerTarget {
  const { viewerIds, subjectOf } = layout;
  const want = normalizePath(path);

  for (const id of viewerIds) {
    const subject = subjectOf(id);
    if (subject && normalizePath(subject.path) === want) return { kind: "focus", id };
  }
  for (const id of viewerIds) {
    if (!subjectOf(id)) return { kind: "reuse", id };
  }
  if (preview) {
    for (const id of viewerIds) {
      const subject = subjectOf(id);
      if (subject && subject.preview && !subject.dirty) return { kind: "reuse", id };
    }
  }
  return { kind: "new", paneId: newViewerPane(layout) };
}

/**
 * Where a file goes in an app that runs one editor per file (Blender): the
 * tab already on it, else a new tab. Never an existing tab on another file,
 * nor an "empty" one: that tab's editor may have a file of its own open, and
 * taking it over would mean closing that. `viewerIds` here are the app's
 * instances; the new tab lands where a new viewer would.
 */
export function resolveFileTabTarget(
  layout: TargetLayout,
  path: string,
): Exclude<ViewerTarget, { kind: "reuse" }> {
  const want = normalizePath(path);
  for (const id of layout.viewerIds) {
    const subject = layout.subjectOf(id);
    if (subject && normalizePath(subject.path) === want) return { kind: "focus", id };
  }
  return { kind: "new", paneId: newViewerPane(layout) };
}

function paneOf(layout: TargetLayout, id: string): string | undefined {
  return layout.panes.find((pane) => pane.tabs.includes(id))?.id;
}

function newViewerPane(layout: TargetLayout): string | undefined {
  const { panes, viewerIds, lastViewerPaneId, sourcePaneId } = layout;

  if (viewerIds.length > 0) {
    const last = panes.find((pane) => pane.id === lastViewerPaneId);
    if (last && last.tabs.some((id) => viewerIds.includes(id))) return last.id;
    return paneOf(layout, viewerIds[0]);
  }

  const others = panes.filter((pane) => pane.id !== sourcePaneId);
  if (others.length === 0) return sourcePaneId ?? panes[0]?.id;
  // Ties, including every unmeasured pane, resolve to layout order.
  return others.reduce((best, pane) => (pane.area > best.area ? pane : best)).id;
}
