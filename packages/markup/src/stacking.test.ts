/**
 * The toolbar, pin note and chip must stack above Excalidraw's interactive
 * canvas. Excalidraw's root is not a stacking context, so its canvas's z-index
 * competes with our overlays directly; with no z-index of their own the
 * transparent canvas covered the toolbar and every tool click drew a selection
 * box instead. jsdom does no hit-testing, so this reads the two stylesheets.
 */
import { describe, expect, it } from "vitest";
import ours from "./MarkupLayer.css?raw";
import theirs from "@excalidraw/excalidraw/index.css?raw";

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.search(new RegExp(`(^|[}\\s])${selector.replace(/[.$]/g, "\\$&")}\\s*\\{`));
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

function prop(decls: string, name: string): string | null {
  const m = new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`).exec(decls);
  return m ? m[1].trim() : null;
}

/** A z-index value, following one `var(--x)` through `:root` or the layer's own rule. */
function zIndex(value: string | null, ...scopes: string[]): number {
  expect(value).not.toBeNull();
  const v = /^var\((--[\w-]+)\)$/.exec(value ?? "");
  if (!v) return Number(value);
  for (const decls of scopes) {
    const found = prop(decls, v[1]);
    if (found !== null) return Number(found);
  }
  throw new Error(`unresolved ${value}`);
}

describe("markup layer stacking", () => {
  const root = rule(ours, ".veistra-markup");
  const canvas = zIndex(
    prop(rule(theirs, ".excalidraw canvas.interactive"), "z-index"),
    rule(theirs, ":root"),
  );

  it("is its own stacking context, so Excalidraw's z-indexes stay inside it", () => {
    expect(prop(root, "isolation")).toBe("isolate");
  });

  it.each([".veistra-markup__toolbar", ".veistra-markup__note", ".veistra-markup__chip"])(
    "puts %s above the interactive canvas",
    (selector) => {
      expect(zIndex(prop(rule(ours, selector), "z-index"), root)).toBeGreaterThan(canvas);
    },
  );
});
