/**
 * A docs page's Markdown to sanitised HTML.
 *
 * markdown-it parses and DOMPurify does the trusting, in that order, which is
 * the same boundary the File Viewer's preview draws (`apps/viewer/ui/src/
 * preview/markdown.ts`). The text comes from the website rather than from this
 * build, so nothing in it is trusted to be inert: a `<script>`, an `onerror=`
 * or a `javascript:` link never becomes live.
 *
 * Two things are added to markdown-it's defaults. Every link and image is made
 * absolute against the page's own address, so `/docs/x` and `img/a.png` mean
 * what they mean on the site rather than on this frame's origin. And every
 * heading gets an id under {@link ANCHOR_PREFIX}, which is what an in-page
 * `#section` link scrolls to.
 */
import MarkdownIt from "markdown-it";
import type { MarkdownIt as Parser, Token } from "markdown-it";
import DOMPurify from "dompurify";
import { absolute } from "./links";

/** Prefixed so a heading called "root" cannot clobber an id the app uses. */
export const ANCHOR_PREFIX = "doc-";

/** What `renderDoc` hands markdown-it, which passes it to every rule. */
type Env = Record<string, unknown> & { base?: string };

/** The page's address, as `renderDoc` put it in `env`. */
function baseOf(env: unknown): string {
  const base = (env as Env | undefined)?.base;
  return typeof base === "string" ? base : "";
}

/** GitHub's slug: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function textOf(inline: Token): string {
  return (inline.children ?? [])
    .filter((child) => child.type === "text" || child.type === "code_inline")
    .map((child) => child.content)
    .join("");
}

function build(): Parser {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

  md.core.ruler.push("docs_headings", (state) => {
    const seen = new Map<string, number>();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const inline = tokens[i + 1];
      if (tokens[i].type !== "heading_open" || inline?.type !== "inline") continue;
      const base = slugify(textOf(inline)) || "section";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      tokens[i].attrSet("id", ANCHOR_PREFIX + (count === 0 ? base : `${base}-${count}`));
    }
  });

  const link = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = String(tokens[idx].attrGet("href") ?? "");
    if (href && !href.startsWith("#")) tokens[idx].attrSet("href", absolute(href, baseOf(env)));
    return link ? link(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };

  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = String(tokens[idx].attrGet("src") ?? "");
    if (src) tokens[idx].attrSet("src", absolute(src, baseOf(env)));
    return image ? image(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };

  return md;
}

let parser: Parser | null = null;

/** Render `source`, a page whose address on the site is `pageUrl`. */
export function renderDoc(source: string, pageUrl: string): string {
  parser ??= build();
  const env: Env = { base: pageUrl };
  return DOMPurify.sanitize(parser.render(source, env), {
    USE_PROFILES: { html: true },
    // How a page would restyle this frame, embed something in it, or post
    // from it. None of them is something a docs page needs.
    FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "link", "meta", "svg"],
    FORBID_ATTR: ["style", "formaction", "srcdoc"],
  });
}
