// @vitest-environment jsdom
/** The File Viewer's send buttons, in the shared footer, still reach `context/put`. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@veistra/bridge", () => ({ invoke: bridge.invoke }));

import SendToAgent from "./SendToAgent";
import { SendFooter } from "../../../shared/SendFooter";

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const footer = (props: { dirty?: boolean; onError?: (m: string | null) => void }) =>
  render(
    <SendFooter>
      <SendToAgent
        path="C:/p/a.ts"
        rootPath="C:/p"
        dirty={props.dirty ?? false}
        missing={false}
        onError={props.onError ?? vi.fn()}
      />
    </SendFooter>,
  );

describe("File Viewer send footer", () => {
  it("sends the file as one chip, and says Sent", async () => {
    bridge.invoke.mockImplementation((method: string) =>
      Promise.resolve(
        method === "context/put"
          ? { id: "ctx", source: { label: "File - a.ts" } }
          : { delivered: 1 },
      ),
    );
    footer({});
    fireEvent.click(screen.getByRole("button", { name: "Send file" }));
    await screen.findByRole("button", { name: "Sent" });
    expect(bridge.invoke).toHaveBeenCalledWith(
      "context/put",
      expect.objectContaining({ prompt: expect.stringContaining("a.ts") }),
    );
    expect(bridge.invoke).toHaveBeenCalledWith("veistra/attach-to-agent", {
      contextId: "ctx",
      label: "File - a.ts",
    });
  });

  it("says the file is in the Context strip when no agent takes it", async () => {
    const onError = vi.fn();
    bridge.invoke.mockImplementation((method: string) =>
      Promise.resolve(
        method === "context/put"
          ? { id: "ctx" }
          : method === "context/insert"
            ? { inserted: false, reason: "no agent is running here" }
            : { delivered: 0 },
      ),
    );
    footer({ onError });
    fireEvent.click(screen.getByRole("button", { name: "Send file" }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "a.ts is in the Context strip, but no agent took it: no agent is running here.",
      ),
    );
  });

  it("refuses to send a file with unsaved changes", () => {
    const onError = vi.fn();
    footer({ dirty: true, onError });
    fireEvent.click(screen.getByRole("button", { name: "Send file" }));
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("unsaved changes"));
  });

  it("has no Send selection button without a selection", () => {
    footer({});
    expect(screen.queryByRole("button", { name: "Send selection" })).toBeNull();
  });
});
