/**
 * Which links inside a docs page stay in the pane, and which go to the browser.
 */
import { describe, expect, it } from "vitest";
import { absolute, classifyLink, isPagePath } from "./links";

const HOME = "https://veistra.com/docs";
const PAGE = "https://veistra.com/docs/get-started/install.md";

describe("isPagePath", () => {
  it("accepts the paths the site uses", () => {
    expect(isPagePath("get-started/install")).toBe(true);
    expect(isPagePath("account/api_keys")).toBe(true);
  });

  it("refuses anything that could climb out of /docs or is not a path", () => {
    for (const bad of ["", "../secrets", "a//b", "/abs", "a/", "Get-Started", "a b", "a.md"]) {
      expect(isPagePath(bad), bad).toBe(false);
    }
    expect(isPagePath("a".repeat(201))).toBe(false);
  });
});

describe("classifyLink", () => {
  it("keeps another docs page in the pane, by absolute or relative link", () => {
    expect(classifyLink("https://veistra.com/docs/account/usage", PAGE, HOME)).toEqual({
      kind: "page",
      path: "account/usage",
      hash: "",
    });
    expect(classifyLink("/docs/context/blender.md#setup", PAGE, HOME)).toEqual({
      kind: "page",
      path: "context/blender",
      hash: "setup",
    });
    expect(classifyLink("sign-in", PAGE, HOME)).toEqual({
      kind: "page",
      path: "get-started/sign-in",
      hash: "",
    });
  });

  it("treats www and the bare host as one site", () => {
    expect(classifyLink("https://www.veistra.com/docs/account/devices", PAGE, HOME)).toEqual({
      kind: "page",
      path: "account/devices",
      hash: "",
    });
  });

  it("sends the docs root to the overview", () => {
    expect(classifyLink("/docs", PAGE, HOME)).toEqual({ kind: "index" });
    expect(classifyLink("https://veistra.com/docs/", PAGE, HOME)).toEqual({ kind: "index" });
  });

  it("scrolls for a link within the page", () => {
    expect(classifyLink("#first-run", PAGE, HOME)).toEqual({ kind: "anchor", id: "first-run" });
  });

  it("sends the rest of the site, other sites and mail to the browser", () => {
    expect(classifyLink("/pricing", PAGE, HOME)).toEqual({
      kind: "external",
      url: "https://veistra.com/pricing",
    });
    expect(classifyLink("https://github.com/x", PAGE, HOME)).toEqual({
      kind: "external",
      url: "https://github.com/x",
    });
    expect(classifyLink("mailto:help@veistra.com", PAGE, HOME)?.kind).toBe("external");
  });

  it("follows nothing that is not the web", () => {
    expect(classifyLink("javascript:alert(1)", PAGE, HOME)).toBeNull();
    expect(classifyLink("file:///C:/x", PAGE, HOME)).toBeNull();
  });

  it("follows a docs-shaped path on another site out, not in", () => {
    expect(classifyLink("https://example.com/docs/account/usage", PAGE, HOME)?.kind).toBe(
      "external",
    );
  });
});

describe("absolute", () => {
  it("resolves against the page and leaves an unparseable reference alone", () => {
    expect(absolute("img/a.png", PAGE)).toBe("https://veistra.com/docs/get-started/img/a.png");
    expect(absolute("x", "not a url")).toBe("x");
  });
});
