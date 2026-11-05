/**
 * The parts of the Docs pane that are not a page: the contents rail, the
 * overview, and the notices drawn in place of a page that could not be read.
 */
import type { DocsIndex, Page, Status } from "./rpc";

export function Rail({
  index,
  current,
  onOpen,
  onOpenSite,
}: {
  index: DocsIndex;
  current: string | null;
  onOpen: (path: string | null) => void;
  onOpenSite: () => void;
}) {
  return (
    <nav className="docs__rail" aria-label="Contents">
      <button
        type="button"
        className={`docs__rail-item docs__rail-home${current === null ? " docs__rail-item--on" : ""}`}
        aria-current={current === null ? "page" : undefined}
        onClick={() => onOpen(null)}
      >
        Overview
      </button>
      {index.sections.map((section) => (
        <section key={section.title} className="docs__rail-section">
          {section.title && <h2 className="docs__rail-title">{section.title}</h2>}
          <ul>
            {section.pages.map((page) => (
              <li key={page.path}>
                <button
                  type="button"
                  className={`docs__rail-item${page.path === current ? " docs__rail-item--on" : ""}`}
                  aria-current={page.path === current ? "page" : undefined}
                  onClick={() => onOpen(page.path)}
                >
                  {page.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <button type="button" className="docs__rail-site" onClick={onOpenSite}>
        {siteLabel(index.home)} ↗
      </button>
    </nav>
  );
}

/** `veistra.com/docs`, for a link that names where it goes. */
export function siteLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function Overview({ index, onOpen }: { index: DocsIndex; onOpen: (page: Page) => void }) {
  return (
    <div className="docs__overview">
      <h1 className="docs__title">{index.title || "Docs"}</h1>
      {index.summary && <p className="docs__summary">{index.summary}</p>}
      {index.sections.length === 0 && (
        <p className="docs__empty">
          The index at {siteLabel(index.home)} lists no pages yet. Open it in the browser to see
          what is there.
        </p>
      )}
      {index.sections.map((section) => (
        <section key={section.title} className="docs__group">
          {section.title && <h2 className="docs__group-title">{section.title}</h2>}
          <ul className="docs__cards">
            {section.pages.map((page) => (
              <li key={page.path}>
                <button type="button" className="docs__card" onClick={() => onOpen(page)}>
                  <span className="docs__card-title">{page.title}</span>
                  {page.description && <span className="docs__card-blurb">{page.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * Drawn instead of a page that could not be read: what went wrong, the
 * address it lives at, and the two things that can be done about it.
 */
export function Notice({
  status,
  url,
  detail,
  onRetry,
  onOpenSite,
  onBack,
}: {
  status: Extract<Status, "offline" | "missing">;
  url: string;
  detail: string | null;
  onRetry: () => void;
  onOpenSite: () => void;
  onBack?: () => void;
}) {
  const offline = status === "offline";
  return (
    <div className="docs__notice" role="alert">
      <h1 className="docs__notice-title">
        {offline ? "Can’t reach the Veistra docs" : "This page isn’t on the docs site"}
      </h1>
      <p>
        {offline
          ? "Veistra reads its documentation from the website each time, so it needs a connection. The page is at:"
          : "The docs site has no page at this address. It may have moved or been renamed:"}
      </p>
      <p>
        <code className="docs__url">{url}</code>
      </p>
      {detail && <p className="docs__detail">{detail}</p>}
      <div className="docs__actions">
        {offline ? (
          <button type="button" className="docs__button docs__button--primary" onClick={onRetry}>
            Try again
          </button>
        ) : (
          onBack && (
            <button type="button" className="docs__button docs__button--primary" onClick={onBack}>
              Back to the overview
            </button>
          )
        )}
        <button type="button" className="docs__button" onClick={onOpenSite}>
          Open in browser
        </button>
      </div>
    </div>
  );
}

/** Above a page or overview the site could not be asked for just now. */
export function StaleBanner({ detail }: { detail: string | null }) {
  return (
    <p className="docs__stale" role="status" title={detail ?? undefined}>
      Showing the copy read earlier in this session. The docs site can’t be reached right now.
    </p>
  );
}
