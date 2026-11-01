/**
 * ESLint configuration.
 *
 * Scope is deliberately narrow: this file encodes the rules STANDARDS.md §10
 * already lists as "not yet enforced", and almost nothing else. Every rule here
 * can be traced to a section of a document that was written before the linter
 * existed, so a failure cites a decision rather than a preference.
 *
 * What is deliberately absent: typescript-eslint's `recommended` and
 * `*-type-checked` tiers. They catch real defects `tsc --strict` misses
 * (`no-floating-promises` above all) and are the obvious next step, but they
 * are a much larger baseline than the documented rules, and mixing "things we
 * agreed to in writing" with "things the ecosystem suggests" in one pass makes
 * neither reviewable. Escalate by adding `tseslint.configs.recommended` below
 * once the current baseline is worked down.
 *
 * Existing violations are grandfathered in `eslint-suppressions.json`, not by
 * relaxing rules. A new violation in an old file still fails.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * The subdirectories of `src/shell` that count as regions for STANDARDS.md
 * §1.2 — the parts of the interface that are drawn, each buildable against
 * `contract.ts` alone.
 *
 * Two directories that used to be on this list are deliberately not:
 *
 * `state` is not a region. It draws nothing. It is the shell's verb layer —
 * the strip between `contract.ts` and `bindings.ts` where "send this back to
 * Rust" lives — and §1 says a region's job is to render a snapshot and send
 * verbs back. Treating it as a peer meant every region that needed a verb was
 * in violation, and the only conforming alternative was to thread nine more
 * function props through `WindowRoot`, which is already the largest file in
 * the tree. The isolation that mattered is kept, and enforced below: `state`
 * may not import a region, so the arrow still points one way.
 *
 * `scrollbar` is gone entirely. It held one component that four regions
 * wanted, which is the definition of a shared widget rather than a region;
 * `OverlayScrollbar.tsx` now sits directly under `src/shell/` beside
 * `contract.ts`, `motion.ts` and `dropZones.ts`.
 *
 * `telemetry` is off the list on purpose, and is the first *directory* to be a
 * shared leaf rather than a single file. It draws nothing: it is the feature
 * registry and the usage-data pipeline, and every region that has something
 * to report imports it — the title bar's Help menu, the tool window's bridge
 * handler, settings. What it would draw lives in the `dialogs` region, beside
 * the `Dialog` primitive its two modal dialogs are built on.
 */
const REGIONS = [
  "dialogs",
  "diff",
  "drag",
  "envbar",
  "frame",
  "github",
  "keys",
  "palette",
  "panel",
  "panes",
  "rail",
  "search",
  "settings",
  "statusbar",
  "stubs",
  "switcher",
  "terminal",
  "titlebar",
  "toolwindow",
  "worktree",
];

/**
 * §1.1 — `src/bindings.ts` is the only door to Rust. `packages/bridge` is
 * exempt because it *is* the other door: it wraps the same API for apps and
 * tools, which is the symmetry apps/README.md describes.
 */
const TAURI_RESTRICTION = {
  group: ["@tauri-apps/api", "@tauri-apps/api/**"],
  message:
    "STANDARDS.md §1.1: src/bindings.ts is the only file that may call invoke or listen. " +
    "Add a typed wrapper there instead of reaching past it.",
};

/**
 * §1.4 — apps and shell code talk to the bridge through its package entry
 * point, never by reaching into its source tree. Importing
 * `packages/bridge/src/*` by relative path bypasses the published surface and
 * would not survive the bridge being extracted to its own repository.
 */
const BRIDGE_RESTRICTION = {
  group: ["**/packages/bridge/src/**"],
  message:
    "STANDARDS.md §1.4: import from '@veistra/bridge', not from its source tree. " +
    "A relative path into packages/bridge/src breaks the moment the bridge ships separately.",
};

/** Restrictions that apply to every file under src/, apps/ and packages/. */
function baseRestrictions() {
  return [TAURI_RESTRICTION, BRIDGE_RESTRICTION];
}

