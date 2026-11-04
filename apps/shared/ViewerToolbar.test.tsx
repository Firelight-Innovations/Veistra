// @vitest-environment jsdom
/**
 * The shared viewer toolbar: slot order, the status chip, its buttons, the
 * environment chip in slot 2 and the reason line under the bar.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@veistra/bridge", () => ({ invoke }));

import { EditorReason } from "./EditorReason";
import { ToolbarButton, ToolbarEnvChip, ToolbarReason, ViewerToolbar } from "./ViewerToolbar";

afterEach(cleanup);

describe("ViewerToolbar", () => {
  it("lays the slots out in the board's order: mode, subject, controls, state, actions, leave", () => {
    render(
      <ViewerToolbar
        label="Godot"
        mode={{
          value: "play",
          options: [
            { value: "scene", label: "Scene" },
            { value: "play", label: "Play" },
          ],
          onChange: () => undefined,
        }}
        subject={<span>hallway.tscn</span>}
        controls={<ToolbarButton label="Stop" icon={<i />} />}
        status={{ tone: "success", label: "Playing" }}
        actions={<ToolbarButton kbd="F8">Mark</ToolbarButton>}
        leave={<ToolbarButton label="Open in Godot" icon={<i />} />}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Godot" });
    const text = bar.textContent ?? "";
    const order = ["Scene", "hallway.tscn", "Playing", "Mark"].map((w) => text.indexOf(w));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? "");
    expect(names.indexOf("Stop")).toBeLessThan(names.indexOf("Open in Godot"));
  });

  it("says its state in one chip a screen reader announces", () => {
    render(<ViewerToolbar label="Blender" status={{ tone: "warning", label: "Changed" }} />);
    expect(screen.getByRole("status").textContent).toBe("Changed");
  });

  it("draws no chip when there is no state to report", () => {
    render(<ViewerToolbar label="Blender" status={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("switches mode through the segmented control", () => {
    const onChange = vi.fn();
    render(
      <ViewerToolbar
        label="Godot"
        mode={{
          value: "scene",
          options: [
            { value: "scene", label: "Scene" },
            { value: "play", label: "Play" },
          ],
          onChange,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Play" }));
    expect(onChange).toHaveBeenCalledWith("play");
  });
});

describe("ToolbarButton", () => {
  it("names an icon-only button from its label and shows it as the tooltip", () => {
    render(<ToolbarButton label="Pop out" icon={<i />} />);
    const button = screen.getByRole("button", { name: "Pop out" });
    expect(button.getAttribute("title")).toBe("Pop out");
  });

  it("reports a toggle as pressed", () => {
    render(
      <ToolbarButton pressed onClick={() => undefined}>
        Rec
      </ToolbarButton>,
    );
    expect(screen.getByRole("button", { name: "Rec" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says it opens a dialog, and whether that is open", () => {
    const { rerender } = render(<ToolbarButton label="Record settings" icon={<i />} />);
    const button = screen.getByRole("button", { name: "Record settings" });
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    rerender(<ToolbarButton label="Record settings" icon={<i />} expanded={false} />);
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    rerender(<ToolbarButton label="Record settings" icon={<i />} expanded />);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the key after the label", () => {
    render(<ToolbarButton kbd="F8">Mark</ToolbarButton>);
    expect(screen.getByRole("button").textContent).toBe("MarkF8");
  });
});

describe("ToolbarEnvChip", () => {
  it("is the first thing in the subject slot, before the picker and the state chip", () => {
    render(
      <ViewerToolbar
        label="Godot"
        subject={
          <>
            <ToolbarEnvChip kind="localWorktree" branch="wt/hallway" />
            <span>hallway.tscn</span>
          </>
        }
        status={{ tone: "success", label: "Up to date" }}
      />,
    );
    const text = screen.getByRole("toolbar", { name: "Godot" }).textContent ?? "";
    expect(text.startsWith("wtwt/hallway")).toBe(true);
    expect(text.indexOf("hallway.tscn")).toBeLessThan(text.indexOf("Up to date"));
    // A badge, not a second state: the bar still has one status chip.
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("names main without a branch, and draws nothing for a plain folder", () => {
    const { container, rerender } = render(<ToolbarEnvChip kind="main" branch={null} />);
    expect(container.textContent).toBe("main");
    rerender(<ToolbarEnvChip kind={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("ToolbarReason", () => {
  it("is a note with at most one link", () => {
    const onClick = vi.fn();
    render(
      <ToolbarReason action={{ label: "Open Settings", onClick }}>
        Godot 4 was not found.
      </ToolbarReason>,
    );
    const note = screen.getByRole("note");
    expect(note.textContent).toBe("Godot 4 was not found.Open Settings");
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("EditorReason", () => {
  it("draws nothing when the editor is in the pane", () => {
    const { container } = render(
      <EditorReason surface={{ surface: "embedded", reason: null, code: null }} tool="godot" />,
    );
    expect(container.textContent).toBe("");
  });

  it("states main as a fact, with nothing to press", () => {
    render(
      <EditorReason
        surface={{ surface: "viewer", reason: "This is the main checkout.", code: "main" }}
        tool="godot"
      />,
    );
    expect(screen.getByRole("note").textContent).toBe("This is the main checkout.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Settings on the tool's section when the editor is missing, after what the view does instead", async () => {
    invoke.mockResolvedValue({ section: "godot" });
    render(
      <EditorReason
        surface={{ surface: "viewer", reason: "Godot 4 was not found.", code: "noEditor" }}
        tool="godot"
        detail="The tree is read from the scene file."
      />,
    );
    expect(screen.getByRole("note").textContent).toBe(
      "Godot 4 was not found. The tree is read from the scene file.Open Settings",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("shell/open-settings", { section: "godot" }),
    );
  });

  it("says so when Settings would not open", async () => {
    invoke.mockRejectedValue(new Error("no shell"));
    const onError = vi.fn();
    render(
      <EditorReason
        surface={{ surface: "viewer", reason: "Blender was not found.", code: "noEditor" }}
        tool="blender"
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("no shell"));
  });
});
