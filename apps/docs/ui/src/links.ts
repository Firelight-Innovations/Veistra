/**
 * Where a link inside a docs page goes.
 *
 * A link to another docs page stays in this pane; everything else on the web
 * goes to the system browser, because this frame only ever draws pages from the
 * site's docs. The rules mirror `is_page_path` and `path_of` in
 * `src-tauri/src/apps/docs.rs`, which re-checks every path it is handed.
 */

export type LinkTarget =
  | { kind: "index" }
  | { kind: "page"; path: string; hash: string }
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string };

const PAGE_PATH = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

/** Lowercase segments of letters, digits, `-` and `_`, as Rust accepts. */
export function isPagePath(path: string): boolean {
  return path.length > 0 && path.length <= 200 && PAGE_PATH.test(path);
}

/** `www.veistra.com` and `veistra.com` are one site. */
function sameSite(a: URL, b: URL): boolean {
  const host = (url: URL) => url.host.replace(/^www\./, "");
  return a.protocol === b.protocol && host(a) === host(b);
}

/**
 * Classify `href` as it appears in a page whose address is `pageUrl`, for docs
 * rooted at `home` (`https://veistra.com/docs`). `null` for a link nothing
 * should follow, such as `javascript:`.
 */
export function classifyLink(href: string, pageUrl: string, home: string): LinkTarget | null {
  const raw = href.trim();
  if (raw.startsWith("#")) return { kind: "anchor", id: decodeURIComponent(raw.slice(1)) };

  let target: URL;
  let root: URL;
  try {
    target = new URL(raw, pageUrl);
    root = new URL(home);
  } catch {
    return null;
  }
  if (!["http:", "https:", "mailto:"].includes(target.protocol)) return null;

  const base = root.pathname.replace(/\/+$/, "");
  if (sameSite(target, root)) {
    if (target.pathname === base || target.pathname === `${base}/`) return { kind: "index" };
    if (target.pathname.startsWith(`${base}/`)) {
      const path = target.pathname
        .slice(base.length + 1)
        .replace(/\.md$/, "")
        .replace(/\/+$/, "");
      if (isPagePath(path)) return { kind: "page", path, hash: target.hash.replace(/^#/, "") };
    }
  }
  return { kind: "external", url: target.href };
}

/** `src` or `href` made absolute against the page, or left alone if it cannot be. */
export function absolute(ref: string, pageUrl: string): string {
  try {
    return new URL(ref, pageUrl).href;
  } catch {
    return ref;
  }
}
