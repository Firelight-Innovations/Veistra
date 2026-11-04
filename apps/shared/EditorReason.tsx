/**
 * The backend's reason for an Editor surface (`editorSurface.ts`), as the line
 * under the toolbar. A missing editor gets the one way out, Open Settings on
 * the tool's section; main, a cloud session and a pop out are facts with
 * nothing to press. Nothing when the editor is in the pane.
 */
import type { ReactNode } from "react";
import { openEditorSettings, type EditorSurface, type EditorTool } from "./editorSurface";
import { ToolbarReason } from "./ViewerToolbar";

export function EditorReason({
  surface,
  tool,
  detail,
  onError,
}: {
  surface: EditorSurface | null | undefined;
  tool: EditorTool;
  /** What this view does instead, after the reason: "The tree is read from the scene file." */
  detail?: ReactNode;
  /** Opening Settings failed. */
  onError?: (message: string) => void;
}) {
  if (!surface?.reason) return null;
  const missing = surface.code === "noEditor";
  const openSettings = () => {
    openEditorSettings(tool).catch((e: unknown) =>
      onError?.(e instanceof Error ? e.message : String(e)),
    );
  };
  return (
    <ToolbarReason
      tone={missing ? "warning" : "info"}
      action={missing ? { label: "Open Settings", onClick: openSettings } : undefined}
    >
      {surface.reason}
      {detail != null && <> {detail}</>}
    </ToolbarReason>
  );
}
