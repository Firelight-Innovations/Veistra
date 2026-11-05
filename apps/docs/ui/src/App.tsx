/**
 * Docs — Veistra's documentation and tutorials, read from the website.
 *
 * Nothing here is bundled. The page list is the site's `llms.txt` and each page
 * is its Markdown copy, both fetched by `src-tauri/src/apps/docs.rs` when this
 * pane asks, so editing the site changes what this shows without a release.
 * `docs/docs-app.md` has the whole account.
 *
 * Two ways in: Home's Docs column, and Help ▸ Documentation in the title bar.
 * Both go through `veistra/open`, and a payload of `{ page }` names the page to
 * land on. Nothing is cluster-scoped — `docs::call` ignores its `CallContext`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { on, reportPainted, OPENED_EVENT } from "@veistra/bridge";
import Article from "./Article";
import { isPagePath, type LinkTarget } from "./links";
import { ANCHOR_PREFIX } from "./markdown";
import {
  FALLBACK_HOME,
  describe,
  openInBrowser,
  readIndex,
  readPage,
  type DocPage,
  type DocsIndex,
} from "./rpc";
import { Notice, Overview, Rail, StaleBanner } from "./views";
import "./docs.css";

export default function App() {
  const [index, setIndex] = useState<DocsIndex | null>(null);
  /** The backend did not answer at all, which is drawn the way offline is. */
  const [indexError, setIndexError] = useState<string | null>(null);
  /** The browser could not be handed a link. */
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  /** The page on screen, by path, or `null` for the overview. */
  const [current, setCurrent] = useState<string | null>(null);
  const [page, setPage] = useState<DocPage | null>(null);
  /** Bumped by "Try again", so the same page can be asked for twice. */
  const [attempt, setAttempt] = useState(0);
  const pendingHash = useRef<string>("");

  useEffect(() => {
    let live = true;
    void readIndex()
      .then((next) => {
        if (!live) return;
        setIndex(next);
        setIndexError(null);
      })
      .catch((e: unknown) => {
        if (live) setIndexError(describe(e));
      })
      .finally(() => {
        if (live) setSettled(true);
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (current === null) {
      setPage(null);
      return;
    }
    let live = true;
    setPage(null);
    void readPage(current)
      .then((next) => {
        if (live) setPage(next);
      })
      .catch((e: unknown) => {
        // Drawn as offline rather than left on "Reading…": the reader still
        // gets the address, and a way to try again.
        if (live) setPage(unreadable(current, e));
      });
    return () => {
      live = false;
    };
  }, [current, attempt]);

  /** The splash window waits on this — see `apps/README.md`. */
  useEffect(() => {
    if (settled) reportPainted();
  }, [settled]);

  const open = useCallback((path: string | null, hash = "") => {
    pendingHash.current = hash;
    setCurrent(path);
    // The rail and the page share no scroll container, but two pages share
    // this one, and arriving halfway down a page you just opened reads as a
    // rendering bug.
    document.querySelector(".docs__main")?.scrollTo({ top: 0 });
  }, []);

  /** Home's cards and Help ▸ Documentation, through `veistra/open`. */
  useEffect(
    () =>
      on(OPENED_EVENT, (payload) => {
        const path = (payload as { page?: unknown } | null)?.page;
        open(typeof path === "string" && isPagePath(path) ? path : null);
      }),
    [open],
  );

  const home = index?.home ?? FALLBACK_HOME;
  const openSite = useCallback((target: { path?: string; url?: string } = {}) => {
    void openInBrowser(target).catch((e: unknown) => setFailure(describe(e)));
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const follow = useCallback(
    (target: LinkTarget) => {
      if (target.kind === "index") open(null);
      else if (target.kind === "page") open(target.path, target.hash);
      else if (target.kind === "external") openSite({ url: target.url });
      else scrollToAnchor(target.id);
    },
    [open, openSite],
  );

  // Once the page has drawn, go to the heading a link asked for.
  useEffect(() => {
    if (page?.markdown && pendingHash.current) {
      scrollToAnchor(pendingHash.current);
      pendingHash.current = "";
    }
  }, [page]);

  const hasRail = index !== null && index.sections.length > 0;
  const indexStatus = index?.status ?? "offline";

  return (
    <div className={`app docs${hasRail ? "" : " docs--bare"}`}>
      {hasRail && (
        <Rail index={index} current={current} onOpen={open} onOpenSite={() => openSite()} />
      )}

      <main className="docs__main">
        {failure !== null && <p className="docs__error">{failure}</p>}

        {current === null ? (
          !settled ? (
            <p className="docs__waiting">Reading…</p>
          ) : index !== null && (indexStatus === "live" || indexStatus === "stale") ? (
            <>
              {indexStatus === "stale" && <StaleBanner detail={index.detail} />}
              <Overview index={index} onOpen={(p) => open(p.path)} />
            </>
          ) : (
            <Notice
              status="offline"
              url={home}
              detail={index?.detail ?? indexError}
              onRetry={retry}
              onOpenSite={() => openSite()}
            />
          )
        ) : page === null ? (
          <p className="docs__waiting">Reading…</p>
        ) : page.markdown !== null ? (
          <>
            {page.status === "stale" && <StaleBanner detail={page.detail} />}
            <Article
              page={page}
              home={home}
              onFollow={follow}
              onOpenSite={() => openSite({ path: page.path })}
            />
          </>
        ) : (
          <Notice
            status={page.status === "missing" ? "missing" : "offline"}
            url={page.url}
            detail={page.detail}
            onRetry={retry}
            onOpenSite={() => openSite({ url: page.url })}
            onBack={() => open(null)}
          />
        )}
      </main>
    </div>
  );
}

/** A page whose read failed before the backend could say how. */
function unreadable(path: string, error: unknown): DocPage {
  return {
    path,
    url: `${FALLBACK_HOME}/${path}`,
    status: "offline",
    detail: describe(error),
    markdown: null,
  };
}

function scrollToAnchor(id: string) {
  const target = document.getElementById(ANCHOR_PREFIX + id) ?? document.getElementById(id);
  target?.scrollIntoView({ block: "start" });
}
