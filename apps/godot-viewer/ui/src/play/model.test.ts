/**
 * Play's pure modules: the note model, telemetry in the page, the contact
 * sheet's times, shape and seeks, and the keys. The game box's geometry is `apps/shared/nativeBox.ts`'s.
 */
import { describe, expect, it, vi } from "vitest";
import type { Comment } from "../../../../shared/comments";
import { CONTACT_MAX, clock, contactLayout, contactTimes, seek } from "./frames";
import { liveAction, reviewAction } from "./keys";
import { newF8Marks } from "./markTelemetry";
import {
  addNote,
  dismissMark,
  emptyDoc,
  errorsNear,
  markSent,
  nearWords,
  NO_RANGE,
  noteStatus,
  normalize,
  packetMessage,
  parseLog,
  pendingMarks,
  removeNote,
  sendable,
  settledRange,
  updateNote,
  withIn,
  withOut,
} from "./notes";
import { frameSeries, nearestTick, parseTicks, recordedTarget, toViewport } from "./telemetry";

describe("notes", () => {
  it("number notes once and never reuse a number", () => {
    let { doc } = addNote(emptyDoc(), 41_000);
    ({ doc } = addNote(doc, 102_180, { inMs: 98_000, outMs: 106_000 }));
    expect(doc.notes.map((n) => [n.n, n.kind])).toEqual([
      [1, "frame"],
      [2, "range"],
    ]);
    doc = removeNote(doc, 2);
    const third = addNote(doc, 5_000).note;
    expect(third.n).toBe(3);
  });

  it("keep a sent note when asked to delete it, and send only drafts with words", () => {
    let { doc } = addNote(emptyDoc(), 1_000);
    ({ doc } = addNote(doc, 2_000));
    doc = updateNote(doc, 1, { body: "door", commentId: "c1" });
    doc = updateNote(doc, 2, { body: "  " });
    expect(sendable(doc)).toEqual([]);
    doc = updateNote(doc, 2, { body: "wall" });
    expect(sendable(doc).map((n) => n.n)).toEqual([2]);
    expect(removeNote(doc, 1).notes).toHaveLength(2);
  });

  it("stamp the notes Send filed and leave the rest, edits included, as they are", () => {
    let { doc } = addNote(emptyDoc(), 1_000);
    ({ doc } = addNote(doc, 2_000));
    doc = updateNote(doc, 1, { body: "door, typed while sending" });
    doc = updateNote(doc, 2, { body: "wall, written after Send began" });
    const sent = markSent(doc, [[1, "c1"]], ".veistra/feedback/t-1");
    expect(sent.notes[0]).toMatchObject({
      body: "door, typed while sending",
      commentId: "c1",
      packet: ".veistra/feedback/t-1",
    });
    expect(sent.notes[1].commentId).toBeUndefined();
    expect(sendable(sent).map((n) => n.n)).toEqual([2]);
  });

  it("leave one sentence around the packet for the agent, counted", () => {
    const say = (n: number) => {
      const { before, after } = packetMessage(n);
      return `${before}.veistra/feedback/t-1/packet.md${after}`;
    };
    expect(say(2)).toBe("Playtest feedback: 2 notes. Read .veistra/feedback/t-1/packet.md first.");
    expect(say(1)).toBe("Playtest feedback: 1 note. Read .veistra/feedback/t-1/packet.md first.");
  });

  it("read a notes.json leniently and keep numbers above what is there", () => {
    const doc = normalize({ notes: [{ n: 4, atMs: 0 }, { nope: true }], nextN: 2 });
    expect(doc.notes).toHaveLength(1);
    expect(doc.nextN).toBe(5);
    expect(normalize("junk")).toEqual(emptyDoc());
  });

  it("leave marks pending until made a note or dismissed", () => {
    let { doc } = addNote(emptyDoc(), 41_060, null, { fromMark: 41_060 });
    doc = dismissMark(doc, 72_010);
    expect(pendingMarks([41_060, 72_010, 104_400], doc)).toEqual([104_400]);
  });

  it("find errors near a note and report its comment's status", () => {
    const log = parseLog(
      [
        '{"t":1,"ms":71000,"level":"error","stream":"out","text":"ERROR: unreachable"}',
        '{"t":1,"ms":71500,"level":"info","stream":"out","text":"hello"}',
        "torn",
        '{"t":1,"ms":99000,"level":"warning","stream":"err","text":"WARNING: bus"}',
      ].join("\n"),
    );
    expect(log).toHaveLength(3);
    expect(errorsNear(log, 72_010, 72_010, 2_000).map((r) => r.text)).toEqual([
      "ERROR: unreachable",
    ]);
    const note = { ...addNote(emptyDoc(), 1).note, commentId: "c1" };
    const comment = { id: "c1", status: "fixed" } as Comment;
    expect(noteStatus(note, [comment])).toBe("fixed");
    expect(noteStatus({ ...note, commentId: undefined }, [comment])).toBe("draft");
  });
});

