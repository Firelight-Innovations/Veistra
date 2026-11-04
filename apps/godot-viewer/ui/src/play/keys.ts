/**
 * Play's keys, as the Components board lists them. Two sets: while the pane
 * has focus during a run, and while reviewing a take. When the game itself
 * has focus, addon v2 handles F7, F8 and Ctrl Shift M and reports them; these
 * are the same keys for when the focus is in the pane instead.
 *
 * A key typed into a note's text box is the person writing, never a command,
 * except Ctrl Enter, which sends.
 */

export type LiveAction =
  | "run-or-restart"
  | "stop"
  | "pause"
  | "review"
  | "mark"
  | "markup"
  | "record"
  | "open-editor"
  | null;

export type ReviewAction = "play" | "back" | "forward" | "in" | "out" | "note" | "send" | null;

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
  /** The event's target is a text field. */
  typing: boolean;
}

export function liveAction(e: KeyLike): LiveAction {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "F5") return e.shiftKey ? "stop" : "run-or-restart";
  if (k === "F6") return "pause";
  if (k === "F7") return "review";
  if (k === "F8") return "mark";
  if (e.typing) return null;
  if (e.ctrlKey && e.shiftKey && k === "m") return "markup";
  if (e.ctrlKey && e.shiftKey && k === "o") return "open-editor";
  if (e.ctrlKey && !e.shiftKey && k === "r") return "record";
  return null;
}

export function reviewAction(e: KeyLike): ReviewAction {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") return "send";
  if (e.typing || e.ctrlKey || e.metaKey) return null;
  switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
    case " ":
      return "play";
    case "ArrowLeft":
      return "back";
    case "ArrowRight":
      return "forward";
    case "i":
      return "in";
    case "o":
      return "out";
    case "n":
      return "note";
    default:
      return null;
  }
}

/** Whether a key event's target is somewhere text is typed. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox")
  );
}
