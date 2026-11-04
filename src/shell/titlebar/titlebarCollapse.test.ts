/**
 * A narrow window must not draw anything in the title bar over anything else,
 * and must not move the pill off the window's centre to avoid it (#336).
 *
 * jsdom does not run the stylesheet, so this reads it. The first fix for the
 * overlap (82403361) let the pill leave the centre below 1000px, dropped Upgrade
 * below 900px and clipped the right cell, which still drew the cell's buttons
 * under the pill and search out of reach. Braden's call on #336 replaced all
 * three: the buttons fold into one overflow button (`TitleBarActions`), the
 * pill and search stay centred as one group, and that group is held to what the
 * wider side leaves. The widths themselves are `useNarrowTitlebar.test.ts`'s;
 * search's half of the group is `../titlebarMiddleGroup.test.ts`'s.
 */
import { describe, expect, it } from "vitest";
import titlebarCss from "./titlebar.css?raw";
import pillCss from "./projectPill.css?raw";
import switcherCss from "./clusterSwitcher.css?raw";

const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(uncommented(css));
  if (!match) throw new Error(`no rule for ${selector}`);
  const decls = new Map<string, string>();
  for (const decl of match[1].split(";")) {
    const colon = decl.indexOf(":");
    if (colon >= 0) decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
  }
  return decls;
}

/** The text of every `@container` block in `css`, each with its braces' contents. */
function containerBlocks(css: string): string[] {
  const text = uncommented(css);
  const blocks: string[] = [];
  for (let at = text.indexOf("@container"); at >= 0; at = text.indexOf("@container", at + 1)) {
    let depth = 0;
    for (let i = text.indexOf("{", at); i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) {
        blocks.push(text.slice(at, i + 1));
        break;
      }
    }
  }
  return blocks;
}

/** A rule's flex-shrink, from `flex` or `flex-shrink`; 1 when it sets neither. */
function shrinkOf(decls: Map<string, string>): number {
  const shorthand = decls.get("flex")?.split(/\s+/);
  if (shorthand?.length === 3) return Number(shorthand[1]);
  if (decls.get("flex") === "none") return 0;
  return Number(decls.get("flex-shrink") ?? 1);
}

describe("titlebar.css collapse", () => {
  it("keeps the middle cell on the window's centre at every width", () => {
    expect(rule(titlebarCss, ".titlebar").get("grid-template-columns")).toBe(
      "minmax(0, 1fr) auto minmax(0, 1fr)",
    );
    // Nothing narrow re-lays the grid, which is how the pill used to leave the centre.
    for (const block of containerBlocks(titlebarCss)) {
      expect(block).not.toMatch(/grid-template-columns/);
    }
  });

  it("holds the middle group to the bar less twice the wider side", () => {
    expect(rule(titlebarCss, ".titlebar__middle").get("max-width")).toBe(
      "calc(100cqw - 2 * var(--titlebar-side, 0px))",
    );
    // The sides are as wide as their content, so measuring them measures that.
    for (const side of [".titlebar__start", ".titlebar__end"]) {
      expect(rule(titlebarCss, side).get("width")).toBe("max-content");
    }
  });

  it("never hides a button with CSS: the overflow menu holds them instead", () => {
    expect(uncommented(titlebarCss)).not.toMatch(
      /\.titlebar__(upgrade|icon)[^{]*\{[^}]*display:\s*none/,
    );
  });

  it("does not clip the right cell, so nothing in it is cut off or hangs under the pill", () => {
    expect(rule(titlebarCss, ".titlebar__end").has("overflow")).toBe(false);
    expect(rule(titlebarCss, ".titlebar__end").has("overflow-x")).toBe(false);
  });

  it("does not let the window controls shrink", () => {
    expect(shrinkOf(rule(titlebarCss, ".titlebar__controls"))).toBe(0);
  });
});

describe("the pill's share of the middle group", () => {
  it("is not capped at a fraction of the bar, only by the group", () => {
    const wrapper = rule(switcherCss, ".clusterswitch");
    expect(wrapper.has("max-width")).toBe(false);
    expect(wrapper.get("min-width")).toBe("0");
  });

  it("gives up its environment chip and count before the project's name", () => {
    const name = shrinkOf(rule(pillCss, ".projectpill__name"));
    expect(shrinkOf(rule(pillCss, ".projectpill__chip"))).toBeGreaterThan(name * 100);
    expect(shrinkOf(rule(pillCss, ".projectpill__count"))).toBeGreaterThan(name * 100);
    expect(rule(pillCss, ".projectpill__chip-label").get("text-overflow")).toBe("ellipsis");
  });
});