describe("the pending range", () => {
  it("keep the other end only while it is still on its own side", () => {
    let r = withIn(NO_RANGE, 5_000);
    expect(r).toEqual({ inMs: 5_000, outMs: null });
    expect(settledRange(r)).toBeNull();
    r = withOut(r, 9_000);
    expect(settledRange(r)).toEqual({ inMs: 5_000, outMs: 9_000 });
    // In moved past Out drops Out, and Out before In drops In.
    expect(withIn(r, 9_500)).toEqual({ inMs: 9_500, outMs: null });
    expect(withOut(r, 4_000)).toEqual({ inMs: null, outMs: 4_000 });
    expect(settledRange(withOut(withIn(NO_RANGE, 3_000), 3_000))).toBeNull();
  });
});

describe("the log near a note", () => {
  it("count errors and warnings in words, and say nothing for none", () => {
    const row = (level: "error" | "warning", ms: number) => ({
      t: ms,
      ms,
      level,
      stream: "",
      text: "x",
    });
    expect(nearWords([row("error", 1), row("warning", 2)])).toBe("1 error · 1 warning");
    expect(
      nearWords([row("error", 1), row("error", 2), row("warning", 3), row("warning", 4)]),
    ).toBe("2 errors · 2 warnings");
    expect(nearWords([row("warning", 1)])).toBe("1 warning");
    expect(nearWords([])).toBeNull();
  });
});

