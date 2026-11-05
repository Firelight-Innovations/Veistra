import { describe, expect, it } from "vitest";
import {
  chipEndingAt,
  chipSegments,
  insertChipToken,
  insertMention,
  keptChips,
  mentionAt,
  mentionedUris,
  referenceKind,
  referenceParts,
  rememberKind,
  withChips,
} from "./mentions";
import type { ContextChip } from "./mentions";

const skill = (command: string): ContextChip => ({
  id: command,
  label: command.replace(/^[$/]/, ""),
  kind: "skill",
  command,
});
const reference: ContextChip = {
  id: "comment-1",
  label: "Comment 1",
  kind: "comment",
  uri: "veistra://canvas/comments/1",
};

describe("skill and project context chips", () => {
  it("preserves Codex dollar invocations without adding a slash", () => {
    expect(withChips("Review this", [skill("$documents:documents")])).toBe(
      "$documents:documents Review this",
    );
    expect(withChips("", [skill("$custom"), skill("$plugin:design")])).toBe(
      "$custom $plugin:design",
    );
  });

  it("writes Claude skill invocations with exactly one slash", () => {
    expect(withChips("Review this", [skill("review"), skill("/team:style")])).toBe(
      "/review /team:style Review this",
    );
  });

  it("retains stable context URIs beside skill invocations and the draft", () => {
    const text = withChips("Check the spacing", [reference, skill("$design")]);
    expect(text).toBe("$design [@Comment 1](<veistra://canvas/comments/1>) Check the spacing");
    expect(mentionedUris(text)).toEqual([reference.uri]);
  });

  it("does not serialize empty commands or undefined chip fields", () => {
    expect(
      withChips("Keep this draft", [skill("   "), { id: "empty", label: "Empty", kind: "skill" }]),
    ).toBe("Keep this draft");
    expect(withChips("", [])).toBe("");
  });

  it("renders inserted project references while leaving ordinary URLs as prose", () => {
    expect(referenceParts("Read [@Comment 1](<veistra://canvas/comments/1>) here")).toEqual([
      { text: "Read " },
      { text: "Comment 1", uri: reference.uri },
      { text: " here" },
    ]);
    expect(referenceParts("See https://example.com")).toEqual([
      { text: "See https://example.com" },
    ]);
    expect(mentionedUris("See veistra://canvas/comments/1")).toEqual([]);
  });
});

describe("referenceKind", () => {
  // The forms `src-tauri/src/refs/uri.rs` writes, so a sent chip keeps its menu row's colour.
  it.each([
    ["veistra://file/src/main.rs", "file"],
    ["veistra://file/src/main.rs#L10-L20", "file"],
    ["veistra://canvas/world", "canvas"],
    ["veistra://canvas/levels/hospital#frame=f_12", "frame"],
    ["veistra://canvas/world#comment=c-1", "canvas-comment"],
    ["veistra://comment/v-3", "comment"],
    ["veistra://design-comment/d-1", "design-comment"],
    ["veistra://context/brief", "context"],
    ["veistra://selection", "selection"],
    ["https://linear.app/acme/issue/ENG-1", "issue"],
  ])("reads %s as %s", (uri, kind) => {
    expect(referenceKind(uri)).toBe(kind);
  });

  it("has no kind for a form it does not know", () => {
    expect(referenceKind("veistra://somewhere-new/x")).toBeNull();
    expect(referenceKind("http://example.com")).toBeNull();
  });

  // A context item holding a Godot node says nothing of it in its URI.
  it("keeps a kind the chip was made with, where the URI alone would not say it", () => {
    rememberKind("veistra://context/ctx_godot", "godot-node");
    rememberKind("veistra://file/a.md", "file");
    expect(referenceKind("veistra://context/ctx_godot")).toBe("godot-node");
    expect(referenceKind("veistra://context/ctx_other")).toBe("context");
    expect(referenceKind("veistra://file/a.md")).toBe("file");
  });
});

describe("chips in place in the draft", () => {
  const design: ContextChip = {
    id: "design",
    label: "design",
    kind: "canvas",
    uri: "veistra://canvas/design",
  };

  it("sends each reference where its token sits, not at the front", () => {
    expect(
      withChips("Review the @design and the @Comment 1 and give me feedback", [design, reference]),
    ).toBe(
      "Review the [@design](<veistra://canvas/design>) and the " +
        "[@Comment 1](<veistra://canvas/comments/1>) and give me feedback",
    );
  });

  it("places a token at the caret, spaced off from the words around it", () => {
    expect(insertChipToken("Review the  and more", 11, 11, "design")).toEqual({
      text: "Review the @design and more",
      caret: 18,
    });
    expect(insertChipToken("Review@des", 6, 10, "design")).toEqual({
      text: "Review @design ",
      caret: 15,
    });
  });

  it("drops a reference whose token was edited away, and keeps skills", () => {
    const chips = [design, reference, skill("$review")];
    expect(keptChips("look at @design", chips)).toEqual([design, skill("$review")]);
    expect(keptChips("look at @desXign", chips)).toEqual([skill("$review")]);
  });

  it("takes the longest label, and only at the start of a word", () => {
    const short: ContextChip = { ...design, id: "d", label: "des", uri: "veistra://canvas/d" };
    const parts = chipSegments("x@design @design", [short, design]);
    expect(parts.filter((p) => p.chip).map((p) => [p.start, p.chip!.label])).toEqual([
      [9, "design"],
    ]);
  });

  it("finds the chip Backspace should take whole", () => {
    expect(chipEndingAt("see @design now", 11, [design])?.start).toBe(4);
    expect(chipEndingAt("see @design now", 10, [design])).toBeUndefined();
  });
});

describe("caret-local reference completion", () => {
  it("replaces only the active mention and keeps the remaining draft", () => {
    const draft = "Check @comm beside this";
    const query = mentionAt(draft, 11);
    expect(query).toEqual({ start: 6, end: 11, query: "comm" });
    const inserted = insertMention(draft, query!, {
      title: "Comment 1",
      uri: reference.uri!,
      kind: "comment",
    });
    expect(inserted.text).toBe("Check [@Comment 1](<veistra://canvas/comments/1>)  beside this");
    expect(inserted.text.slice(inserted.caret)).toBe(" beside this");
  });

  it("ignores email addresses and mentions outside the caret token", () => {
    expect(mentionAt("someone@example.com", 19)).toBeNull();
    expect(mentionAt("@comment then text", 18)).toBeNull();
  });
});
