/**
 * "Save before closing?" — asked when a cluster is closed with Blender or the
 * Godot editor open in it. Those are the person's own programs, placed over
 * their panes; closing the cluster used to leave them behind as loose windows
 * over Veistra. Now the person chooses:
 *
 * - **Save & close** saves each editor's work, then quits it.
 * - **Close** quits each one without saving.
 * - **Cancel** (or Escape) keeps the cluster open.
 *
 * An editor that cannot be saved or will not quit is handed back as a window
 * of its own, asking about its unsaved work itself (`editor_close.rs`), so a
 * close that goes wrong never loses anything. Cancel is first and the one
 * `Dialog` focuses; Save & close is the primary.
 */
import Dialog from "./Dialog";
import type { OpenEditor } from "../../bindings";

export interface CloseEditorsDialogProps {
  /** The cluster's name, as its tab reads. */
  cluster: string;
  editors: OpenEditor[];
  onCancel: () => void;
  onSaveAndClose: () => void;
  onClose: () => void;
}

const APP = { blender: "Blender", godot: "Godot" } as const;

/** "Blender (house.blend)", "Godot (my-game)", "Blender (untitled)". */
export function editorLabel(editor: OpenEditor): string {
  return `${APP[editor.kind]} (${editor.name ?? "untitled"})`;
}

export default function CloseEditorsDialog({
  cluster,
  editors,
  onCancel,
  onSaveAndClose,
  onClose,
}: CloseEditorsDialogProps) {
  const one = editors.length === 1;
  return (
    <Dialog label={`Close ${cluster}`} onCancel={onCancel}>
      <div className="dialogs__confirm">
        <p>
          <strong>{cluster}</strong> has {one ? "an editor" : "editors"} open. Save{" "}
          {one ? "its" : "their"} work before closing?
        </p>
        <ul className="dialogs__confirm-list">
          {editors.map((e) => (
            <li key={e.instance}>
              {editorLabel(e)}
              {e.dirty ? " — unsaved changes" : ""}
            </li>
          ))}
        </ul>
        <div className="dialogs__confirm-actions">
          <button type="button" className="k-btn k-btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="k-btn k-btn--danger" onClick={onClose}>
            Close
          </button>
          <button type="button" className="k-btn k-btn--primary" onClick={onSaveAndClose}>
            Save &amp; close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