describe("telemetry", () => {
  const text = [
    '{"t":1000,"kind":"tick","scene":"res://a.tscn","frameMs":16,"viewport":[1280,720],"nodes":[{"path":"A/Big","type":"Node3D","rect":[0,0,1280,720]},{"path":"A/Enemy","type":"CharacterBody3D","rect":[900,200,250,400],"pos":[14.2,0,-6.8]}]}',
    '{"t":1100,"kind":"mark"}',
    '{"t":1200,"kind":"tick","scene":"res://a.tscn","frameMs":41,"nodes":[]}',
    '{"t":13',
  ].join("\n");

  it("parse ticks and skip events and torn lines", () => {
    const ticks = parseTicks(text);
    expect(ticks.map((t) => t.t)).toEqual([1000, 1200]);
    expect(frameSeries(ticks, 1000)).toEqual([
      { ms: 0, frameMs: 16 },
      { ms: 200, frameMs: 41 },
    ]);
  });

  it("find the nearest tick within the window", () => {
    const ticks = parseTicks(text);
    expect(nearestTick(ticks, 1150)?.t).toBe(1200);
    expect(nearestTick(ticks, 1040)?.t).toBe(1000);
    expect(nearestTick(ticks, 9000)).toBeNull();
    expect(nearestTick([], 0)).toBeNull();
  });

  it("pick the smallest tracked box under a pin, scaled from the shown frame", () => {
    const [tick] = parseTicks(text);
    // The frame is shown at half size; (500, 200) is (1000, 400) in the game.
    const hit = recordedTarget(tick, 500, 200, { width: 640, height: 360 });
    expect(hit).toEqual({
      nodePath: "A/Enemy",
      type: "CharacterBody3D",
      worldPoint: [14.2, 0, -6.8],
      source: "recorded",
    });
    expect(recordedTarget(tick, 10, 10, { width: 640, height: 360 })?.nodePath).toBe("A/Big");
    expect(recordedTarget(null, 0, 0, { width: 1, height: 1 })).toBeNull();
  });

  // Spec §13 test 5: a pin on the enemy names Enemy_02. Its mesh's box is
  // the smallest under the pin, but a person means the body, as a live pick
  // (which hits the collider) says.
  const hallway = (enemyBox: string) =>
    parseTicks(
      `{"t":1,"kind":"tick","scene":"res://levels/hallway.tscn","viewport":[1280,720],"nodes":[` +
        '{"path":"Hallway/Walls","type":"StaticBody3D","rect":[0,0,1280,720]},' +
        `{"path":"Hallway/Enemy_02","type":"CharacterBody3D","rect":${enemyBox},"pos":[14.2,0,-6.8]},` +
        '{"path":"Hallway/Enemy_02/Mesh","type":"MeshInstance3D","rect":[915,220,230,390],"pos":[14.2,1,-6.8]}]}',
    )[0];

  it("lift a pin on a mesh to the body it belongs to", () => {
    const tick = hallway("[905,210,250,410]");
    const full = { width: 1280, height: 720 };
    expect(recordedTarget(tick, 1000, 400, full)).toEqual({
      nodePath: "Hallway/Enemy_02",
      type: "CharacterBody3D",
      worldPoint: [14.2, 0, -6.8],
      source: "recorded",
    });
    // Off the enemy, the walls' body is the smallest box and is itself a body.
    expect(recordedTarget(tick, 100, 100, full)?.nodePath).toBe("Hallway/Walls");
  });

  it("keep the mesh when the body's box does not hold the pin, or nothing above it is a body", () => {
    // A body box that has fallen behind its mesh (a tick apart) is not lifted to.
    const behind = hallway("[600,210,250,410]");
    const full = { width: 1280, height: 720 };
    expect(recordedTarget(behind, 1000, 400, full)?.nodePath).toBe("Hallway/Enemy_02/Mesh");
    // A mesh tracked through `veistra_track` with no body above it.
    const [lamp] = parseTicks(
      '{"t":1,"kind":"tick","scene":"","viewport":[1280,720],"nodes":[{"path":"Hallway/Lamp","type":"Node3D","rect":[0,0,400,400]},{"path":"Hallway/Lamp/Bulb","type":"MeshInstance3D","rect":[100,100,50,50]}]}',
    );
    expect(recordedTarget(lamp, 120, 120, full)?.nodePath).toBe("Hallway/Lamp/Bulb");
  });

  // Base 640x360 under stretch aspect "keep" in a 1000x700 window: Godot
  // draws the viewport 1000x562 with 69 px bars above and below it.
  const letterboxed = (fields: string) =>
    parseTicks(
      `{"t":1,"kind":"tick","scene":"","viewport":[640,360]${fields},"nodes":[{"path":"L/Lamp","type":"MeshInstance3D","rect":[300,10,40,20]},{"path":"L/Room","type":"MeshInstance3D","rect":[0,0,640,360]}]}`,
    )[0];

  it("map a pin through the box the recorded window shows the viewport in", () => {
    const tick = letterboxed(',"window":[1000,700],"content":[0,69,1000,562]');
    const shown = { width: 500, height: 350 };
    // (250, 50) is window (500, 100), which is viewport y 20: on the lamp.
    expect(recordedTarget(tick, 250, 50, shown)?.nodePath).toBe("L/Lamp");
    // (250, 20) is on the top bar, so on nothing, though the room fills the viewport.
    expect(recordedTarget(tick, 250, 20, shown)).toBeNull();
    // The same base in a 1400x600 window has bars at the sides instead.
    const wide = letterboxed(',"window":[1400,600],"content":[167,0,1066,600]');
    expect(toViewport(wide, 700, 300, { width: 1400, height: 600 })).toEqual([320, 180]);
  });

  it("stretch both ways when the window says the viewport fills it, as fractional aspect ignore does", () => {
    const tick = letterboxed(',"window":[1000,700],"content":[0,0,1000,700]');
    const [, py] = toViewport(tick, 500, 100, { width: 1000, height: 700 });
    expect(py).toBeCloseTo((100 / 700) * 360);
  });

  // Integer stretch draws the base at a whole-number scale, so the same base
  // in the same window is drawn at 1x with bars on all four sides, under
  // aspect ignore as much as keep, and at any content scale factor.
  it("map a pin through bars on both axes, as integer stretch leaves", () => {
    const tick = letterboxed(',"window":[1000,700],"content":[180,170,640,360]');
    expect(toViewport(tick, 200, 200, { width: 1000, height: 700 })).toEqual([20, 30]);
    // Shown at half size, the same pin lands on the same viewport point.
    const half = { width: 500, height: 350 };
    expect(toViewport(tick, 100, 100, half)).toEqual([20, 30]);
    expect(recordedTarget(tick, 100, 100, half)?.nodePath).toBe("L/Room");
    // Window (100, 350) is on the left bar and (500, 100) on the top one,
    // though the room fills the viewport.
    expect(recordedTarget(tick, 50, 175, half)).toBeNull();
    expect(recordedTarget(tick, 250, 50, half)).toBeNull();
  });

  it("map a pin through a box larger than the window, drawn from its edge", () => {
    // Godot's default base, 1152x648, in a 1000x700 window under integer
    // stretch: 1x is the least it draws, from x 0, so the right side is cut.
    const [tick] = parseTicks(
      '{"t":1,"kind":"tick","scene":"","viewport":[1152,648],"window":[1000,700],"content":[0,26,1152,648],"nodes":[]}',
    );
    expect(tick.content).toEqual([0, 26, 1152, 648]);
    const [px, py] = toViewport(tick, 200, 200, { width: 1000, height: 700 });
    expect(px).toBeCloseTo(200);
    expect(py).toBeCloseTo(174);
  });

  it("fit the viewport into the window at its own aspect when a tick does not say", () => {
    for (const fields of ["", ',"window":[1000,700],"content":[0,69,1000]']) {
      const tick = letterboxed(fields);
      expect(tick.content).toBeUndefined();
      const [px, py] = toViewport(tick, 500, 100, { width: 1000, height: 700 });
      expect(px).toBeCloseTo(320);
      expect(py).toBeCloseTo(20);
    }
  });
});

