// @vitest-environment jsdom
/** The empty cluster: the title and the one button, with no sentence between them. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import EmptyState from "./EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("says only that nothing is open, then offers Open an app", () => {
    const onOpenApp = vi.fn();
    const { container } = render(<EmptyState onOpenApp={onOpenApp} />);
    expect(screen.getByText("Nothing open here")).toBeTruthy();
    expect(container.querySelector(".toolwindow__empty-body")).toBeNull();
    expect(container.textContent).toBe("Nothing open hereOpen an app");
    fireEvent.click(screen.getByRole("button", { name: "Open an app" }));
    expect(onOpenApp).toHaveBeenCalledTimes(1);
  });
});
