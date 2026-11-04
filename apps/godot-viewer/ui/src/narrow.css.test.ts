import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the app tsconfig carries no Node types.
import godot from "./SceneMode.css?raw";
import toolbar from "../../../shared/viewer-toolbar.css?raw";

/**
 * Structure checks for the narrow-pane layout. jsdom does no layout, so these
 * pin the declarations that keep the header and footer from overlapping. The
 * header is the shared viewer toolbar, so its wrapping lives in that sheet.
 */
function rule(css: string, selector: string): string {
  // The last rule for the selector: a shared group rule may come first.
  const at = css.lastIndexOf(`\n${selector} {`);
  expect(at, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("narrow panes", () => {
  it("Godot Viewer toolbar wraps, caps the scene picker and keeps its labels on one line", () => {
    expect(rule(toolbar, ".k-vtb")).toContain("flex-wrap: wrap");
    expect(rule(toolbar, ".k-vtb__actions")).toContain("flex-wrap: wrap");
    expect(rule(toolbar, ".k-vtb__select")).toContain("max-width");
    expect(rule(toolbar, ".k-vtb__btn")).toContain("white-space: nowrap");
    expect(rule(godot, ".gv__preview-toggle")).toContain("white-space: nowrap");
    expect(rule(godot, ".gv__footer-btn")).toContain("white-space: nowrap");
  });
});
