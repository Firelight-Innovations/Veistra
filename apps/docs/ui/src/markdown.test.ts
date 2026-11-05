// @vitest-environment jsdom
/**
 * The Markdown the site serves, rendered: links and images resolved against
 * the page, headings given ids, and nothing in the text left live.
 */
import { describe, expect, it } from "vitest";
import { ANCHOR_PREFIX, renderDoc, slugify } from "./markdown";

const PAGE = "https://veistra.com/docs/get-started/install.md";

function dom(source: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderDoc(source, PAGE);
  return host;
}

describe("renderDoc", () => {
  it("makes links and images absolute against the page's address", () => {
    const host = dom("[next](sign-in) [root](/docs) ![shot](img/a.png) [here](#top)");
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://veistra.com/docs/get-started/sign-in",
      "https://veistra.com/docs",
      "#top",
    ]);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "https://veistra.com/docs/get-started/img/a.png",
    );
  });

  it("gives every heading a prefixed id, and repeats a distinct one", () => {
    const host = dom("# Install Veistra\n\n## Steps\n\n## Steps");
    const ids = [...host.querySelectorAll("h1, h2")].map((h) => h.id);
    expect(ids).toEqual([
      `${ANCHOR_PREFIX}install-veistra`,
      `${ANCHOR_PREFIX}steps`,
      `${ANCHOR_PREFIX}steps-1`,
    ]);
  });

  it("leaves no script, handler or javascript: link live", () => {
    const host = dom(
      '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a><iframe src="https://e.com"></iframe>',
    );
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/^javascript:/);
  });

  it("draws tables and fenced code", () => {
    const host = dom("| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\npnpm i\n```");
    expect(host.querySelectorAll("td")).toHaveLength(2);
    expect(host.querySelector("pre code")?.textContent).toBe("pnpm i\n");
  });
});

describe("slugify", () => {
  it("matches the GitHub-style slug a site heading link would use", () => {
    expect(slugify("  API keys & tokens ")).toBe("api-keys--tokens");
    expect(slugify("Sign-in")).toBe("sign-in");
  });
});