/**
 * The first-party surfaces under `apps/`, each its own Vite entry point rather
 * than a workspace package (`apps/README.md`). Kept in sync with that file's
 * layout listing by hand — there is no directory scan here, matching how
 * `REGIONS` above is a hand-kept list rather than a `fs.readdirSync`, so an app
 * mid-scaffold with no `ui/` yet cannot make this config throw.
 *
 * `shared` is deliberately absent: it holds `apps/shared/app.css`, the common
 * chrome every app opts into by an absolute `/apps/shared/app.css` import, and
 * is not an app with a source tree of its own to be isolated from.
 */
const APPS = [
  "agent-tab",
  "agents",
  "blender-viewer",
  "canvas",
  "costs",
  "design",
  "files",
  "godot-viewer",
  "home",
  "play",
  "projects",
  "schematify",
  "tutorial",
  "viewer",
];

/**
 * PRD §14.6 / Schematify wave 10a scope item 2: gate TypeScript imports across
 * package boundaries in CI. `apps/README.md`'s "Apps talking to each other"
 * section already states the boundary in prose — an app reaches another app
 * only through the shell-routed `veistra/open` and `veistra/publish` topics, never
 * by importing its source — and this is that rule made mechanical, on the same
 * `no-restricted-imports` machinery `regionIsolation` below already uses for
 * `src/shell/<region>`.
 *
 * This is the reason a separate `dependency-cruiser` config was not added: the
 * repository already has an equivalent mechanism (flat-config
 * `no-restricted-imports` patterns) doing the same job for `src/shell/<region>`
 * and for the Tauri/bridge doors above, and a second tool enforcing the same
 * kind of boundary through a different config file and a different CI step
 * would be two sources of truth for one rule. Extending the existing one keeps
 * "which imports are illegal" answerable by reading one file.
 *
 * No existing app imports another today (confirmed by grep before adding
 * this), so the rule starts clean rather than needing a suppression.
 */
const appIsolation = APPS.map((app) => ({
  files: [`apps/${app}/ui/**/*.{ts,tsx}`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          ...baseRestrictions(),
          {
            // Two forms, unlike `regionIsolation`'s single `../${other}`: a
            // region's siblings sit one `../` away, but an app's source nests
            // arbitrarily deep under `ui/src/`, so a relative import out of it
            // and into another app never has a fixed `../` count for the
            // pattern to anchor on. `**/${other}/ui/**` matches the substring
            // regardless of how many `../` precede it — which is also why the
            // literal `apps/` form is kept alongside it, for the day an alias
            // or an absolute import reaches for one instead.
            group: APPS.filter((other) => other !== app).flatMap((other) => [
              `**/apps/${other}/ui/**`,
              `**/${other}/ui/**`,
            ]),
            message:
              `apps/README.md: the '${app}' app may not import another app's source. ` +
              "Two apps that need to reach each other do it through the shell-routed " +
              "veistra/open and veistra/publish topics, not a TypeScript import.",
          },
        ],
      },
    ],
  },
}));

/**
 * One config block per region, forbidding relative imports into any *other*
 * region.
 *
 * Files directly under `src/shell/` are not regions and stay importable:
 * `contract.ts` is the sanctioned vocabulary (§2), and `motion.ts` and
 * `hostWindow.ts` are shared leaf modules with no region of their own.
 *
 * This is written as per-region blocks rather than one global rule because
 * `no-restricted-imports` options replace rather than merge across flat-config
 * blocks — a region block that set only its own patterns would silently drop
 * the Tauri and bridge restrictions above.
 */
