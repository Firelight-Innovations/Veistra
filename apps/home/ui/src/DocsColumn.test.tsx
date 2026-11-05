// @vitest-environment jsdom
/**
 * Home's Docs column against a stubbed bridge: cards from `home/docs` open the
 * Docs pane on the page they name, and an unreachable site says where the docs
 * are instead of drawing nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
  return { invoke: vi.fn(), openIn: vi.fn(() => Promise.resolve()), VeistraRpcError };
});

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  VeistraRpcError: bridge.VeistraRpcError,
  reportPainted: vi.fn(),
  openIn: bridge.openIn,
  on: vi.fn(() => () => {}),
}));

import App from "./App";

const HOME = "https://veistra.com/docs";

/** Home with accounts not set up, so no sign-in screen stands in front of it. */
function host(docs: () => Promise<unknown>) {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "account/status")
      return Promise.resolve({
        configured: false,
        user: null,
        waiting: null,
        outcome: null,
        ownSignIn: false,
      });
    if (method === "home/state") return Promise.resolve({ open: null, recents: [] });
    if (method === "home/docs") return docs();
    return Promise.reject(new Error(`unexpected ${method}`));
  });
}

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  bridge.openIn.mockClear();
});

describe("Home's Docs column", () => {
  it("opens the Docs pane on the page a card names, and on the overview from the footer", async () => {
    host(() =>
      Promise.resolve({
        home: HOME,
        status: "live",
        detail: null,
        cards: [
          {
            path: "get-started/install",
            title: "Install",
            description: "Download and run the installer.",
            url: `${HOME}/get-started/install`,
          },
        ],
        total: 6,
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByText("Download and run the installer."));
    expect(bridge.openIn).toHaveBeenCalledWith("docs", { page: "get-started/install" });
    fireEvent.click(screen.getByText("All 6 pages"));
    expect(bridge.openIn).toHaveBeenLastCalledWith("docs");
  });

  it("says where the docs are when the site cannot be reached", async () => {
    host(() =>
      Promise.resolve({ home: HOME, status: "offline", detail: "timed out", cards: [], total: 0 }),
    );
    render(<App />);
    expect(await screen.findByText(/Can’t reach the docs right now/)).toBeTruthy();
    expect(screen.getByText("veistra.com/docs")).toBeTruthy();
    fireEvent.click(screen.getByText("Open the docs"));
    expect(bridge.openIn).toHaveBeenCalledWith("docs");
  });

  it("says the same when the call itself fails", async () => {
    host(() => Promise.reject(new Error("no backend")));
    render(<App />);
    expect(await screen.findByText(/Can’t reach the docs right now/)).toBeTruthy();
    expect(screen.getByText("veistra.com/docs")).toBeTruthy();
  });
});
