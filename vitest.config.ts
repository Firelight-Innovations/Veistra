import { defineConfig } from "vitest/config";

/**
 * Vitest for the shell and the first-party apps.
 *
 * `node` is still the default environment, and most of what runs here still
 * wants it: the query grammar, the kind table, the layout maths and the
 * `scripts/` node scripts have no use for a DOM and should not pay for one.
 * What changed is that a test may now ask for a DOM, one file at a time, with
 * a `// @vitest-environment jsdom` docblock at the top. The first customer is
 * `src/shell/worktree/rowFocus.test.tsx` — see issue #74.
 *
 * `packages/` and `examples/` keep their own configs and their own runs — see
 * `test:js` in package.json, which is both halves.
 */

/**
 * Why jsdom, and not happy-dom.
 *
 * happy-dom is the faster of the two and would be the better answer if the DOM
 * here were scenery. It is not: what this environment exists to test is
 * *interaction mechanics* — which element ends up focused, whether a handler
 * cancelled an event's default, how a mouse sequence pairs up. Those are
 * precisely the corners where a reimplementation of the DOM is most likely to
 * differ from a browser, and a component test that passes against a lenient
 * DOM is worse than no component test at all, because it reads as evidence.
 * jsdom is also the environment React Testing Library is developed against,
 * which matters for `act` and for React's event delegation.
 *
 * The cost is startup, not steady state — jsdom is a few hundred milliseconds
 * per DOM file against happy-dom's few tens. Scoped per file rather than
 * globally (below), that is paid by the component tests and by nothing else.
 */

/**
 * Why jsdom is held at 29, in `pnpm.overrides` and not only in `devDependencies`.
 *
 * jsdom 30 declares `engines.node` of `^22.22.2 || ^24.15.0 || >=26.0.0` and
 * pulls undici 8, which calls `require("node:worker_threads").markAsUncloneable`
 * unconditionally. That function does not exist on Node 20, which every
 * workflow pins, so the jsdom worker dies before a single test runs. undici 7 —
 * what jsdom 29 pulls — guards the same call behind a runtime-feature check and
 * falls back to a no-op, and jsdom 29 supports `^20.19.0` on purpose. Nothing
 * about the paragraphs above changes: 29 is one major back, same DOM, same
 * focus and event semantics.
 *
 * The override rather than the version alone, because `packages/bridge` has its
 * own vitest and pnpm resolves vitest's *optional* `jsdom` peer for it from the
 * registry — which quietly reinstalled jsdom 30 into the tree even after the
 * root pinned 29.
 *
 * **The hazard this leaves.** A jsdom file that cannot start is a worker crash,
 * not a failing assertion: the run goes red, but the file simply is not counted,
 * and the summary reads as a smaller suite that passed. CI reported "47 files /
 * 787 tests passed" for a run where this file never executed. So a Node or jsdom
 * bump is checked by the file count, not by the word "passed" — and `.nvmrc`
 * names the Node the workflows run, because a local pass on a newer one is not
 * evidence.
 */

/**
 * Why React Testing Library.
 *
 * The shell is React 19 — `react`/`react-dom` in package.json, every region
 * under `src/shell/` a function component — so the library has to be a React
 * one. `@testing-library/react` v16 is the maintained option that supports
 * React 19 (Enzyme has no React 19 adapter), and its queries are role- and
 * label-based, which agrees with how the shell already names its controls for
 * screen readers. Rendering by hand with `react-dom/client` and `act` was the
 * alternative: it adds no dependency, but it reimplements mounting, cleanup
 * and querying in every test file.
 *
 * What was **not** chosen, and is worth knowing about: Vitest browser mode
 * driving a real Chromium through Playwright. That is the only option that
 * does layout and hit-testing, and so the only one that could reproduce
 * #48.1's symptom rather than its fix's mechanism. It is out of scope here —
 * it needs a browser binary in CI, which is a larger decision than "the repo
 * can render a component" — not wrong. If component tests grow past what a
 * layout-free DOM can express, that is the next step rather than more jsdom.
 */

/**
 * Why a per-file docblock rather than a DOM for the whole config.
 *
 * `include` below covers `scripts/**` + `/*.test.mjs`, which are node scripts:
 * they read the filesystem and shell out, and handing them a `window` would
 * let a browser-only global be used in one by accident and never be caught.
 * Flipping the whole config would also make the existing pure-module tests pay
 * jsdom's startup for a DOM they never touch.
 *
 * The two ways to scope it are this docblock and `environmentMatchGlobs`. The
 * latter was removed in Vitest 4 — `test.projects` replaces it, which would
 * mean two runs where there is one — and the docblock is the better shape
 * anyway: a file that needs a DOM says so on its own first line, where the
 * person reading the test sees it, rather than in a glob three directories up.
 */
export default defineConfig({
  // A `.glb` is a binary asset, so `?inline` hands a test its bytes as a data
  // URL; Vite does not know the extension otherwise. Blender's Compare reads
  // the cube pair this way (`apps/blender-viewer/ui/src/compare/`).
  assetsInclude: ["**/*.glb"],
  test: {
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx}",
      "apps/*/ui/src/**/*.test.{ts,tsx}",
      // `apps/shared/` holds logic more than one app imports (see
      // `apps/shared/comments.ts`), not a `ui/` tree of its own — a separate
      // pattern rather than widening the one above, so a stray test dropped
      // beside some *other* app's `index.html` still fails to be found rather
      // than silently running from the wrong place.
      "apps/shared/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
    ],
    // Vitest blanks every CSS import by default, `?raw` included. A `?raw`
    // import is text, not a stylesheet — nothing is injected — so letting
    // just those through costs nothing and lets a test read a declaration
    // (`src/shell/chromeAlignment.test.ts`).
    css: { include: [/\.css\?raw$/] },
  },
});
