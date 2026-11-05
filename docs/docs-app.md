# Docs

Veistra's documentation and tutorials live on the website, at
<https://veistra.com/docs>. The Docs app reads them from there every time, so
editing the site changes what Veistra shows without a release. Nothing about the
content is bundled.

It replaced the Tutorials app, whose prose was compiled into the build
(`apps/tutorial/`, `src-tauri/src/apps/tutorial.rs`, `docs/user/tutorials/`).
Those are gone. The tutorials themselves are now pages on the site.

## 1. What it reads

Two things, both plain text the site already publishes:

| What | Where | Used for |
|---|---|---|
| The index | `{web}/llms.txt` | The contents rail, the overview, Home's cards |
| One page | `{web}/docs/<path>.md` | The page itself, as Markdown |

`{web}` is the `account.webUrl` setting, `https://veistra.com` by default, so a
staging site works the same way.

`llms.txt` is the [llms.txt](https://llmstxt.org) shape: a `# Title`, a
`> summary`, then `## Section` headings, each over a list of
`- [Title](https://veistra.com/docs/<path>.md): description` lines. Sections and
pages appear in the order the file lists them. A link that is not under
`/docs/`, or whose path is not lowercase segments of `[a-z0-9_-]`, is skipped.
The host in each link is ignored; every page is read from `{web}`.

The `.md` twin is read rather than the HTML page because the site sends
`X-Frame-Options: DENY`, so the page cannot be framed, and it sends no CORS
headers, so the webview cannot fetch it either. The fetch happens in Rust
(`src-tauri/src/apps/docs.rs`, through `cloud::http::agent()`), and the Markdown
is rendered in the pane by markdown-it and sanitised by DOMPurify
(`apps/docs/ui/src/markdown.ts`). The site's text is treated as untrusted, so no
script, handler, `javascript:` link, iframe or style survives.

## 2. Methods

| Method | Params | Answers |
|---|---|---|
| `docs/index` | — | `{ home, status, detail, title, summary, sections }` |
| `docs/page` | `{ path }` | `{ path, url, status, detail, markdown }` |
| `docs/open` | `{ path? , url? }` | Opens the page, the docs home, or a link, in the system browser |
| `home/docs` | — | `{ home, status, detail, cards, total }`: the first three pages, for Home |

`status` is one of:

- **`live`**: read from the site just now, or within the last five minutes.
- **`stale`**: the site could not be reached, so this is the copy read earlier
  in this session.
- **`offline`**: the site could not be reached, and nothing was kept.
- **`missing`**: the site answered with no such page (a 404, a 410, or an HTML
  page where Markdown was asked for).

`docs/open` accepts only `https` addresses, or `http` on loopback.

## 3. Offline

The pane never draws a blank. With no connection it shows **"Can't reach the
Veistra docs"**, the address of what was asked for, the error, **Try again**
and **Open in browser**. Home's column shows a line naming
`veistra.com/docs`, and its "Open the docs" link still opens the pane, which is
where Try again lives.

Anything read earlier in the session is served from memory, under a banner
saying it is a copy. The cache is in memory only, so a cold start with no
network has nothing to fall back on.

## 4. Links

A link inside a page is caught by the pane (`apps/docs/ui/src/links.ts`):

- another `/docs/…` page on the same site (`www.` or not) opens in the pane;
- `/docs` itself opens the overview;
- `#heading` scrolls to that heading;
- anything else on the web, including the rest of veistra.com, goes to the
  system browser through `docs/open`;
- any other scheme is not followed.

## 5. The doors in

- **Help ▸ Documentation** in the title bar opens the overview. The command
  palette offers the same row, because it is built from the menus.
- **Home's Docs column**: a card opens its page (`openIn("docs", { page })`),
  and the link under the cards opens the overview.
- **`veistra/open`** with app `docs` and a payload of `{ page: "<path>" }` opens
  that page. That is what Home's cards send.

## 6. A takeover surface

Docs **covers** the cluster rather than taking a pane beside it, the same way
Home does: `TAKEOVER_APPS` in `src/shell/WindowRoot.tsx`, `is_takeover_app` in
`src-tauri/src/shell_state.rs`, and `ToolWindow`'s `soloInstanceId`. A page of
prose squeezed into a quarter of the window beside three apps is not a smaller
version of reading.

- It has no tab in the switcher bar and no close button. It goes away when you
  choose anything else: an app, a tab, a chip, another cluster.
- The layout underneath is untouched.
- It is absent from the Apps menu and the switcher's `+`; Help ▸ Documentation
  and Home are its doors.
- Opening it from Home **covers** Home rather than evicting it, so leaving Docs
  goes back to Home (`one_takeover_surface_does_not_evict_another`).
- Being open is what makes it cover, so it is **closed** rather than merely
  uncovered when something else is chosen (`dismiss_takeover_closes_docs_too`).

## 7. Old layouts

A `layout.json` saved by a build that had Tutorials may hold a `tutorial`
instance. `shell_state::RETIRED_APPS` lists that id, and `restore()` drops such
instances and their tabs before anything mounts. A pane that held only the
tutorial is left empty, as closing a tab leaves it. Boot never tries to mount a
frontend that is no longer in the bundle.

A `tutorials.json` progress file from the old app may still be in the user data
folder. Nothing reads it.

## 8. What the website has to keep doing

These are the contract between the site and every installed Veistra. Changing
them is a breaking change for builds already in people's hands.

1. Serve `/llms.txt` in the shape above, listing every docs page.
2. Serve each page's Markdown at `/docs/<path>.md`, as `text/markdown` or
   `text/plain`, and answer 404 for one that does not exist rather than an HTML
   page with a 200.
3. Keep page paths stable. A renamed page shows "This page isn't on the docs
   site" in older builds until the user goes back to the overview.
4. Write links between docs pages as `/docs/<path>` or relative links, so they
   stay in the pane.
5. Order `llms.txt` with the pages Home should feature first. Home shows the
   first three.
