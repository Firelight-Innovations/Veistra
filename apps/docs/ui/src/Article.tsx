/**
 * One docs page, rendered from the Markdown the site serves beside its HTML.
 *
 * Links are caught here rather than left to the webview: an `<a>` followed
 * inside this frame would navigate the app away. A docs page stays in the
 * pane, a heading link scrolls, and anything else goes to the browser.
 */
import { useMemo, type MouseEvent } from "react";
import { classifyLink, type LinkTarget } from "./links";
import { renderDoc } from "./markdown";
import type { DocPage } from "./rpc";

export default function Article({
  page,
  home,
  onFollow,
  onOpenSite,
}: {
  page: DocPage;
  home: string;
  onFollow: (target: LinkTarget) => void;
  onOpenSite: () => void;
}) {
  const html = useMemo(() => renderDoc(page.markdown ?? "", page.url), [page.markdown, page.url]);

  const onClick = (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as Element).closest("a");
    const href = anchor?.getAttribute("href");
    if (!anchor || href === null || href === undefined) return;
    event.preventDefault();
    const target = classifyLink(href, page.url, home);
    if (target) onFollow(target);
  };

  return (
    <article className="docs__page">
      <div className="docs__toolbar">
        <button type="button" className="docs__button" onClick={onOpenSite}>
          Open in browser
        </button>
      </div>
      <div
        className="docs__prose"
        onClick={onClick}
        // Sanitised by `renderDoc`; see `markdown.ts` for the boundary.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}
