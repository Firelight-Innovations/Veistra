// @vitest-environment jsdom
import { act as actHook, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@veistra/bridge", () => ({ invoke: bridge.invoke }));

import {
  act,
  askText,
  sendAsk,
  useEditorEvents,
  type AskEvent,
  type EditorEvent,
  type EventActions,
} from "./editorEvents";

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);

const ASK: AskEvent = {
  seq: 1,
  n: 1730000000001,
  t: 1730000000001,
  kind: "ask",
  text: "Why does Enemy_02 float?",
  scene: "res://levels/hallway.tscn",
  nodes: ["Hallway/Enemy_02"],
  camera: { pos: [1, 2, 3], target: [0, 0, 0], fov: 75 },
  pngBase64: "iVBORw0KGgo=",
  pngProblem: null,
};

const ACTIONS: EventActions = {
  tool: "godot",
  where: () => "res://levels/hallway.tscn",
  markup: () => Promise.resolve("Mark up is open in Veistra."),
};

let item = 0;
beforeEach(() => {
  item = 0;
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "context/put") return Promise.resolve({ id: `ctx-${++item}` });
    return Promise.resolve({});
  });
});

describe("Ask the agent", () => {
  // Done when: the text, the node path and a viewport image in one message.
  it("puts the question and the picture, then types both at the prompt in one insert", async () => {
    expect(await sendAsk("godot", ASK, "res://levels/hallway.tscn")).toBe("Sent to the agent.");
    const [text, image] = calls("context/put").map((c) => c[1] as Record<string, string>);
    expect(text?.kind).toBe("text");
    expect(text?.text).toContain("Why does Enemy_02 float?");
    expect(text?.text).toContain("Selected nodes: Hallway/Enemy_02");
    expect(text?.text).toContain("Scene: res://levels/hallway.tscn");
    expect(image?.kind).toBe("image");
    expect(image?.bytesBase64).toBe(ASK.pngBase64);
    expect(calls("context/insert")).toEqual([["context/insert", { itemIds: ["ctx-1", "ctx-2"] }]]);
    // Veistra never presses Enter for the person (X8).
    const methods = bridge.invoke.mock.calls.map((c) => c[0] as string);
    expect(methods.filter((m) => /enter|submit|send-keys|terminal\/write/i.test(m))).toEqual([]);
  });

  it("keeps each question apart, so a second does not replace the first", async () => {
    await sendAsk("godot", ASK, null);
    await sendAsk("godot", { ...ASK, seq: 2, n: ASK.n + 1 }, null);
    const keys = calls("context/put").map((c) => (c[1] as { key: string }).key);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe(`godot/levels/hallway.tscn/ask-${ASK.n}`);
  });

  it("says when no picture came, and sends the question alone", async () => {
    const bare = { ...ASK, pngBase64: null, pngProblem: "the editor sent no picture" };
    expect(askText("godot", bare, null)).toContain(
      "No picture of the viewport came with it: the editor sent no picture.",
    );
    await sendAsk("godot", bare, null);
    expect(calls("context/put")).toHaveLength(1);
    expect(calls("context/insert")[0]?.[1]).toEqual({ itemIds: ["ctx-1"] });
  });

  it("names Blender's objects and file in Blender's words", () => {
    const text = askText("blender", { ...ASK, nodes: ["Frame"] }, "props/bed.blend");
    expect(text).toContain("Blender's Veistra tab");
    expect(text).toContain("File: props/bed.blend");
    expect(text).toContain("Selected objects: Frame");
  });

  it("with no prompt to type at, says the question is in the Context strip", async () => {
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "context/put") return Promise.resolve({ id: "x" });
      if (method === "context/insert") return Promise.reject(new Error("no agent terminal"));
      return Promise.resolve({});
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendAsk("godot", ASK, null)).toMatch(/Context strip/);
  });
});

describe("a verdict from the editor", () => {
  it("is the card's verdict, expecting the note to be fixed still", async () => {
    const e: EditorEvent = {
      seq: 3,
      n: 9,
      t: 9,
      kind: "verdict",
      id: "0190000000aa-0001",
      verdict: "broken",
      reply: "still floats",
    };
    expect(await act(e, ACTIONS)).toBe("Reopened for the agent.");
    expect(calls("comments/verdict")[0]?.[1]).toEqual({
      id: "0190000000aa-0001",
      verdict: "broken",
      reply: "still floats",
      expect: "fixed",
    });
  });
});

describe("useEditorEvents", () => {
  it("takes each event once, in order, and answers each, a refusal too", async () => {
    const ack = vi.fn(() => Promise.resolve());
    const markup = vi.fn(() => Promise.reject(new Error("the plugin is not running")));
    const { result } = renderHook(() => useEditorEvents({ ...ACTIONS, markup }, ack));
    const events: EditorEvent[] = [ASK, { seq: 2, n: 5, t: 5, kind: "markup" }];
    actHook(() => result.current.take(events));
    // The same events again, as the next poll would hand them on before the
    // answers land: nothing is done twice.
    actHook(() => result.current.take(events));
    await waitFor(() => expect(ack).toHaveBeenCalledTimes(2));
    expect(ack.mock.calls).toEqual([
      [ASK.n, true, "Sent to the agent."],
      [5, false, "the plugin is not running"],
    ]);
    expect(result.current.since.current).toBe(2);
    expect(calls("context/insert")).toHaveLength(1);
  });
});
