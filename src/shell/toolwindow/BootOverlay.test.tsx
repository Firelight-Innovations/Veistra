// @vitest-environment jsdom
/**
 * The boot overlay draws one loading indicator, the spinning arc, and that arc
 * is what assistive tech is told is loading. It used to draw a progress bar
 * under the title as well, which read as two separate things loading.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import BootOverlay from "./BootOverlay";
import toolwindowCss from "./toolwindow.css?raw";

afterEach(cleanup);

describe("BootOverlay", () => {
  it("draws the spinner and no bar", () => {
    const { container } = render(<BootOverlay toolName="Files" />);

    expect(container.querySelector(".boot__arc svg")).not.toBeNull();
    expect(container.querySelector(".boot__track")).toBeNull();
    expect(container.querySelector(".boot__fill")).toBeNull();
    expect(screen.getByText("Starting Files")).toBeTruthy();
  });

  it("names the spinner as the single progress indicator", () => {
    render(<BootOverlay toolName="Files" />);

    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    expect(bars[0].classList.contains("boot__arc")).toBe(true);
    expect(bars[0].getAttribute("aria-label")).toBe("Starting Files");
    expect(bars[0].hasAttribute("aria-valuetext")).toBe(false);
  });

  it("reports a known step as text, still without a bar", () => {
    const { container } = render(<BootOverlay toolName="Files" progress={{ step: 2, total: 3 }} />);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("step 2 of 3");
    expect(screen.getByText("step 2 of 3")).toBeTruthy();
    expect(container.querySelector(".boot__track")).toBeNull();
  });

  it("keeps no styles for the removed bar", () => {
    expect(toolwindowCss).not.toMatch(/\.boot__(track|fill)\b/);
  });
});
