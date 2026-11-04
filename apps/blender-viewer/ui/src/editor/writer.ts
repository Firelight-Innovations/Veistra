/**
 * The one-writer banner under the Veistra bar (#317, DECISIONS X6): while
 * Blender here has a file open, Veistra holds its lock, and an agent's export
 * of that file only reads it and lands as the next numbered version. The
 * banner says so in those words, so the person knows the agent cannot write
 * over what they are editing.
 */
import type { BlenderEditorInfo } from "./rpc";

/** The version the next export of a file lands as: one past the newest kept. */
export function nextVersion(versions: readonly number[]): number {
  return versions.reduce((top, n) => Math.max(top, n), 0) + 1;
}

const leaf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1) || rel;

export interface WriterBanner {
  text: string;
  /** The newest kept version, which Compare would set beside the file; `null` when there is none. */
  compareWith: number | null;
}

/**
 * The banner for this Blender, or `null` when it holds no lock: an unsaved new
 * file, or one another Blender holds (that one says so instead, as a conflict).
 * `versions` are the kept versions of the file it has open.
 */
export function writerBanner(
  editor: BlenderEditorInfo | null,
  versions: readonly number[],
): WriterBanner | null {
  if (!editor?.lock || !editor.file || editor.lock.file !== editor.file) return null;
  const name = leaf(editor.file);
  const newest = versions.length > 0 ? Math.max(...versions) : null;
  return {
    text: `You have ${name} open. The agent's next export goes to v${nextVersion(versions)} beside it and never overwrites your file.`,
    compareWith: newest,
  };
}

/** What the pane says when the file Blender opened is held by another Blender. */
export function conflictText(file: string): string {
  return `${leaf(file)} is open in another Blender too, so this one holds no lock on it. Two Blenders on one file save over each other: close one of them.`;
}
