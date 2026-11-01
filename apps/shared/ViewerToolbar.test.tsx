// @vitest-environment jsdom
/** The shared viewer toolbar: slot order, the status chip, and its buttons. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolbarButton, ViewerToolbar } from "./ViewerToolbar";

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

  it("shows the key after the label", () => {
    render(<ToolbarButton kbd="F8">Mark</ToolbarButton>);
    expect(screen.getByRole("button").textContent).toBe("MarkF8");
  });
});
