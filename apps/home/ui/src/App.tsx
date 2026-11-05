import { useCallback, useEffect, useState } from "react";
import { VeistraRpcError, invoke, on, openIn, reportPainted } from "@veistra/bridge";
import { PRODUCT_NAME, TAGLINE, WORDMARK } from "./branding.generated";
import { Book, Close, FolderOpen, FolderPlus, GitBranch, Mark, PackagePlus } from "./icons";
import NewProject from "./NewProjectPage";
import SignInScreen from "./SignInScreen";
import WorktreeDialog from "./WorktreeDialog";
import { showsSignIn } from "./account";
import { useAccount } from "./useAccount";
import "./home.css";
import "./account.css";

/**
 * One project, as `home/state` reports it.
 *
 * Declared here rather than imported from the orchestrator's `src/bindings.ts`,
 * for the same reason `icons.tsx` draws its own glyphs: an app's only coupling to
 * its host is `@veistra/bridge` and the shape of what crosses it. Only what this
 * pane actually draws is described — there is no `format` below, because Home
 * does not yet have anything to say about a project written by a newer Veistra.
 */
interface Project {
  name: string;
  path: string;
  id: string | null;
  /** Whether a `<name>.veistra` manifest is there. `false` is a plain folder. */
  initialized: boolean;
  /** Whether the folder is still on disk. A recent can outlive its project. */
  exists: boolean;
  /** Milliseconds since the Unix epoch. */
  lastOpened: number | null;
  modified: number | null;
}

interface Projects {
  open: Project | null;
  recents: Project[];
}

/** `home/state` is `Projects` plus the stack's version, for the heading. */
type State = Projects & { version?: string | null };

/**
 * `home/worktree-state`'s reply. Declared here for the same reason `Project`
 * is: this pane's only coupling to its host is `@veistra/bridge` and the shape
 * of what crosses it.
 */
interface WorktreeState {
  isRepo: boolean;
  worktree: { path: string; branch: string | null } | null;
  taken: string[];
}

/**
 * The three ways a session starts.
 *
 * A table rather than three copies of the same row markup, because the only
 * thing that differs between them is the icon, the words and the method — and
 * the moment that stops being true is the moment one of them quietly grows a
 * different hover, a different focus ring, or a different disabled state.
 */
const START: {
  method: string;
  label: string;
  icon: typeof FolderPlus;
  /** Set when the action cannot be taken yet, and says why. */
  unavailable?: string;
}[] = [
  { method: "home/new-project", label: "New Project", icon: FolderPlus },
  { method: "home/open-project", label: "Open Project", icon: FolderOpen },
  {
    method: "home/clone-project",
    label: "Clone Project",
    icon: GitBranch,
    unavailable: "Not built yet. Clone the repository yourself, then use Open Project.",
  },
  // Not a way a *session* starts, which is what the other three are — but it is
  // the same gesture (pick a folder, something appears) and this is the only
  // screen a person reliably passes through. It sits last so the three that do
  // start a session keep their order and their prominence.
  { method: "home/install-plugin", label: "Install App", icon: PackagePlus },
];

/**
 * Which `run()` methods can hand the user a repository they have not seen
 * open this session, and so are worth following up with `home/worktree-state`
 * — see `checkWorktree` below. `home/close-project` and `home/forget-recent`
 * never open anything, and `home/worktree-create` is dispatched by
 * `WorktreeDialog` itself rather than through `run`.
 */
const WORKTREE_TRIGGERS = new Set([
  "home/new-project",
  "home/open-project",
  "home/open-recent",
  "home/initialize-project",
]);

/**
 * The right-hand column, as `home/docs` reports it.
 *
 * The pages come from the website's docs index, read by the same code the Docs
 * app uses (`src-tauri/src/apps/docs.rs`), so the column changes when the site
 * does and a card opens the page it names. The backend picks which pages
 * (the first few the index lists), so Home makes no decision about ordering.
 */
interface DocCard {
  path: string;
  title: string;
  description: string;
  url: string;
}

