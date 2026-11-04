/**
 * Which Tauri listener each Rust push is heard on. The choice is the whole
 * contract for these two: Rust's usage events are sent to `main` alone and must
 * be heard there once, and Tauri delivers an event sent to any one window to
 * every global `listen`, so a global listener would count it in every window.
 * A comment change is broadcast, and every window's shell must hear it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  globalListen: vi.fn(),
  windowListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.globalListen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: tauri.windowListen }),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ label: "main" }) }));

import {
  BACKEND_USAGE_EVENT,
  COMMENTS_CHANGED_EVENT,
  onBackendUsage,
  onCommentsChanged,
} from "./bindings";

type Handler = (e: { payload: unknown }) => void;

beforeEach(() => {
  tauri.globalListen.mockReset().mockResolvedValue(() => {});
  tauri.windowListen.mockReset().mockResolvedValue(() => {});
});

describe("Rust pushes", () => {
  it("hears Rust's usage events on this window only, never with a global listen", async () => {
    const cb = vi.fn();
    await onBackendUsage(cb);
    expect(tauri.globalListen).not.toHaveBeenCalled();
    expect(tauri.windowListen).toHaveBeenCalledWith(BACKEND_USAGE_EVENT, expect.any(Function));

    const handler = tauri.windowListen.mock.calls[0][1] as Handler;
    handler({ payload: { feature: "godot", event: "note_fixed" } });
    expect(cb).toHaveBeenCalledWith({ feature: "godot", event: "note_fixed" });
  });

  it("hears a comment change with a global listen, so every window's shell relays it", async () => {
    const cb = vi.fn();
    await onCommentsChanged(cb);
    expect(tauri.windowListen).not.toHaveBeenCalled();
    expect(tauri.globalListen).toHaveBeenCalledWith(COMMENTS_CHANGED_EVENT, expect.any(Function));

    const handler = tauri.globalListen.mock.calls[0][1] as Handler;
    handler({ payload: { id: "a", status: "fixed" } });
    expect(cb).toHaveBeenCalledWith({ id: "a", status: "fixed" });
  });
});
