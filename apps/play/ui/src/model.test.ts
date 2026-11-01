/**
 * Play's pure modules: the note model, telemetry in the page, the contact
 * sheet's times, the game box's geometry and the keys.
 */
import { describe, expect, it } from "vitest";
import type { Comment } from "../../../shared/comments";
import { CONTACT_MAX, clock, contactLayout, contactTimes } from "./frames";
import { boxInWindow, covered, isWindowRect, overlayRects, sameRect } from "./geometry";
import { liveAction, reviewAction } from "./keys";
import {
  addNote,
  dismissMark,
  emptyDoc,
  errorsNear,
  noteStatus,
  normalize,
  parseLog,
  pendingMarks,
  removeNote,
  sendable,
  updateNote,
} from "./notes";
import { frameSeries, nearestTick, parseTicks, recordedTarget } from "./telemetry";

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

  it("print take time as minutes and seconds", () => {
    expect(clock(102_180)).toBe("1:42");
    expect(clock(102_180, true)).toBe("1:42.18");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("geometry", () => {
  it("place the game box in window space and see what covers it", () => {
    const frame = { x: 400, y: 120, width: 900, height: 700 };
    const box = boxInWindow(frame, { left: 16, top: 60, width: 640, height: 360 });
    expect(box).toEqual({ x: 416, y: 180, w: 640, h: 360 });
    expect(covered(box, [{ x: 1000, y: 500, width: 200, height: 200 }])).toBe(true);
    expect(covered(box, [{ x: 0, y: 0, width: 400, height: 100 }])).toBe(false);
    expect(sameRect(box, { ...box })).toBe(true);
    expect(isWindowRect({ x: 1, y: 2, width: 3, height: 4, window: "main" })).toBe(true);
    expect(isWindowRect({ x: 1 })).toBe(false);
    expect(overlayRects({ rects: [{ x: 0, y: 0, width: 1, height: 1 }, "bad"] })).toHaveLength(1);
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
