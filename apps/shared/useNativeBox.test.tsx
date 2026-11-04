// @vitest-environment jsdom
/**
 * The box a pane places a native window over, as Play uses it today and the
 * Godot editor and Blender will (#316, #317): one report a frame and only on
 * change, hidden while covered with the window's last frame in its place,
 * hidden on unmount, and the shell's two pushes read safely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";

const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@veistra/bridge", () => ({
  on: (event: string, cb: (payload: unknown) => void) => {
    events.set(event, cb);
    return () => events.delete(event);
  },
}));

import type { WindowRect } from "./nativeBox";
import { useNativeBox, useShellPlacement, type NativeBoxOptions } from "./useNativeBox";

const FRAME: WindowRect = { x: 100, y: 40, width: 800, height: 600, window: "main" };
const BOX = { left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380 } as DOMRect;
const realRect = Element.prototype.getBoundingClientRect;

function Box(props: NativeBoxOptions) {
  const box = useNativeBox(props);
  return (
    <div className="box" ref={box.ref}>
      {box.covered && box.stillUrl && <img alt="last frame" src={box.stillUrl} />}
    </div>
  );
}

const options = (over: Partial<NativeBoxOptions> = {}): NativeBoxOptions => ({
  frameRect: FRAME,
  overlays: [],
  placed: true,
  report: vi.fn(() => Promise.resolve()),
  still: vi.fn(() => Promise.resolve({ png: "AAAA" })),
  ...over,
});

const reports = (o: NativeBoxOptions) => (o.report as ReturnType<typeof vi.fn>).mock.calls;
const lastReport = (o: NativeBoxOptions) => reports(o).slice(-1)[0];

beforeEach(() => {
  events.clear();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.classList.contains("box") ? BOX : realRect.call(this);
  };
  URL.createObjectURL = vi.fn(() => "blob:frame");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
});

describe("useNativeBox", () => {
  it("reports the box in window space once, and not again while nothing changes", async () => {
    const o = options();
    const { rerender } = render(<Box {...o} />);
    await waitFor(() => expect(reports(o)).toHaveLength(1));
    expect(lastReport(o)).toEqual([
      { x: 110, y: 60, w: 640, h: 360 },
      true,
      "main",
      window.devicePixelRatio,
    ]);
    rerender(<Box {...o} />);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(reports(o)).toHaveLength(1);
  });

  it("follows the shell's report of the frame moving", async () => {
    const o = options();
    const { rerender } = render(<Box {...o} />);
    await waitFor(() => expect(reports(o)).toHaveLength(1));
    rerender(<Box {...o} frameRect={{ ...FRAME, x: 300, window: "win-2" }} />);
    await waitFor(() => expect(reports(o)).toHaveLength(2));
    expect(lastReport(o).slice(0, 3)).toEqual([{ x: 310, y: 60, w: 640, h: 360 }, true, "win-2"]);
  });

  it("sends nothing before the shell says where the frame is", async () => {
    const o = options({ frameRect: null });
    render(<Box {...o} />);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(reports(o)).toHaveLength(0);
  });

  it("hides the window under an overlay over the box and shows its last frame there", async () => {
    const o = options();
    const { rerender } = render(<Box {...o} />);
    await waitFor(() => expect(reports(o)).toHaveLength(1));
    rerender(<Box {...o} overlays={[{ x: 0, y: 0, width: 200, height: 200 }]} />);
    await waitFor(() => expect(lastReport(o)[1]).toBe(false));
    expect(await screen.findByRole("img", { name: "last frame" })).toBeTruthy();
    expect(o.still).toHaveBeenCalledTimes(1);
    rerender(<Box {...o} overlays={[]} />);
    await waitFor(() => expect(lastReport(o)[1]).toBe(true));
    expect(screen.queryByRole("img", { name: "last frame" })).toBeNull();
  });

  it("keeps the window shown for an overlay across the window from the box", async () => {
    const o = options({ overlays: [{ x: 900, y: 0, width: 100, height: 100 }] });
    render(<Box {...o} />);
    await waitFor(() => expect(reports(o)).toHaveLength(1));
    expect(lastReport(o)[1]).toBe(true);
    expect(o.still).not.toHaveBeenCalled();
  });

  it("treats something of the pane's own over the box as a cover", async () => {
    const o = options({ coveredHere: true });
    render(<Box {...o} />);
    await waitFor(() => expect(reports(o)).toHaveLength(1));
    expect(lastReport(o)[1]).toBe(false);
    await waitFor(() => expect(o.still).toHaveBeenCalledTimes(1));
  });

  it("asks for no still while the pane draws in the box itself, or nothing is placed", async () => {
    const drawing = options({ hidden: true, coveredHere: true });
    render(<Box {...drawing} />);
    await waitFor(() => expect(reports(drawing)).toHaveLength(1));
    expect(lastReport(drawing)[1]).toBe(false);
    cleanup();
    const notPlaced = options({ placed: false, coveredHere: true });
    render(<Box {...notPlaced} />);
    await waitFor(() => expect(reports(notPlaced)).toHaveLength(1));
    expect(drawing.still).not.toHaveBeenCalled();
    expect(notPlaced.still).not.toHaveBeenCalled();
  });

  // A restart is a new window: the old run's last frame must not stand in for it.
  it("drops a still of an earlier window once the generation changes", async () => {
    const o = options({ coveredHere: true, generation: 1 });
    const { rerender } = render(<Box {...o} />);
    expect(await screen.findByRole("img", { name: "last frame" })).toBeTruthy();
    let answer: (v: { png: string }) => void = () => undefined;
    const pending = vi.fn(() => new Promise<{ png: string }>((r) => (answer = r)));
    rerender(<Box {...o} generation={2} still={pending} />);
    await waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("img", { name: "last frame" })).toBeNull();
    await act(async () => answer({ png: "AAAA" }));
    expect(await screen.findByRole("img", { name: "last frame" })).toBeTruthy();
  });

  it("hides the window when the box unmounts, with the box it last had", async () => {
    const o = options();
    const { unmount } = render(<Box {...o} />);
    await waitFor(() => expect(reports(o)).toHaveLength(1));
    unmount();
    expect(reports(o)).toHaveLength(2);
    expect(lastReport(o).slice(0, 3)).toEqual([{ x: 110, y: 60, w: 640, h: 360 }, false, "main"]);
  });

  it("sends nothing on unmount for a window it never showed", async () => {
    const o = options({ coveredHere: true });
    const { unmount } = render(<Box {...o} />);
    await waitFor(() => expect(reports(o)).toHaveLength(1));
    unmount();
    expect(reports(o)).toHaveLength(1);
  });
});

describe("useShellPlacement", () => {
  it("keeps the shell's frame rect and overlays, and ignores what is malformed", () => {
    const { result } = renderHook(() => useShellPlacement());
    expect(result.current).toEqual({ frameRect: null, overlays: [] });
    act(() => events.get("veistra/window-rect")?.({ x: 1, y: 2, width: 3, height: 4 }));
    act(() => events.get("veistra/window-rect")?.({ x: "bad" }));
    act(() =>
      events.get("veistra/overlays")?.({ rects: [{ x: 0, y: 0, width: 5, height: 5 }, 7] }),
    );
    expect(result.current.frameRect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(result.current.overlays).toEqual([{ x: 0, y: 0, width: 5, height: 5 }]);
  });

  it("stops listening when it unmounts", () => {
    const { unmount } = renderHook(() => useShellPlacement());
    expect(events.size).toBe(2);
    unmount();
    expect(events.size).toBe(0);
  });
});
