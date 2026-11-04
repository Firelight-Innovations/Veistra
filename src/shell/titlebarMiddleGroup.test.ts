/**
 * The title bar's middle group gives way in the order #336 sets: search
 * narrows to its icon and Ctrl+K, then to its icon, before the pill loses a
 * character.
 *
 * Read from the stylesheets, since jsdom lays nothing out. It lives beside
 * `WindowRoot.tsx` rather than in a region because the group is two regions'
 * (the pill is `titlebar`'s, the field is `search`'s), and only the wiring
 * layer may read both. The bar's own half is `titlebar/titlebarCollapse.test.ts`.
 */
import { describe, expect, it } from "vitest";
import searchCss from "./search/search.css?raw";
import switcherCss from "./titlebar/clusterSwitcher.css?raw";

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

/** The width below which `@container search-slot` hides something matching `hidden`. */
function hiddenBelow(hidden: RegExp): number[] {
  const text = uncommented(searchCss);
  const found: number[] = [];
  const query = /@container search-slot \(width < (\d+)px\)\s*\{([\s\S]*?\})\s*\}/g;
  for (let m = query.exec(text); m; m = query.exec(text)) {
    if (new RegExp(`${hidden.source}[^{]*\\{\\s*display:\\s*none`).test(m[2])) {
      found.push(Number(m[1]));
    }
  }
  return found;
}

describe("the title bar's middle group", () => {
  it("narrows search before the pill", () => {
    const search = rule(searchCss, ".search-slot").get("flex")?.split(/\s+/);
    const pill = rule(switcherCss, ".clusterswitch").get("flex")?.split(/\s+/);
    expect(Number(search?.[1])).toBeGreaterThan(Number(pill?.[1]) * 100);
  });

  it("asks the group for search's full width, not for its padding alone", () => {
    // The field is its own size container, so its content says nothing about
    // its width: a flex basis alone left it an icon at every window size.
    const search = rule(searchCss, ".search-slot");
    expect(search.get("width")).toBe("240px");
    expect(search.get("flex")?.split(/\s+/)[2]).toBe("auto");
    expect(search.get("container")).toBe("search-slot / inline-size");
  });

  it("drops the label first, then the Ctrl+K chip, by the field's own width", () => {
    const label = hiddenBelow(/\.search-slot__label/);
    const chip = hiddenBelow(/\.search-slot:not\(\.search-slot--claimed\) \.search-slot__hint/);
    expect(label).toHaveLength(1);
    expect(chip).toHaveLength(1);
    expect(chip[0]).toBeLessThan(label[0]);
  });

  it("never narrows a claimed field to an icon, which could not be typed into", () => {
    expect(rule(searchCss, ".search-slot--claimed").get("min-width")).toBe("80px");
  });
});
