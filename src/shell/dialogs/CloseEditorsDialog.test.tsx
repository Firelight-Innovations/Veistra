// @vitest-environment jsdom
/**
 * The question a cluster with Blender or the Godot editor in it asks before
 * it closes: which editors, and Cancel, Close or Save & close.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OpenEditor } from "../../bindings";
import CloseEditorsDialog, { editorLabel } from "./CloseEditorsDialog";

afterEach(cleanup);

const blender: OpenEditor = {
  instance: "blender-1",
  kind: "blender",
  name: "props/house.blend",
  dirty: true,
};
const godot: OpenEditor = { instance: "godot-1", kind: "godot", name: "my-game", dirty: null };

function setup(editors: OpenEditor[]) {
  const on = { onCancel: vi.fn(), onClose: vi.fn(), onSaveAndClose: vi.fn() };
  render(<CloseEditorsDialog cluster="Level art" editors={editors} {...on} />);
  return on;
}

describe("CloseEditorsDialog", () => {
  it("names each editor, and which have unsaved changes", () => {
    setup([blender, godot]);
    expect(screen.getByRole("dialog", { name: "Close Level art" })).toBeTruthy();
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual(["Blender (props/house.blend) — unsaved changes", "Godot (my-game)"]);
    expect(screen.getByText(/has editors open/)).toBeTruthy();
  });

  it("calls an untitled Blender scene untitled", () => {
    expect(editorLabel({ ...blender, name: null })).toBe("Blender (untitled)");
  });

  it("focuses Cancel, the choice that changes nothing", () => {
    setup([blender]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/has an editor open\. Save its work/)).toBeTruthy();
  });

  it("answers each button with its own choice", () => {
    const on = setup([blender]);
    fireEvent.click(screen.getByRole("button", { name: "Save & close" }));
    expect(on.onSaveAndClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(on.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(on.onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the cluster open on Escape", () => {
    const on = setup([godot]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(on.onCancel).toHaveBeenCalledTimes(1);
    expect(on.onClose).not.toHaveBeenCalled();
    expect(on.onSaveAndClose).not.toHaveBeenCalled();
  });
});