const regionIsolation = REGIONS.map((region) => ({
  files: [`src/shell/${region}/**/*.{ts,tsx}`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          ...baseRestrictions(),
          {
            group: REGIONS.filter((other) => other !== region).flatMap((other) => [
              `../${other}`,
              `../${other}/**`,
            ]),
            message:
              `STANDARDS.md §1.2: the '${region}' region may not import another region's source. ` +
              "Regions are built against src/shell/contract.ts and exchange everything else as props.",
          },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    // These are `**/`-anchored on purpose. A bare "dist/**" matches only the
    // repository root, which left examples/echo-tool/ui/dist and the Tauri
    // codegen assets under target/ being linted — 217 findings in bundled
    // output, swamping the 46 in code anyone writes.
    ignores: [
      "**/dist/**",
      "**/dist-ssr/**",
      "**/target/**",
      "**/node_modules/**",
      "public/**",
      // A git worktree an agent is working in, which is a second checkout of
      // this repository sitting inside it. Left in, every file is linted twice
      // and someone else's half-finished branch fails the gate on this one.
      ".claude/worktrees/**",
      // Regenerated from material-icon-theme on every install.
      "packages/file-icons/src/manifest.generated.ts",
      // Regenerated from branding.toml on every typecheck and build, once per
      // frontend bundle — hence the glob rather than three paths.
      "**/branding.generated.ts",
      // Generated from veistra-agent-host's event types by that crate's tests.
      "apps/agent-tab/ui/src/protocol.generated.ts",
      // Generated from src-tauri's refs::catalogue by that module's tests.
      "apps/agent-tab/ui/src/veistra-show.generated.ts",
    ],
  },

  js.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // `tsc` already reports these, and it reports them better. Leaving both
      // on means every unused import is two findings in two tools.
      "no-unused-vars": "off",
      "no-undef": "off",

      // §6.1 — no `any`. `unknown` at boundaries, narrowed immediately.
      "@typescript-eslint/no-explicit-any": "error",

      // §6.3 — `interface` for object shapes, `type` for unions and mirrors.
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],

      // §1.1 and §1.4, for everything the region blocks below do not cover.
      "no-restricted-imports": ["error", { patterns: baseRestrictions() }],
    },
  },

  // §1.1 — the files allowed through the Tauri door by the standard itself.
  //
  // `src/shell/hostWindow.ts` is deliberately NOT listed, even though it calls
  // the Tauri API today. §1.1 names exactly one door, and hostWindow is a
  // second one. Exempting it here would quietly ratify that; grandfathering it
  // in the suppressions file instead leaves it visible as a decision someone
  // still has to make — either fold it into bindings.ts or amend §1.1.
  {
    files: ["src/bindings.ts", "packages/bridge/src/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },

  // react-hooks is here for a specific reason rather than as a preset grab.
  // Three files already carry `// eslint-disable-next-line
  // react-hooks/exhaustive-deps`, two of them with a written justification —
  // so the codebase was authored expecting these rules, and without the plugin
  // ESLint errors on the disable comments themselves for naming a rule it does
  // not know. `rules-of-hooks` is also the mechanical half of §6.5.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  ...regionIsolation,
  ...appIsolation,

  // The other half of taking `state` off the region list. A region may call a
  // verb; the verb layer may not reach back up into a region. Without this the
  // reclassification above would be a hole rather than a layer — `state`
  // importing `toolwindow` would make the two mutually dependent and put the
  // shell back where §1.2 was written to stop it going.
  {
    files: ["src/shell/state/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...baseRestrictions(),
            {
              group: REGIONS.flatMap((region) => [`../${region}`, `../${region}/**`]),
              message:
                "STANDARDS.md §1.2: src/shell/state is the verb layer below the regions, " +
                "not a peer of them. It may not import a region's source. Take what you " +
                "need as an argument, or move the shared piece up to src/shell/.",
            },
          ],
        },
      ],
    },
  },

  // Design Mode's probe is browser code that lives under `src-tauri/` because
  // `include_str!` is what ships it — see the file's own header. It is the one
  // `.js` file in the tree that is neither a script nor a config, so it needs
  // the browser globals the `**/*.{ts,tsx}` block above gives everything else,
  // and `sourceType: "script"` because WebView2 injects it as a classic script
  // rather than as a module.
  {
    files: ["src-tauri/src/apps/design_probe.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },

  // Node scripts and config files run outside the browser. The fixture
  // generators under `crates/*/fixtures/` are the same kind of thing: build
  // tools run by hand, which happen to sit beside the crate whose test input
  // they write rather than in `scripts/`.
  {
    files: [
      "scripts/**/*.mjs",
      "packages/*/scripts/*.mjs",
      "crates/*/fixtures/*.mjs",
      "*.config.{ts,js}",
      "*.config.mjs",
    ],
    languageOptions: { globals: { ...globals.node } },
  },
);
