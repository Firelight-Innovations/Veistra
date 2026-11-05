/**
 * What crosses the bridge, mirroring `src-tauri/src/apps/docs.rs`.
 *
 * Declared here rather than imported from the orchestrator's `src/bindings.ts`,
 * for the reason every app declares its own: an app's only coupling to its host
 * is `@veistra/bridge` and the shape of what crosses it.
 */
import { VeistraRpcError, invoke } from "@veistra/bridge";

/** How an answer was come by. `stale` is a copy from earlier this session. */
export type Status = "live" | "stale" | "offline" | "missing";

export interface Page {
  /** Below `/docs/`, without `.md`: `get-started/install`. */
  path: string;
  title: string;
  description: string;
  /** The page on the website. */
  url: string;
}

export interface Section {
  title: string;
  pages: Page[];
}

export interface DocsIndex {
  /** `https://veistra.com/docs`, or wherever `account.webUrl` points. */
  home: string;
  status: Status;
  detail: string | null;
  title: string;
  summary: string;
  sections: Section[];
}

export interface DocPage {
  path: string;
  url: string;
  status: Status;
  detail: string | null;
  markdown: string | null;
}

/** Where the docs live when the backend could not even say. */
export const FALLBACK_HOME = "https://veistra.com/docs";

export const readIndex = () => invoke<DocsIndex>("docs/index");

export const readPage = (path: string) => invoke<DocPage>("docs/page", { path });

/** A page by `path`, the docs home with neither, or a link out by `url`. */
export const openInBrowser = (target: { path?: string; url?: string } = {}) =>
  invoke<null>("docs/open", target);

/** A failure as one line, with the JSON-RPC code when there is one. */
export function describe(error: unknown): string {
  if (error instanceof VeistraRpcError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
