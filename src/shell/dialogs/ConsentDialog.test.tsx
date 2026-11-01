// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConsentDialog from "./ConsentDialog";

afterEach(cleanup);

function draw() {
  const props = { onShare: vi.fn(), onDecline: vi.fn(), onLater: vi.fn() };
  render(<ConsentDialog {...props} />);
  return props;
}

describe("ConsentDialog", () => {
  it("shares with recordings unless the box is cleared", () => {
    const first = draw();
    fireEvent.click(screen.getByRole("button", { name: "Share usage data" }));
    expect(first.onShare).toHaveBeenCalledWith(true);
    cleanup();

    const second = draw();
    fireEvent.click(screen.getByRole("checkbox", { name: /Include session recordings/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share usage data" }));
    expect(second.onShare).toHaveBeenCalledWith(false);
  });

  it("declines with its own button, and Escape stores nothing", () => {
    const props = draw();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onLater).toHaveBeenCalledTimes(1);
    expect(props.onDecline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Don't share" }));
    expect(props.onDecline).toHaveBeenCalledTimes(1);
    expect(props.onShare).not.toHaveBeenCalled();
  });

  it("leaves its own words readable in a recording", () => {
    draw();
    expect(screen.getByRole("dialog").querySelector("[data-telemetry-unmask]")).not.toBeNull();
  });
});
