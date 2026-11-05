/**
 * The app's right-click menu. One implementation, three places it opens from:
 * a tree row, the blank space below the rows, and a tab in the strip.
 *
 * It used to live in `explorer/` and be the explorer's. It moved up here when
 * the tab strip needed one too — not for tidiness, but because the alternative
 * was `tabs/` importing a component out of `explorer/`, which would have said
 * the tab strip is built on the tree. It is not. Both are regions of this app,
 * and this is the app's menu.
 *
 * It offers: create a file, create a folder, rename, **delete**, copy the path,
 * copy it relative to the project, reveal in the OS file manager, open with the
 * default app. Which of those appear is decided field by field on `MenuTarget`
 * below.
 *
 * Why Delete is here now, when this file used to argue it should not be:
 * `docs/design-notes/files-app.md`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { canSendToAgent, putFile, relativePath } from "../../../shared/fileContext";
import { chipToAgent } from "../../../shared/context";
import { describe, openExternal, openInBlender, reveal, type EntryKind } from "./rpc";
import type { DeleteTarget } from "./useDelete";
import "./contextMenu.css";

/** Which of the two things the "New …" items make. */
export type DraftKind = "file" | "dir";

export interface MenuTarget {
  /**
   * The row or tab that was right-clicked. Blank space in the tree is the
   * project root itself: `path` is the root, `name` is `null` (so no Rename and
   * no Delete — the root is not this app's to rename or delete) and `kind` is
   * `"dir"`. `null` is for a menu with nothing to point at.
   */
  path: string | null;
  /**
   * Where a "New …" from this menu creates: a directory row itself, the folder
   * *containing* a file, or the project root for blank space.
   *
   * Decided by the opener, which is the only place that has the row's parent to
   * hand. Having it arrive resolved is what keeps this component from owning a
   * second opinion about what a path means.
   *
   * `null` drops the two create items entirely. The tab strip sets it that way:
   * a tab is a file that is *open*, not a place, and "New File" on it would
   * have to invent a folder to mean — which would be this component doing path
   * arithmetic, the one thing it is built not to do.
   */
  createIn: string | null;
  /**
   * The entry's name on disk, or `null` when there is nothing there.
   *
   * Gates **both** Rename and Delete, which is not a shortcut: each needs
   * something on disk to act on, and a tab whose file has been deleted
   * elsewhere has neither to offer. It also supplies Rename's starting text and
   * the name the delete confirmation puts in front of the user.
   */
  name: string | null;
  /** What it is, which is what decides the delete confirmation's wording. */
  kind: EntryKind | null;
  /** Viewport coordinates of the click that opened it. */
  x: number;
  y: number;
}

/** Kept off the viewport edges so the border is never flush with the frame. */
const MARGIN = 4;

/** The tooltip on a write item in a main cluster; same words as the shell's. */
const READ_ONLY_HINT = "The default branch is read-only — open a worktree to edit";

