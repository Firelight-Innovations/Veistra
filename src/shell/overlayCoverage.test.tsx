// @vitest-environment jsdom
/**
 * The shell's real role-less covers, rendered, against `OVERLAY_SELECTOR`.
 *
 * `overlayWatch.test.ts` checks the selector against hand-written markup; this
 * checks that the components still draw what it names. Each element is found
 * by what it holds rather than by its class, so renaming a class here without
 * the selector fails instead of letting Play's game paint over the popover.
 * It sits beside `overlayWatch.ts` because it reads several regions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { motionValue } from "framer-motion";
import { OVERLAY_SELECTOR } from "./overlayWatch";
import HealthPopover, { type UnhealthyTool } from "./titlebar/HealthPopover";
import HamburgerMenu from "./titlebar/HamburgerMenu";
import MenuItemList from "./MenuItemList";
import PageSurface from "./frame/PageSurface";
import CommandPalette from "./palette/CommandPalette";
import Dialog from "./dialogs/Dialog";
import toolwindowCss from "./toolwindow/toolwindow.css?raw";

afterEach(cleanup);

const covered = (el: Element) => el.closest(OVERLAY_SELECTOR) !== null;

describe("the shell's covers count as overlays", () => {
  it("the tool health popover", () => {
    const tool: UnhealthyTool = {
      id: "t",
      name: "Lint",
      description: "",
      health: "needs-update",
      interactive: true,
      isApp: false,
      placesWindow: false,
    };
    render(<HealthPopover tools={[tool]} onRescan={() => {}} />);
    expect(covered(screen.getByRole("button", { name: "Re-scan tools" }))).toBe(true);
  });

  it("the hamburger dropdown before any group is expanded", () => {
    render(<HamburgerMenu menus={[{ label: "File", items: [{ label: "New" }] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(covered(screen.getByRole("button", { name: "File" }))).toBe(true);
  });

  it("a prompt field portalled beside its menu row", () => {
    const prompt = { label: "New name", confirmLabel: "Rename", onSubmit: async () => {} };
    render(<MenuItemList items={[{ label: "Rename", prompt }]} onAfterSelect={() => {}} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(covered(screen.getByLabelText("New name"))).toBe(true);
  });

  it("an expanded rail page, and not a docked one", () => {
    const page = (mode: "docked" | "expanded") => (
      <PageSurface mode={mode} reduced width={motionValue(380)} onSettled={() => {}}>
        <p>page</p>
      </PageSurface>
    );
    const { rerender } = render(page("docked"));
    expect(covered(screen.getByText("page"))).toBe(false);
    rerender(page("expanded"));
    expect(covered(screen.getByText("page"))).toBe(true);
  });

  // The sheet is a dialog either way; the scrim behind it dims the whole
  // window, a game in a pane the sheet does not reach included.
  it("the Ctrl K palette's scrim, not only its sheet", () => {
    render(<CommandPalette open commands={[]} apps={[]} onPickApp={vi.fn()} onClose={vi.fn()} />);
    const sheet = screen.getByRole("combobox").closest('[role="dialog"]');
    const scrim = screen.getByTestId("palette-backdrop");
    expect(sheet).not.toBeNull();
    expect(scrim.contains(sheet)).toBe(true);
    expect(scrim.matches(OVERLAY_SELECTOR)).toBe(true);
  });

  it("a dialog's scrim, not only its panel", () => {
    render(
      <Dialog label="Rename" onCancel={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    const scrim = screen.getByRole("dialog").parentElement!;
    expect(scrim.matches(OVERLAY_SELECTOR)).toBe(true);
  });

  it("a takeover, by the rule that lifts it over the panes", () => {
    // `ToolWindow` is too wide to render here; its stylesheet names the
    // takeover the way the selector does, and the two are renamed together.
    expect(toolwindowCss).toContain(".toolwindow__surface[data-solo] {");
    const surface = document.createElement("div");
    surface.className = "toolwindow__surface";
    surface.setAttribute("data-solo", "true");
    expect(covered(surface)).toBe(true);
  });
});