interface Docs {
  /** `https://veistra.com/docs`, or wherever `account.webUrl` points. */
  home: string;
  status: "live" | "stale" | "offline" | "missing";
  detail: string | null;
  cards: DocCard[];
  total: number;
}

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Home has no router — there is exactly one other screen, so a boolean is
   * the whole of the state it takes to choose between them. `home/new-
   * project` used to open a native folder picker directly from the Start
   * list; board 14 replaces that with this full page, reached the same way
   * any other Start action is, but drawn instead of run.
   */
  const [showNewProject, setShowNewProject] = useState(false);
  /**
   * Which method is in flight, or `null`. A boolean would do for disabling, but
   * not for the label — New and Open both open a *native folder picker*, which
   * blocks until the user answers it. On the second monitor, or behind the
   * window, that is a UI that has silently stopped responding unless it says
   * what it is waiting for.
   */
  const [pending, setPending] = useState<string | null>(null);
  /**
   * Set once a project has just opened into a repo with no worktree yet, and
   * cleared however the dialog ends — decline, create, or Escape. Holding
   * only `taken` rather than the whole `WorktreeState`: `worktree` is always
   * `null` here by construction (see `checkWorktree`), and `isRepo` has
   * already done its job of deciding whether to show this at all.
   */
  const [worktreePrompt, setWorktreePrompt] = useState<{ taken: string[] } | null>(null);
  /**
   * The docs column. `null` until it lands; `"failed"` if the call itself
   * fails. A Home whose docs could not be read still has a Start column and a
   * Recent list, which is the whole of what somebody came here for, so the
   * column says so in place rather than showing an error beside the projects.
   */
  const [docs, setDocs] = useState<Docs | "failed" | null>(null);
  const account = useAccount();

  /**
   * Ask whether the project that just opened wants a worktree prompt. Fired
   * after `run()` succeeds at one of `WORKTREE_TRIGGERS`, never awaited by
   * the caller — this is a follow-up offer sitting on top of an already
   * successful open, not a step that open is waiting on.
   */
  const checkWorktree = useCallback(() => {
    void invoke<WorktreeState>("home/worktree-state")
      .then((next) => {
        if (next.isRepo && next.worktree === null) setWorktreePrompt({ taken: next.taken });
      })
      .catch(() => {
        // Silent on purpose: the project itself opened fine, and a failed
        // check here just means no offer, not a broken Home.
      });
  }, []);

  const run = useCallback(
    (method: string, params?: Record<string, unknown>) => {
      // One picker at a time. Two would fight over the same parent window, and
      // whichever answered second would act on a stale list.
      if (pending) return;

      setPending(method);
      void invoke<Projects>(method, params)
        .then((next) => {
          // `version` comes only from `home/state`; a mutator answers with the
          // projects alone. Carried forward rather than dropped so `state` stays
          // a faithful copy of what the host last reported — nothing on this
          // page draws it today, and a mutator's reply is not evidence that the
          // stack under it changed version.
          setState((previous) => ({ ...next, version: previous?.version ?? null }));
          setError(null);
          if (WORKTREE_TRIGGERS.has(method)) checkWorktree();
        })
        .catch((e: unknown) => setError(describe(e)))
        .finally(() => setPending(null));
    },
    [pending, checkWorktree],
  );

  // Read on mount, and again whenever this cluster is repointed by something
  // other than Home: the title bar's switcher, an agent's `set_project`. The
  // shell relays `project:changed` only into frames in the cluster it names,
  // so every one that arrives here is about this Home's own cluster.
  useEffect(() => {
    let live = true;

    const read = () => {
      void invoke<State>("home/state")
        .then((next) => {
          if (live) {
            setState(next);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (live) setError(describe(e));
        });
    };

    read();
    const stop = on("project:changed", read);

    return () => {
      stop();
      live = false;
    };
  }, []);

  /**
   * Reread `home/state` when the New Project page hands control back —
   * cancelled or finished, the read is the same one call, and a project
   * Create just opened needs to show up in `open`/`recents` the same way any
   * other newly opened project does.
   */
  const closeNewProject = useCallback(() => {
    setShowNewProject(false);
    void invoke<State>("home/state")
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((e: unknown) => setError(describe(e)));
  }, []);

  /**
   * Refetched on focus as well as on mount, so a Home opened offline fills in
   * once the connection is back. The backend caches for a few minutes, so a
   * focus is not a request to the site each time.
   */
  useEffect(() => {
    let live = true;

    const read = () => {
      void invoke<Docs>("home/docs")
        .then((next) => {
          if (live) setDocs(next);
        })
        .catch(() => {
          // The Start and Recent columns are unaffected; the docs column
          // draws its own offline line.
          if (live) setDocs((previous) => (previous === null ? "failed" : previous));
        });
    };

    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);

  /**
   * Home is the app Veistra opens on, so the splash window is held up until this
   * pane has something on it — see `reportPainted` in `@veistra/bridge`, and
   * `boot::await_apps` for what is waiting.
   *
   * The condition is "the first answer landed", either way it went. A Home that
   * could not read its state has still finished drawing: it will show the error
   * and the three Start actions, which is the whole of what it has to say, and
   * holding the window back for a screen that is not going to improve would
   * only make the failure slower to reach.
   */
  useEffect(() => {
    if (state !== null || error !== null) reportPainted();
  }, [state, error]);

  const open = state?.open ?? null;
  const recents = state?.recents ?? [];

  if (showNewProject) return <NewProject onDone={closeNewProject} />;

  if (showsSignIn(account.status, account.welcoming) && account.status) {
    return (
      <SignInScreen
        status={account.status}
        me={account.me}
        busy={account.busy}
        error={account.error}
        onSignIn={account.signIn}
        onCancel={account.cancel}
        onOwnSignIn={account.useOwnSignIn}
        onContinue={account.finishWelcome}
      />
    );
  }

  return (
    <div className="home home--with-account">
      <div className="home__main">
        <div className="home__inner">
          <header className="home__hero">
            {/*
             * The lockup from section 03 of the brand packet: the mark, then the
             * name. Every measurement in it — the mark's own size included — is a
             * ratio of one number, so it lives in `home.css` rather than being
             * passed in here; `Mark` takes the size from the CSS. The word is set
             * in mixed case and uppercased by the stylesheet, exactly as the
             * packet sets it, which also keeps a screen reader saying a word
             * rather than spelling out five letters — and is why the wordmark is
             * a field of its own in `branding.toml` beside the product's name.
             */}
            <h1 className="home__lockup">
              <Mark className="home__lockup-mark" />
              <span className="home__lockup-word">{WORDMARK}</span>
            </h1>
            <p className="home__tagline">{TAGLINE}</p>
          </header>

          {open && (
            <div className="home__open">
              <span className="home__open-label">Open</span>
              <ProjectTile project={open} className="home__tile home__tile--open" />
              <span className="home__open-name">{open.name}</span>
              <span className="home__open-path" title={open.path}>
                {open.path}
              </span>
              {!open.initialized && (
                <button
                  type="button"
                  className="home__ghost"
                  disabled={pending !== null}
                  onClick={() => run("home/initialize-project", { path: open.path })}
                >
                  Set up as a {PRODUCT_NAME} project
                </button>
              )}
              <button
                type="button"
                className="home__ghost"
                disabled={pending !== null}
                onClick={() => run("home/close-project")}
              >
                Close
              </button>
            </div>
          )}

          {error && <p className="home__error">{error}</p>}

          <div className="home__columns">
            <section className="home__column">
              <h2 className="home__heading">Start</h2>
              <ul className="home__actions">
                {START.map(({ method, label, icon: Icon, unavailable }) => (
                  <li key={method}>
                    <button
                      type="button"
                      className="home__action"
                      // A clone button that opened a dialog to say "not yet" would
                      // be a worse answer than one that never suggested it could.
                      disabled={unavailable !== undefined || pending !== null}
                      title={unavailable}
                      // New Project no longer opens a native picker directly —
                      // see `showNewProject` above — every other Start action
                      // still goes straight through `run`.
                      onClick={() =>
                        method === "home/new-project" ? setShowNewProject(true) : run(method)
                      }
                    >
                      <Icon size={18} className="home__action-icon" />
                      <span>{label}</span>
                      {pending === method && (
                        <span className="home__waiting">choose a folder…</span>
                      )}
                      {unavailable && <span className="home__soon">soon</span>}
                    </button>
                  </li>
                ))}
              </ul>

              <h2 className="home__heading home__heading--spaced">Recent</h2>
              {recents.length === 0 ? (
                <p className="home__empty">
                  {state === null && !error
                    ? "Reading…"
                    : "Nothing yet. Open a folder and it will be waiting here next time."}
                </p>
              ) : (
                <ul className="home__recents">
                  {recents.map((project) => (
                    <Recent
                      key={project.path}
                      project={project}
                      busy={pending !== null}
                      onOpen={() => run("home/open-recent", { path: project.path })}
                      onForget={() => run("home/forget-recent", { path: project.path })}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="home__column">
              <h2 className="home__heading">Docs</h2>
              <DocsColumn docs={docs} />
            </section>
          </div>
        </div>
      </div>

      {worktreePrompt && (
        <WorktreeDialog
          projectName={open?.name ?? ""}
          taken={worktreePrompt.taken}
          onCancel={() => setWorktreePrompt(null)}
          onCreated={() => setWorktreePrompt(null)}
        />
      )}
    </div>
  );
}

/** Where the docs live when the backend could not even say. */
const DOCS_FALLBACK = "https://veistra.com/docs";

/**
 * The docs column: a few pages from the website's index, and a way to the rest.
 *
 * `openIn` rather than a link: this pane cannot address another surface, and
 * must not be able to. It names a *kind* of app and the shell decides which
 * one answers (`docs/tool-protocol.md` §3). "All docs" is drawn even offline,
 * because the Docs pane is where the offline notice and Try again live.
 */
function DocsColumn({ docs }: { docs: Docs | "failed" | null }) {
  if (docs === null) return <p className="home__empty">Reading…</p>;
  const failed = docs === "failed";
  const cards = failed ? [] : docs.cards;
  const home = failed ? DOCS_FALLBACK : docs.home;
  const offline = failed || docs.status === "offline";

  return (
    <>
      {cards.length === 0 && (
        <p className="home__empty">
          {offline ? (
            <>
              Can’t reach the docs right now. They are at{" "}
              <span className="home__docs-url">{home.replace(/^https?:\/\//, "")}</span>.
            </>
          ) : (
            "The docs site lists no pages yet."
          )}
        </p>
      )}
      {cards.length > 0 && (
        <ul className="home__cards">
          {cards.map((card) => (
            <li key={card.path}>
              <button
                type="button"
                className="home__card"
                onClick={() => void openIn("docs", { page: card.path })}
              >
                <span className="home__card-mark">
                  <Book size={16} />
                </span>
                <span className="home__card-text">
                  <span className="home__card-title">{card.title}</span>
                  <span className="home__card-blurb">{card.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="home__all-docs" onClick={() => void openIn("docs")}>
        {!failed && docs.total > cards.length ? `All ${docs.total} pages` : "Open the docs"}
      </button>
    </>
  );
}

/**
 * A project's own icon (`.veistra/icon.*`), or its initial when it has none.
 *
 * Asked per project rather than folded into `home/state`: the icon is a data
 * URL, and carrying one for every Recent row on every state read would make the
 * common read the expensive one. Asked again when this pane regains focus, the
 * same way the docs column is, since the icon is set from the shell's
 * Switch project dialog and nothing tells this pane it changed.
 */
function ProjectTile({ project, className }: { project: Project; className: string }) {
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setIcon(null);
    if (!project.exists) return;

    const read = () => {
      void invoke<{ icon: string | null }>("home/project-icon", { path: project.path })
        .then((next) => {
          if (live) setIcon(next.icon);
        })
        .catch(() => {
          // The initial, which is what `null` already draws.
        });
    };

    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [project.path, project.exists]);

  if (icon !== null) {
    return (
      <span className={`${className} home__tile--image`} aria-hidden="true">
        <img src={icon} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {project.name.charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Recent({
  project,
  busy,
  onOpen,
  onForget,
}: {
  project: Project;
  busy: boolean;
  onOpen: () => void;
  onForget: () => void;
}) {
  const when = since(project.lastOpened);

  return (
    <li className={`home__recent${project.exists ? "" : " home__recent--gone"}`}>
      <button
        type="button"
        className="home__recent-open"
        // A folder that isn't there cannot be opened, and the row says so rather
        // than failing on click. Forget still works — that is the whole action
        // left that makes sense for it.
        disabled={busy || !project.exists}
        onClick={onOpen}
        title={project.path}
      >
        <ProjectTile project={project} className="home__tile" />
        <span className="home__recent-name">{project.name}</span>
        <span className="home__recent-path">{project.path}</span>
        <span className="home__recent-meta">
          {!project.exists ? "missing" : !project.initialized ? "not set up" : when}
        </span>
      </button>
      <button
        type="button"
        className="home__forget"
        disabled={busy}
        onClick={onForget}
        aria-label={`Remove ${project.name} from the recent list`}
        title="Remove from this list. Nothing is deleted."
      >
        <Close size={14} />
      </button>
    </li>
  );
}

/**
 * "2 hours ago", from a timestamp.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder, because it is
 * already in the webview and already knows the plural rules. The units run
 * largest to smallest and the first one the gap clears wins, which is what makes
 * three days read as "3 days ago" rather than "72 hours ago".
 */
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function since(at: number | null): string {
  if (!at) return "";

  const delta = at - Date.now();
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) return RELATIVE.format(Math.round(delta / size), unit);
  }
  return "just now";
}

/**
 * A `VeistraRpcError` carries the JSON-RPC code its host produced it from, which
 * is the difference between "this build has no such method" and "the call never
 * reached a host at all". Anything else is shown as-is rather than guessed at.
 */
function describe(error: unknown): string {
  if (error instanceof VeistraRpcError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
