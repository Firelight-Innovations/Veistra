// @vitest-environment jsdom
/**
 * The markup session both viewers use: keep what was drawn, send it at once only
 * when the setting says so, offer the automatic setting once after a manual
 * send, and bring an earlier markup of the same subject back.
 */
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@veistra/bridge", () => ({ invoke }));

import { BLENDER_TARGET } from "./markupFlow";
import { useMarkup } from "./useMarkup";

const drawn = {
  version: 1,
  source: { kind: "scene" },
  size: { width: 10, height: 10 },
  pins: [{ n: 1, note: "x" }],
  annotations: [],
  excalidraw: { elements: [], appState: { viewBackgroundColor: "transparent" } },
};
const exported = { png: new Blob([new Uint8Array([65, 66, 67])]), json: drawn };

function settings(values: Record<string, unknown> = {}) {
  const groups = [
    {
      settings: [
        { key: "markup.autoSend", control: { default: false } },
        { key: "markup.tip", control: { default: true } },
      ],
    },
  ];
  invoke.mockImplementation((method: string) => {
    if (method === "settings/all") return Promise.resolve({ groups, values });
    if (method === "context/put") return Promise.resolve({ id: "ctx" });
    return Promise.resolve({});
  });
}

const calls = (method: string) => invoke.mock.calls.filter((c) => c[0] === method);

function mount(extra: Partial<Parameters<typeof useMarkup>[0]> = {}) {
  const save = vi.fn().mockResolvedValue({});
  const send = vi.fn(async (_id: string, _what: string, put: () => Promise<unknown>) => {
    await put();
  });
  const onProblem = vi.fn();
  const hook = renderHook(() =>
    useMarkup({
      target: BLENDER_TARGET,
      subject: "bed.blend",
      enabled: true,
      load: () => Promise.resolve(null),
      save,
      send,
      onProblem,
      describeError: String,
      ...extra,
    }),
  );
  return { ...hook, save, send, onProblem };
}

beforeEach(() => {
  invoke.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("useMarkup", () => {
  it("keeps a drawing and does not send it while auto-send is off", async () => {
    settings();
    const { result, save, send } = mount();
    act(() => result.current.onMarkup(exported as never));
    expect(result.current.markup?.fresh).toBe(true);
    expect(save).toHaveBeenCalledWith("bed.blend", exported.png, drawn);
    await waitFor(() => expect(calls("settings/all")).toHaveLength(1));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends at once, as Blender, when auto-send is on", async () => {
    settings({ "markup.autoSend": true });
    const { result, send } = mount();
    act(() => result.current.onMarkup(exported as never));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Both items stored, the picture last, for `send` to chip (useSendAction); nothing typed here.
    await waitFor(() => expect(calls("context/put")).toHaveLength(2));
    expect(calls("context/insert")).toHaveLength(0);
    expect(calls("context/put")[1]![1]).toMatchObject({ key: "blender/bed.blend/markup" });
  });

  it("still keeps the drawing, and says so, when it cannot be saved", async () => {
    settings();
    const { result, onProblem } = mount({ save: () => Promise.reject(new Error("disk full")) });
    act(() => result.current.onMarkup(exported as never));
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith(expect.stringMatching(/disk full/)));
    expect(result.current.markup).not.toBeNull();
  });

  it("offers the automatic setting once, after the first manual send only", async () => {
    settings();
    const { result } = mount();
    act(() => result.current.onMarkup(exported as never));
    await act(() => result.current.sendKept());
    expect(result.current.tip).toBe(true);
    act(() => result.current.closeTip());
    await act(() => result.current.sendKept());
    expect(result.current.tip).toBe(false);
  });

  it("does not offer it when the person said not to", async () => {
    settings({ "markup.tip": false });
    const { result } = mount();
    act(() => result.current.onMarkup(exported as never));
    await act(() => result.current.sendKept());
    expect(result.current.tip).toBe(false);
  });

  it("writes the setting through settings/set", async () => {
    settings();
    const { result } = mount();
    act(() => result.current.flip("markup.autoSend", true));
    expect(invoke).toHaveBeenCalledWith("settings/set", { key: "markup.autoSend", value: true });
  });

  it("brings back the earlier markup of the subject as not fresh", async () => {
    settings();
    const load = vi.fn().mockResolvedValue({
      png: "QUJD",
      json: JSON.stringify(drawn),
      savedAt: 5,
    });
    const { result } = mount({ load });
    await waitFor(() => expect(result.current.markup?.fresh).toBe(false));
    expect(load).toHaveBeenCalledWith("bed.blend");
    expect(result.current.markup?.savedAt).toBe(5);
  });

  it("keeps a drawing that lands before the effects of the render that showed its subject", async () => {
    settings();
    // A click can land between a commit and its passive effects, which is what a
    // loaded CI runner did. A layout effect of the commit that brings the subject
    // in runs in that gap every time, so the drawing arrives there.
    const load = vi.fn().mockResolvedValue(null);
    const save = vi.fn().mockResolvedValue({});
    const send = vi.fn();
    const onProblem = vi.fn();
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string | null }) => {
        const markup = useMarkup({
          target: BLENDER_TARGET,
          subject,
          enabled: subject !== null,
          load,
          save,
          send,
          onProblem,
          describeError: String,
        });
        const { onMarkup } = markup;
        useLayoutEffect(() => {
          if (subject) onMarkup(exported as never);
        }, [subject, onMarkup]);
        return markup;
      },
      { initialProps: { subject: null as string | null } },
    );
    rerender({ subject: "bed.blend" });
    await waitFor(() => expect(load).toHaveBeenCalledWith("bed.blend"));
    await act(() => Promise.resolve());
    expect(save).toHaveBeenCalledWith("bed.blend", exported.png, drawn);
    expect(result.current.markup?.fresh).toBe(true);
  });

  it("shows no markup of the last subject once another is chosen", async () => {
    settings();
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string }) =>
        useMarkup({
          target: BLENDER_TARGET,
          subject,
          enabled: true,
          load: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          send: vi.fn(),
          onProblem: vi.fn(),
          describeError: String,
        }),
      { initialProps: { subject: "bed.blend" } },
    );
    act(() => result.current.onMarkup(exported as never));
    expect(result.current.markup).not.toBeNull();
    rerender({ subject: "chair.blend" });
    expect(result.current.markup).toBeNull();
  });

  it("ignores a kept file that is not a markup, and loads nothing when disabled", async () => {
    settings();
    const bad = vi.fn().mockResolvedValue({ png: "QUJD", json: '{"nope":1}', savedAt: 1 });
    const a = mount({ load: bad });
    await waitFor(() => expect(bad).toHaveBeenCalled());
    expect(a.result.current.markup).toBeNull();

    const never = vi.fn();
    mount({ load: never, enabled: false });
    expect(never).not.toHaveBeenCalled();
  });
});
