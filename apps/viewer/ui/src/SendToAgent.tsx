/**
 * "Send to agent" for the file on screen: the file itself, and the text
 * selected in the editor. Same wording and the same two ways in as the Blender
 * and Godot providers: click to send, or press and drag onto a terminal. What a
 * thing is called and what kind of item it becomes is `shared/fileContext`.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { SendButton } from "../../../shared/SendFooter";
import { chipToAgent, dragContext, type ContextRef } from "../../../shared/context";
import { putFile, putSelection, relativePath } from "../../../shared/fileContext";
import { activeEditor, subscribeActiveEditor } from "./viewer/activeEditor";
import { describe } from "./rpc";

interface Picked {
  startLine: number;
  endLine: number;
  text: string;
}

/** The editor's selection as a line range and its text, or `null` when empty. */
export function pickSelection(
  selection: { startLineNumber: number; endLineNumber: number; endColumn: number } | null,
  text: string,
): Picked | null {
  if (!selection || text === "") return null;
  // A selection that ends at column 1 of a line has not taken that line.
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  return { startLine: selection.startLineNumber, endLine, text };
}

export default function SendToAgent({
  path,
  rootPath,
  dirty,
  missing,
  onError,
}: {
  path: string;
  rootPath: string | null;
  dirty: boolean;
  missing: boolean;
  onError: (message: string | null) => void;
}) {
  const editor = useSyncExternalStore(subscribeActiveEditor, activeEditor);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [sent, setSent] = useState<"file" | "selection" | null>(null);
  const rel = relativePath(rootPath, path);

  useEffect(() => {
    if (!editor) {
      setPicked(null);
      return;
    }
    const read = () => {
      const sel = editor.getSelection();
      const model = editor.getModel();
      setPicked(sel && model ? pickSelection(sel, model.getValueInRange(sel)) : null);
    };
    read();
    const sub = editor.onDidChangeCursorSelection(read);
    return () => sub.dispose();
  }, [editor]);

  // Stored, then one chip on the prompt of the agent last worked in: never a sentence.
  const send = (what: "file" | "selection", put: () => Promise<ContextRef>) => {
    onError(null);
    const name = what === "file" ? rel : "the selection";
    put().then(
      (item) =>
        chipToAgent(item).then(
          (said) => {
            if (!said.delivered) {
              const lead = what === "file" ? rel : "The selection";
              onError(`${lead} is in the Context strip, but no agent took it: ${said.reason}.`);
              return;
            }
            setSent(what);
            setTimeout(() => setSent((s) => (s === what ? null : s)), 1800);
          },
          (err: unknown) => onError(`Couldn't hand ${name} to the agent: ${String(err)}`),
        ),
      (err: unknown) =>
        onError(`Couldn't send ${name} to the agent: ${describe("context/put", err)}`),
    );
  };

  return (
    <>
      <SendButton
        label="Send file"
        sent={sent === "file"}
        disabled={missing}
        title="Add this file to the agent's context. Drag to a terminal to send it."
        onPointerDown={dirty || missing ? undefined : dragContext(() => putFile(path, rel))}
        onClick={() => {
          // The agent reads the file from disk, so unsaved edits would not reach it.
          if (dirty)
            onError(`Couldn't send ${rel} to the agent: it has unsaved changes. Save it first.`);
          else send("file", () => putFile(path, rel));
        }}
      />
      {picked && (
        <SendButton
          label="Send selection"
          sent={sent === "selection"}
          title="Add the selected lines, with their file and line range, to the agent's context. Drag to a terminal to send it."
          onPointerDown={dragContext(() =>
            putSelection(rel, picked.startLine, picked.endLine, picked.text),
          )}
          onClick={() =>
            send("selection", () =>
              putSelection(rel, picked.startLine, picked.endLine, picked.text),
            )
          }
        />
      )}
    </>
  );
}
