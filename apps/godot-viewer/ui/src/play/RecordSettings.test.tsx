// @vitest-environment jsdom
/**
 * Record settings (#321): the chevron opens them, each control asks for one
 * change, and Escape or a press elsewhere closes them. What a change does to
 * the next take is Rust's (`live.rs` tests); Play mode's wiring is in
 * `PlayMode.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { RecordSettings, type RecordSettingsProps } from "./RecordSettings";
import type { RecordSettings as Settings } from "./rpc";

afterEach(cleanup);

const ON: Settings = {
  on: true,
  blocked: null,
  quality: "720p30",
  keep: 10,
  dir: "C:/env/.veistra/takes",
  inEnvironment: true,
};

function Harness(props: Partial<RecordSettingsProps> & { record?: Settings }) {
  const [open, setOpen] = useState(props.open ?? false);
  return (
    <div>
      <button type="button">Elsewhere</button>
      <RecordSettings
        open={open}
        onOpen={setOpen}
        record={props.record ?? ON}
        onRecord={props.onRecord ?? vi.fn()}
        onChange={props.onChange ?? vi.fn()}
        onReveal={props.onReveal ?? vi.fn()}
      />
    </div>
  );
}

const chevron = () => screen.getByRole("button", { name: "Settings for Record" });

describe("Record settings", () => {
  it("opens from its chevron as a dialog, says it is open, and closes on Escape", () => {
    render(<Harness />);
    expect(chevron().getAttribute("aria-haspopup")).toBe("dialog");
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chevron());
    expect(screen.getByRole("dialog", { name: "Record settings" })).toBeTruthy();
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    // The first control has the keys, so Space toggles Record every run.
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: /Record every run/ }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chevron());
  });

  it("closes on a press outside it, and not on one inside", () => {
    render(<Harness open />);
    fireEvent.pointerDown(screen.getByRole("tab", { name: "1080p · 60" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for the quality and the keep each on its own, and says when they apply", () => {
    const onChange = vi.fn();
    render(<Harness open onChange={onChange} />);
    expect(screen.getByRole("tab", { name: "720p · 30 fps" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText(/About 53 MB for two minutes\. From the next take\./)).toBeTruthy();
    // The quality already set asks for nothing.
    fireEvent.click(screen.getByRole("tab", { name: "720p · 30 fps" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "1080p · 60" }));
    expect(onChange).toHaveBeenLastCalledWith({ quality: "1080p60" });
    fireEvent.change(screen.getByRole("combobox", { name: "Takes to keep" }), {
      target: { value: "20" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ keep: 20 });
    expect(screen.getByText("takes, notes kept forever")).toBeTruthy();
  });

  it("lists a keep set elsewhere among the ones it offers", () => {
    render(<Harness open record={{ ...ON, keep: 3 }} />);
    const keep = screen.getByRole("combobox", { name: "Takes to keep" }) as HTMLSelectElement;
    expect(keep.value).toBe("3");
    expect([...keep.options].map((o) => o.value)).toEqual(["3", "5", "10", "20", "50"]);
  });

  it("shows the folder rather than choosing it, and opens it", () => {
    const onReveal = vi.fn();
    render(<Harness open onReveal={onReveal} />);
    const dir = screen.getByText(".veistra/takes/ · git-ignored");
    expect(dir.getAttribute("title")).toBe("C:/env/.veistra/takes");
    fireEvent.click(screen.getByRole("button", { name: "Show folder" }));
    expect(onReveal).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Harness open record={{ ...ON, inEnvironment: false, dir: "C:/data/takes/main" }} />);
    expect(screen.getByText("Outside this read-only checkout").getAttribute("title")).toBe(
      "C:/data/takes/main",
    );
  });

  it("cannot turn Record on while it is blocked, and says why; on, it turns off", () => {
    const onRecord = vi.fn();
    const blocked = "Capture is not in this project. Enable capture first.";
    render(<Harness open onRecord={onRecord} record={{ ...ON, on: false, blocked }} />);
    const box = screen.getByRole("checkbox", { name: /Record every run/ }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(blocked)).toBeTruthy();
    cleanup();
    render(<Harness open onRecord={onRecord} record={{ ...ON, blocked }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Record every run/ }));
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it("shows Talk while you play as later, with nothing to press", () => {
    render(<Harness open />);
    expect(screen.getByText("Talk while you play")).toBeTruthy();
    expect(screen.getByText("Later")).toBeTruthy();
  });
});
