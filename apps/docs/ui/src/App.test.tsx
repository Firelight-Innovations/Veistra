// @vitest-environment jsdom
/**
 * The Docs pane against a stubbed bridge: the overview from the site's index,
 * a page and its links, and what is drawn when the site cannot be reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DocPage, DocsIndex } from "./rpc";

const bridge = vi.hoisted(() => {
  class VeistraRpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown,
    ) {
      super(message);
    }
  }
  const listeners = new Map<string, (payload: unknown) => void>();
  return { invoke: vi.fn(), VeistraRpcError, listeners };
});

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  VeistraRpcError: bridge.VeistraRpcError,
  OPENED_EVENT: "veistra:opened",
  reportPainted: vi.fn(),
  openIn: vi.fn(() => Promise.resolve()),
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    bridge.listeners.set(event, handler);
    return () => bridge.listeners.delete(event);
  }),
}));

import App from "./App";

const HOME = "https://veistra.com/docs";

const index: DocsIndex = {
  home: HOME,
  status: "live",
  detail: null,
  title: "Veistra",
  summary: "Context for coding agents.",
  sections: [
    {
      title: "Get started",
      pages: [
        {
          path: "get-started/install",
          title: "Install",
          description: "Download and run the installer.",
          url: `${HOME}/get-started/install`,
        },
        {
          path: "get-started/sign-in",
          title: "Sign in",
          description: "Connect your account.",
          url: `${HOME}/get-started/sign-in`,
        },
      ],
    },
  ],
};

function page(path: string, markdown: string | null, status: DocPage["status"] = "live"): DocPage {
  return { path, url: `${HOME}/${path}`, status, detail: null, markdown };
}

/** Answer `docs/index` and `docs/page` from `pages`, and record `docs/open`. */
function serve(pages: Record<string, DocPage>, docsIndex: DocsIndex = index) {
  bridge.invoke.mockImplementation((method: string, params?: { path?: string }) => {
    if (method === "docs/index") return Promise.resolve(docsIndex);
    if (method === "docs/page") {
      const found = pages[params?.path ?? ""];
      return Promise.resolve(found ?? page(params?.path ?? "", null, "missing"));
    }
    if (method === "docs/open") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected ${method}`));
  });
}

beforeEach(() => {
  // jsdom implements neither; the app calls both when it changes page.
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  bridge.listeners.clear();
});

describe("Docs", () => {
  it("draws the site's index as an overview and a contents rail", async () => {
    serve({});
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Veistra" })).toBeTruthy();
    expect(screen.getByText("Context for coding agents.")).toBeTruthy();
    expect(screen.getByText("Download and run the installer.")).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "Contents" });
    expect(rail.textContent).toContain("Sign in");
    expect(rail.textContent).toContain("veistra.com/docs ↗");
  });

  it("opens a page from its card and draws its Markdown", async () => {
    serve({ "get-started/install": page("get-started/install", "# Install\n\nRun it.") });
    render(<App />);
    fireEvent.click(await screen.findByText("Download and run the installer."));
    expect(await screen.findByText("Run it.")).toBeTruthy();
    expect(bridge.invoke).toHaveBeenCalledWith("docs/page", { path: "get-started/install" });
  });

  it("says it is offline, and where the docs are, when the site cannot be reached", async () => {
    serve({}, { ...index, status: "offline", detail: "connection refused", sections: [] });
    render(<App />);
    expect(await screen.findByText("Can’t reach the Veistra docs")).toBeTruthy();
    expect(screen.getByText(HOME)).toBeTruthy();
    expect(screen.getByText("connection refused")).toBeTruthy();
  });

  it("draws the offline notice when the backend itself fails", async () => {
    bridge.invoke.mockRejectedValue(new bridge.VeistraRpcError(-32603, "no backend"));
    render(<App />);
    expect(await screen.findByText("Can’t reach the Veistra docs")).toBeTruthy();
    expect(screen.getByText("[-32603] no backend")).toBeTruthy();
    expect(screen.getByText(HOME)).toBeTruthy();
  });

  it("asks again on Try again, and draws the overview once the site answers", async () => {
    serve({}, { ...index, status: "offline", detail: "timed out", sections: [] });
    render(<App />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    serve({});
    fireEvent.click(retry);
    expect(await screen.findByText("Download and run the installer.")).toBeTruthy();
    expect(bridge.invoke.mock.calls.filter(([m]) => m === "docs/index")).toHaveLength(2);
  });

  it("names the address of a page the site no longer has", async () => {
    serve({});
    render(<App />);
    await screen.findByText("Veistra");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("This page isn’t on the docs site")).toBeTruthy();
    expect(screen.getByText(`${HOME}/get-started/sign-in`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the overview" }));
    expect(await screen.findByText("Download and run the installer.")).toBeTruthy();
  });

  it("follows a link to another docs page in the pane", async () => {
    serve({
      "get-started/install": page("get-started/install", "Then [sign in](sign-in)."),
      "get-started/sign-in": page("get-started/sign-in", "Signed in here."),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("Download and run the installer."));
    fireEvent.click(await screen.findByText("sign in"));
    expect(await screen.findByText("Signed in here.")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("docs/open", expect.anything());
  });

  it("hands a link off the docs to the system browser", async () => {
    serve({
      "get-started/install": page("get-started/install", "See [GitHub](https://github.com/x)."),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("Download and run the installer."));
    fireEvent.click(await screen.findByText("GitHub"));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("docs/open", { url: "https://github.com/x" }),
    );
  });

  it("opens the page `veistra/open` names", async () => {
    serve({ "get-started/sign-in": page("get-started/sign-in", "Signed in here.") });
    render(<App />);
    await screen.findByText("Veistra");
    bridge.listeners.get("veistra:opened")?.({ page: "get-started/sign-in" });
    expect(await screen.findByText("Signed in here.")).toBeTruthy();
  });

  it("ignores a page name that is not a docs path", async () => {
    serve({});
    render(<App />);
    await screen.findByText("Veistra");
    bridge.listeners.get("veistra:opened")?.({ page: "../../etc/passwd" });
    expect(await screen.findByText("Download and run the installer.")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("docs/page", expect.anything());
  });

  it("marks a copy read earlier as stale and still draws it", async () => {
    serve({}, { ...index, status: "stale", detail: "offline" });
    render(<App />);
    expect(await screen.findByText(/Showing the copy read earlier/)).toBeTruthy();
    expect(screen.getByText("Download and run the installer.")).toBeTruthy();
  });
});
