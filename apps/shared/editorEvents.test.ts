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
  type MentionEvent,
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
    if (method === "context/put") {
      item += 1;
      return Promise.resolve({ id: `ctx-${item}`, path: `C:/env/ctx-${item}.png` });
    }
    if (method === "veistra/attach-to-agent") return Promise.resolve({ delivered: 1 });
    return Promise.resolve({});
  });
});

const chips = () =>
  calls("veistra/attach-to-agent").map((c) => (c[1] as { contextId: string }).contextId);

describe("Ask the agent", () => {
  // Done when: the text, the node path and a viewport image in one message.
  it("puts the picture and the question, then leaves one chip, the question's, and types nothing", async () => {
    expect(await sendAsk("godot", ASK, "res://levels/hallway.tscn")).toBe("Sent to the agent.");
    const [image, text] = calls("context/put").map((c) => c[1] as Record<string, string>);
    expect(text?.kind).toBe("text");
    expect(text?.text).toContain("Why does Enemy_02 float?");
    expect(text?.text).toContain("Selected nodes: Hallway/Enemy_02");
    expect(text?.text).toContain("Scene: res://levels/hallway.tscn");
    expect(image?.kind).toBe("image");
    expect(image?.bytesBase64).toBe(ASK.pngBase64);
    // What to do with them rides in each chip, out of sight; nothing is typed.
    expect(text?.prompt).toMatch(/Answer the question/);
    expect(image?.prompt).toMatch(/viewport/);
    // The one chip's hidden prompt names the picture, so the agent opens it.
    expect(text?.prompt).toContain("The viewport when I asked is at C:/env/ctx-1.png; open it.");
    expect(chips()).toEqual(["ctx-2"]);
    expect(calls("context/insert")).toEqual([]);
    // Veistra never presses Enter for the person (X8).
    const methods = bridge.invoke.mock.calls.map((c) => c[0] as string);
    expect(methods.filter((m) => /enter|submit|send-keys|terminal\/write/i.test(m))).toEqual([]);
  });

  it("keeps each question apart, so a second does not replace the first", async () => {
    await sendAsk("godot", ASK, null);
    await sendAsk("godot", { ...ASK, seq: 2, n: ASK.n + 1 }, null);
    const keys = calls("context/put").map((c) => (c[1] as { key: string }).key);
    expect(new Set(keys).size).toBe(4);
    expect(keys[1]).toBe(`godot/levels/hallway.tscn/ask-${ASK.n}`);
  });

  it("says when no picture came, and sends the question alone", async () => {
    const bare = { ...ASK, pngBase64: null, pngProblem: "the editor sent no picture" };
    expect(askText("godot", bare, null)).toContain(
      "No picture of the viewport came with it: the editor sent no picture.",
    );
    await sendAsk("godot", bare, null);
    expect(calls("context/put")).toHaveLength(1);
    expect(chips()).toEqual(["ctx-1"]);
  });

  it("names Blender's objects and file in Blender's words", () => {
    const text = askText("blender", { ...ASK, nodes: ["Frame"] }, "props/bed.blend");
    expect(text).toContain("Blender's Veistra tab");
    expect(text).toContain("File: props/bed.blend");
    expect(text).toContain("Selected objects: Frame");
  });

  it("with no agent to take it, says the question is in the Context strip", async () => {
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "context/put") return Promise.resolve({ id: "x" });
      if (method === "veistra/attach-to-agent") return Promise.resolve({ delivered: 0 });
      if (method === "context/insert")
        return Promise.resolve({ inserted: false, reason: "no agent is running here" });
      return Promise.resolve({});
    });
    expect(await sendAsk("godot", ASK, null)).toBe(
      "The question is in Veistra's Context strip, but no agent took it: no agent is running here.",
    );
  });

  it("with the call refused outright, still says the question is in the Context strip", async () => {
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "context/put") return Promise.resolve({ id: "x" });
      return Promise.reject(new Error("no agent terminal"));
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
    expect(chips()).toEqual(["ctx-2"]);
  });
});

const MENTION: MentionEvent = {
  seq: 4,
  n: 12,
  t: 12,
  kind: "mention",
  what: "selection",
  scene: "C:/env/props/crate.blend",
  nodes: ["Crate"],
  path: null,
  pngBase64: null,
  pngProblem: null,
};

describe("Mention in agent", () => {
  it("makes one chip of what the editor names, with nothing typed", async () => {
    const place = () => ({
      root: null,
      file: "props/crate.blend",
      node: () => ({ type: "MESH" }),
    });
    expect(await act(MENTION, { ...ACTIONS, tool: "blender", place })).toBe(
      "In the agent's prompt.",
    );
    const [put] = calls("context/put").map((c) => c[1] as Record<string, string>);
    expect(put?.kind).toBe("json");
    expect(put?.label).toBe("Blender · Crate");
    expect(JSON.parse(put!.text!)).toMatchObject({
      tool: "blender",
      scene: "props/crate.blend",
      nodes: [{ path: "Crate", type: "MESH" }],
    });
    expect(chips()).toEqual(["ctx-1"]);
    expect(calls("context/insert")).toEqual([]);
  });

  // The cause of Blender's Mention adding no chip: its pane gave no `place`,
  // so every mention was refused before anything was put.
  it("is refused, and says so to the editor, by a pane that gives no place", async () => {
    await expect(act(MENTION, { ...ACTIONS, tool: "blender" })).rejects.toThrow(
      "This pane cannot mention things yet.",
    );
    expect(chips()).toEqual([]);
  });
});