describe("mark telemetry", () => {
  it("take what an opening pane finds as the start, and report each mark after it", () => {
    const first = newF8Marks(null, 1, 3, true);
    expect(first).toEqual({ next: { run: 1, count: 3 }, report: 0 });
    expect(newF8Marks(first.next, 1, 5, false)).toEqual({ next: { run: 1, count: 5 }, report: 2 });
    expect(newF8Marks(first.next, 1, 3, false).report).toBe(0);
  });

  it("count a run not seen before from none, and never report a count going down", () => {
    expect(newF8Marks({ run: 1, count: 4 }, 2, 1, false).report).toBe(1);
    expect(newF8Marks(null, 2, 2, false).report).toBe(2);
    expect(newF8Marks({ run: 2, count: 4 }, 2, 1, false).report).toBe(0);
  });
});

describe("contact sheets", () => {
  it("run one frame a second from two before to two after", () => {
    expect(contactTimes(41_000, 41_000, 151_400)).toEqual([39_000, 40_000, 41_000, 42_000, 43_000]);
    expect(contactTimes(500, 500, 151_400)[0]).toBe(0);
  });

  it("sample a long range evenly to at most sixteen", () => {
    const times = contactTimes(10_000, 60_000, 151_400);
    expect(times).toHaveLength(CONTACT_MAX);
    expect(times[0]).toBe(8_000);
    expect(times[CONTACT_MAX - 1]).toBe(62_000);
  });

  it("lay sixteen out four by four, and fewer in one row", () => {
    expect(contactLayout(16)).toMatchObject({ cols: 4, rows: 4, width: 1280, height: 720 });
    expect(contactLayout(3)).toMatchObject({ cols: 3, rows: 1 });
  });

  it("keep the take's own shape in every cell", () => {
    expect(contactLayout(8, 4 / 3)).toMatchObject({
      cell: { width: 320, height: 240 },
      width: 1280,
      height: 480,
    });
    expect(contactLayout(4, 21 / 9).cell).toEqual({ width: 320, height: 137 });
    expect(contactLayout(4, 0).cell).toEqual({ width: 320, height: 180 });
  });

  it("give up on a seek the video never answers, or one it cannot make", async () => {
    vi.useFakeTimers();
    try {
      const silent = {
        currentTime: 0,
        readyState: 4,
        error: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLVideoElement;
      const waiting = seek(silent, 41_000, 5_000);
      vi.advanceTimersByTime(5_000);
      await expect(waiting).rejects.toThrow("did not reach 0:41.00");
      expect(silent.removeEventListener).toHaveBeenCalledTimes(2);
      const broken = { ...silent, error: { code: 4 } } as unknown as HTMLVideoElement;
      await expect(seek(broken, 0)).rejects.toThrow("could not be read");
    } finally {
      vi.useRealTimers();
    }
  });

  it("print take time as minutes and seconds", () => {
    expect(clock(102_180)).toBe("1:42");
    expect(clock(102_180, true)).toBe("1:42.18");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("keys", () => {
  const key = (k: string, mods: { ctrl?: boolean; shift?: boolean; typing?: boolean } = {}) => ({
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    typing: mods.typing ?? false,
  });

  it("map the live keys from the board", () => {
    expect(liveAction(key("F5"))).toBe("run-or-restart");
    expect(liveAction(key("F5", { shift: true }))).toBe("stop");
    expect(liveAction(key("F7"))).toBe("review");
    expect(liveAction(key("F8", { typing: true }))).toBe("mark");
    expect(liveAction(key("M", { ctrl: true, shift: true }))).toBe("markup");
    expect(liveAction(key("r", { ctrl: true }))).toBe("record");
    expect(liveAction(key("r", { ctrl: true, typing: true }))).toBeNull();
  });

  it("map the review keys, and leave typing alone except Ctrl Enter", () => {
    expect(reviewAction(key(" "))).toBe("play");
    expect(reviewAction(key("ArrowLeft"))).toBe("back");
    expect(reviewAction(key("I"))).toBe("in");
    expect(reviewAction(key("n", { typing: true }))).toBeNull();
    expect(reviewAction(key("Enter", { ctrl: true, typing: true }))).toBe("send");
  });
});
