import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Two dev servers, deliberately.
 *
 * Port 1420 belongs to `pnpm app` — `tauri dev` starts Vite itself and then
 * points the webview at a *fixed* URL, so that port cannot move and cannot be
 * shared. Anything else holding it doesn't degrade, it fails the whole run.
 *
 * Agents verifying work in a plain browser therefore get their own range via
 * `pnpm dev:agent`, and `strictPort` is off for them so a second and third
 * agent step up to 1431, 1432 rather than colliding. `--mode agent` is what
 * selects it: a CLI flag Vite already understands, so this needs no env var
 * and no `cross-env` shim to work the same in PowerShell and bash.
 *
 * 1430 rather than 1421 because 1421 is taken below by HMR when
 * `TAURI_DEV_HOST` is set for mobile.
 */
const AGENT_PORT = 1430;
const TAURI_PORT = 1420;

// @ts-expect-error process is a nodejs global
const SCHEMATIFY = process.env.VEISTRA_SCHEMATIFY === "1";
// @ts-expect-error process is a nodejs global
const DESIGN_MODE = process.env.VEISTRA_DESIGN_MODE === "1";

/**
 * Serves and emits Excalidraw's fonts at `/vendor/excalidraw/fonts/`, which is
 * where the Canvas app points `window.EXCALIDRAW_ASSET_PATH`.
 *
 * Excalidraw loads its fonts at runtime from that path and, unset, from a public
 * CDN — which a desktop app must not depend on, and which would not work
 * offline. `Xiaolai` (the CJK fallback, 13 MB) is left out; CJK text falls back to
 * a system font, and every other family (about 0.5 MB together) ships.
 */
function excalidrawFonts(): Plugin {
  const dir = resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const URL_BASE = "/vendor/excalidraw/fonts/";
  const skip = new Set(["Xiaolai"]);
  const walk = (base: string, rel = ""): string[] =>
    readdirSync(resolve(base, rel)).flatMap((name) => {
      const next = rel ? `${rel}/${name}` : name;
      if (!rel && skip.has(name)) return [];
      return statSync(resolve(base, next)).isDirectory() ? walk(base, next) : [next];
    });
  return {
    name: "veistra-excalidraw-fonts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith(URL_BASE)) return next();
        const rel = decodeURIComponent(url.slice(URL_BASE.length));
        const file = resolve(dir, rel);
        if (rel.includes("..") || !file.startsWith(dir) || !existsSync(file)) return next();
        res.setHeader("Content-Type", "font/woff2");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      if (!existsSync(dir)) return;
      for (const rel of walk(dir)) {
        this.emitFile({
          type: "asset",
          fileName: `vendor/excalidraw/fonts/${rel}`,
          source: readFileSync(resolve(dir, rel)),
        });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), excalidrawFonts()],

  build: {
    rollupOptions: {
      // Vite defaults to a single entry at index.html, so `splash.html` is
      // declared here too — otherwise it is simply ignored by the build and
      // never reaches `dist/`, and the splash window would open on a 404.
      //
      // It produces no chunks of its own. `splash.html` imports nothing: its
      // styles, SVGs, wordmark font and boot logic are all inlined into the
      // file itself, so Vite finds no module graph to bundle and copies it
      // through verbatim. That is deliberate — see the comment at the top of
      // `splash.html` for why the splash window is kept free of any
      // dependency on this application's code.
      //
      // The first-party apps are entries for a different reason. Each is a
      // separate document mounted in an iframe (`src-tauri/src/apps/`), so each
      // needs its own HTML and its own module graph — but they are built *here*,
      // by the shell's own config, rather than by a Vite project of their own.
      //
      // There is one entry per row in `apps::REGISTRY`, and this is the piece
      // that cannot be inferred from that list: Vite has to be told about every
      // HTML entry point or it silently builds none of it. An app added to the
      // registry without a line here mounts a 404.
      //
      // That is what makes `apps::entry_url` able to hand back a root-relative
      // path and be right under both hosts. An entry's HTML lands in `dist/` at
      // the path it occupies in the source tree, so `apps/home/ui/index.html`
      // is reachable at `/apps/home/ui/index.html` from Vite in development and
      // from Tauri's asset host in a release build — one URL, no per-app dev
      // server to remember to start, and nothing to add to `bundle.resources`.
      //
      // A tool gets none of this. It is another repository with its own build,
      // served from its own origin; see `src-tauri/src/tool_frontend.rs`.
      input: {
        main: resolve(__dirname, "index.html"),
        splash: resolve(__dirname, "splash.html"),
        home: resolve(__dirname, "apps/home/ui/index.html"),
        files: resolve(__dirname, "apps/files/ui/index.html"),
        viewer: resolve(__dirname, "apps/viewer/ui/index.html"),
        "godot-viewer": resolve(__dirname, "apps/godot-viewer/ui/index.html"),
        "blender-viewer": resolve(__dirname, "apps/blender-viewer/ui/index.html"),
        canvas: resolve(__dirname, "apps/canvas/ui/index.html"),
        docs: resolve(__dirname, "apps/docs/ui/index.html"),
        agents: resolve(__dirname, "apps/agents/ui/index.html"),
        "agent-tab": resolve(__dirname, "apps/agent-tab/ui/index.html"),
        costs: resolve(__dirname, "apps/costs/ui/index.html"),
        projects: resolve(__dirname, "apps/projects/ui/index.html"),
        // Design Mode is disabled and ships no bundle unless
        // `VEISTRA_DESIGN_MODE=1` — the twin of the `design-mode` Cargo feature.
        ...(DESIGN_MODE ? { design: resolve(__dirname, "apps/design/ui/index.html") } : {}),
        // Schematify is disabled (ORC-SCO-001) and ships no bundle unless
        // `VEISTRA_SCHEMATIFY=1` — the twin of the `schematify` Cargo feature.
        ...(SCHEMATIFY ? { schematify: resolve(__dirname, "apps/schematify/ui/index.html") } : {}),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available — but
  //    only Tauri does. An agent's server is free to move, and must be, since
  //    several can be up at once. See the note above.
  server: {
    port: mode === "agent" ? AGENT_PORT : TAURI_PORT,
    strictPort: mode !== "agent",
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore the Rust side
      //
      // `target/**` is not optional on Windows. Cargo holds an exclusive lock
      // on the DLL it is linking, and a watch against a locked file fails
      // outright with EBUSY rather than degrading — which kills the whole dev
      // server mid-compile. This used to be covered by the `src-tauri` entry
      // alone, because build output lived at `src-tauri/target/`; it moved to
      // the workspace root when this repo became a Cargo workspace, and the
      // ignore rule has to follow it.
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
}));