export default function ContextMenu({
  target,
  rootPath,
  readOnly = false,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: {
  target: MenuTarget;
  /** What "relative" is relative to. */
  rootPath: string;
  /** The cluster is browsing main: New, Rename and Delete are disabled. */
  readOnly?: boolean;
  /**
   * Begin naming a new entry in `target.createIn`. Nothing is created here —
   * this hands the opener an empty row to type into, and the opener calls the
   * backend when the name is committed. The menu is gone by then, which is why
   * it cannot be the thing that reports the failure.
   */
  onCreate: (parent: string, kind: DraftKind) => void;
  /** Begin renaming `path`, whose current name is `name`. Same deal as above. */
  onRename: (path: string, name: string) => void;
  /**
   * Ask whether to delete this entry. Nothing is deleted here either — the
   * caller puts the confirmation up, and only its Delete button calls the
   * backend. See `useDelete`.
   */
  onDelete: (target: DeleteTarget) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: target.x, y: target.y });
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * Clamp once the menu has a measured size.
   *
   * Positioning is `position: fixed` at the pointer, clamped inside the
   * viewport before the first paint — a layout effect, so the corrected
   * position is in place before the browser paints and the menu never appears
   * at the wrong spot for a frame. It cannot be computed up front: the width
   * depends on the longest label, and the height on how many items there are.
   */
  useLayoutEffect(() => {
    const menu = ref.current;
    const rect = menu?.getBoundingClientRect();
    if (!menu || !rect) return;

    setAt({
      x: Math.max(MARGIN, Math.min(target.x, window.innerWidth - rect.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(target.y, window.innerHeight - rect.height - MARGIN)),
    });

    // Focused here rather than with `autoFocus`, which React only reliably
    // honours on form controls — this is a `div`. `preventScroll` because the
    // menu is `position: fixed` at the pointer and has nothing to scroll into
    // view; without it the tree behind can jump.
    menu.focus({ preventScroll: true });
  }, [target]);

  // Dismissed on Escape, on a pointer down anywhere outside it, and on scroll —
  // a menu anchored to a viewport point is wrong the moment the row it belongs
  // to moves, and the honest response is to close rather than to chase.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    // Scroll does not bubble, so the tree's own scrollport is only reachable
    // from here in the capture phase. The `true` is the whole reason
    // "dismiss on scroll" works at all.
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  /**
   * Run an item, and close only if it worked.
   *
   * A failure keeps the menu open with the reason in it. This app has no other
   * surface for one — `App.tsx`'s error line belongs to calls it made itself —
   * and a Reveal that silently did nothing is indistinguishable from a Reveal
   * that opened a window behind the app.
   */
  const run = (method: string, action: () => Promise<unknown>) => {
    setFailed(null);
    void action()
      .then(onClose)
      .catch((err: unknown) => setFailed(describe(method, err)));
  };

  /**
   * Hand a naming gesture to the opener, and get out of the way.
   *
   * Not through `run`: nothing has been asked of the host yet, so there is no
   * failure for this menu to stay open and report. Whoever owns the row being
   * typed into owns whatever the call comes back with.
   */
  const begin = (start: () => void) => {
    start();
    onClose();
  };

  // Narrowed once, so the items below do not each have to re-prove that a
  // blank-space menu has no path.
  const { path, createIn, name, kind } = target;
  // The root is a folder with nothing above it in the tree: "relative to the
  // project" is the empty string, and opening it as a document means nothing.
  const isRoot = path !== null && path === rootPath;

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: at.x, top: at.y }}
      // The menu itself takes focus on open, rather than its first item; the
      // opener hands focus back when it closes.
      //
      // The goal is only ever to get the keyboard *off* whatever is behind it —
      // the tree's arrow keys, the strip's roving focus — and which item is
      // first now depends on the target: a tab menu has no creates, and a menu
      // over a file that is gone has no Rename either. Focusing the container
      // is the one answer that is right for every combination, where an
      // `autoFocus` pinned to a particular button would land nowhere the moment
      // that button was conditional. Tab still reaches the items in order.
      tabIndex={-1}
      // A right-click *on* the menu should do nothing, not raise the webview's
      // own menu on top of this one.
      onContextMenu={(event) => event.preventDefault()}
    >
      {createIn !== null && (
        <>
          <button
            type="button"
            className="menu__item"
            role="menuitem"
            disabled={readOnly}
            title={readOnly ? READ_ONLY_HINT : undefined}
            onClick={() => begin(() => onCreate(createIn, "file"))}
          >
            New File
          </button>
          <button
            type="button"
            className="menu__item"
            role="menuitem"
            disabled={readOnly}
            title={readOnly ? READ_ONLY_HINT : undefined}
            onClick={() => begin(() => onCreate(createIn, "dir"))}
          >
            New Folder
          </button>
        </>
      )}

      {path !== null && name !== null && (
        <>
          {createIn !== null && <div className="menu__rule" role="separator" />}
          <button
            type="button"
            className="menu__item"
            role="menuitem"
            disabled={readOnly}
            title={readOnly ? READ_ONLY_HINT : undefined}
            onClick={() => begin(() => onRename(path, name))}
          >
            Rename
          </button>
          <button
            type="button"
            // Marked, so the one item that destroys something does not sit in a
            // list of seven looking exactly like Copy path. It is still an
            // ordinary menu item — the actual guard is the confirmation it
            // opens, not the colour of the word.
            className="menu__item menu__item--danger"
            role="menuitem"
            disabled={readOnly}
            title={readOnly ? READ_ONLY_HINT : undefined}
            onClick={() => begin(() => onDelete({ path, name, kind: kind ?? "file" }))}
          >
            Delete
          </button>
        </>
      )}

      {/* Everything below needs something to have been clicked. Over blank
          space there is no path to copy, reveal or open, and a menu that
          offered them greyed out would be four rows of nothing. */}
      {path !== null && (
        <>
          {!isRoot && canSendToAgent(target) && (
            <>
              <div className="menu__rule" role="separator" />
              <button
                type="button"
                className="menu__item"
                role="menuitem"
                onClick={() =>
                  // Stored, then one chip on the prompt of the agent last worked in.
                  run("context/put", async () => {
                    const said = await chipToAgent(
                      await putFile(path, relativePath(rootPath, path)),
                    );
                    if (!said.delivered) throw new Error(`no agent took it: ${said.reason}`);
                  })
                }
              >
                Send to agent
              </button>
            </>
          )}
          <div className="menu__rule" role="separator" />
          <button
            type="button"
            className="menu__item"
            role="menuitem"
            onClick={() => run("clipboard", () => navigator.clipboard.writeText(path))}
          >
            Copy path
          </button>
          {!isRoot && (
            <button
              type="button"
              className="menu__item"
              role="menuitem"
              onClick={() =>
                run("clipboard", () => navigator.clipboard.writeText(relativeTo(rootPath, path)))
              }
            >
              Copy relative path
            </button>
          )}
          <div className="menu__rule" role="separator" />
          <button
            type="button"
            className="menu__item"
            role="menuitem"
            // `reveal` selects an item inside its parent; for the root that would
            // open the folder *above* the project, so the root is opened itself.
            onClick={() =>
              isRoot
                ? run("files/open-external", () => openExternal(path))
                : run("files/reveal", () => reveal(path))
            }
          >
            Reveal in File Explorer
          </button>
          {!isRoot && (
            <button
              type="button"
              className="menu__item"
              role="menuitem"
              onClick={() => run("files/open-external", () => openExternal(path))}
            >
              Open with the default app
            </button>
          )}
          {/* Only for a .blend: the OS may not associate it with Blender at
              all, and this one says so when Blender is not installed. Blender
              can save into what it opens, so main refuses it as a write. */}
          {kind !== "dir" && /\.blend$/i.test(path) && (
            <button
              type="button"
              className="menu__item"
              role="menuitem"
              disabled={readOnly}
              title={readOnly ? READ_ONLY_HINT : undefined}
              onClick={() => run("files/open-in-blender", () => openInBlender(path))}
            >
              Open in Blender
            </button>
          )}
        </>
      )}

      {failed && <p className="app__error menu__error">{failed}</p>}
    </div>
  );
}

/**
 * The path as written from the project root.
 *
 * A prefix strip rather than a path calculation: both strings came out of the
 * same backend on the same machine, so the root really is a textual prefix of
 * anything below it, and the separator is whatever it already used. A path
 * that somehow is not under the root copies whole rather than producing a
 * plausible-looking wrong answer — see the note in `rpc.ts` about the frontend
 * not being the second implementation of path semantics.
 */
function relativeTo(rootPath: string, path: string): string {
  if (!path.startsWith(rootPath)) return path;
  return path.slice(rootPath.length).replace(/^[\\/]+/, "");
}
