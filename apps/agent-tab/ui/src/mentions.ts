/** Caret-local @ completion. Inserted references retain a stable project URI. */
export interface MentionHit {
  uri: string;
  kind: string;
  title: string;
  detail?: string;
}
export interface ContextChip {
  id: string;
  label: string;
  kind: string;
  uri?: string;
  command?: string;
}

/** One run of a draft: plain text, or the `@label` token a reference chip sits on. */
export interface ChipSegment {
  text: string;
  start: number;
  end: number;
  chip?: ContextChip;
}

/**
 * A draft cut at its reference chips. A chip lives in the draft as `@label`
 * where it was picked, so it reads in place; each chip claims its first token
 * that starts a word, longest label first so `@ab` is not taken for `@a`.
 */
export function chipSegments(text: string, chips: readonly ContextChip[]): ChipSegment[] {
  const refs = chips.filter((c) => c.uri).sort((a, b) => b.label.length - a.label.length);
  const used = new Set<ContextChip>();
  const parts: ChipSegment[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const chip =
      text[i] === "@" && (i === 0 || /\s/.test(text[i - 1]))
        ? refs.find((c) => !used.has(c) && text.startsWith(`@${c.label}`, i))
        : undefined;
    if (!chip) {
      i += 1;
      continue;
    }
    if (i > from) parts.push({ text: text.slice(from, i), start: from, end: i });
    const end = i + chip.label.length + 1;
    parts.push({ text: text.slice(i, end), start: i, end, chip });
    used.add(chip);
    from = i = end;
  }
  if (from < text.length) parts.push({ text: text.slice(from), start: from, end: text.length });
  return parts;
}

/** The chips a draft still holds: every skill, and each reference whose token is in it. */
export function keptChips(text: string, chips: readonly ContextChip[]): ContextChip[] {
  const placed = new Set(chipSegments(text, chips).map((p) => p.chip));
  return chips.filter((c) => !c.uri || placed.has(c));
}

/** The reference chip whose token ends at `caret`, for Backspace to take whole. */
export function chipEndingAt(
  text: string,
  caret: number,
  chips: readonly ContextChip[],
): ChipSegment | undefined {
  return chipSegments(text, chips).find((p) => p.chip && p.end === caret);
}

/** Puts `@label` in place of `start..end`, spaced off from the words either side. */
export function insertChipToken(
  text: string,
  start: number,
  end: number,
  label: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const token = `${before === "" || /\s$/.test(before) ? "" : " "}@${label}${/^\s/.test(after) ? "" : " "}`;
  return { text: before + token + after, caret: before.length + token.length };
}

const link = (chip: ContextChip) => `[@${chip.label.replace(/[[\]]/g, "")}](<${chip.uri}>)`;

/**
 * Visible chips retain their structured identity until the prompt is sent: each
 * reference becomes its link where its token sits, and skills lead the prompt.
 */
export function withChips(text: string, chips: readonly ContextChip[]): string {
  const skills = chips
    .map((chip) => chip.command?.trim())
    .filter((command): command is string => Boolean(command))
    .map((command) =>
      command.startsWith("$") || command.startsWith("/") ? command : `/${command}`,
    )
    .join(" ");
  const parts = chipSegments(text, chips);
  const placed = new Set(parts.map((p) => p.chip));
  const loose = chips
    .filter((chip) => chip.uri && !placed.has(chip))
    .map(link)
    .join(" ");
  const body = parts
    .map((p) => (p.chip ? link(p.chip) : p.text))
    .join("")
    .trim();
  return [skills, loose, body].filter(Boolean).join(" ");
}

/**
 * Kinds a URI cannot say, such as a context item that holds a Godot node,
 * kept as the chip is made so the sent chip keeps its colour. For this
 * session only: a reloaded history colours those as plain context.
 */
const told = new Map<string, string>();

/** Keep a chip's kind for `referenceKind`, when its URI alone would not say it. */
export function rememberKind(uri: string, kind: string): void {
  if (kind !== referenceKind(uri)) told.set(uri, kind);
}

/**
 * What a reference points at, read back from its URI, for the colour a sent
 * message's chip takes: a sent `[@label](<uri>)` keeps no kind of its own.
 * The forms are `src-tauri/src/refs/mod.rs`'s; an `https://` link is an issue,
 * the only kind picked from the menu as one. Anything else is `null`, unless
 * `rememberKind` was told.
 */
export function referenceKind(uri: string): string | null {
  const kept = told.get(uri);
  if (kept) return kept;
  const veistra = /^veistra:\/\/([^/#?]+)(?:\/[^#]*)?(?:#(.*))?$/.exec(uri);
  if (!veistra) return /^https:\/\//.test(uri) ? "issue" : null;
  const [, root, fragment = ""] = veistra;
  if (root === "canvas") {
    if (fragment.startsWith("frame=")) return "frame";
    if (fragment.startsWith("comment=")) return "canvas-comment";
    return "canvas";
  }
  const known = ["file", "comment", "design-comment", "context", "selection"];
  return known.includes(root) ? root : null;
}

export function referenceParts(text: string): Array<{ text: string; uri?: string }> {
  const parts: Array<{ text: string; uri?: string }> = [];
  let at = 0;
  for (const match of text.matchAll(/\[@([^\]]+)\]\(<((?:veistra|https):\/\/[^>]+)>\)/g)) {
    if (match.index! > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ text: match[1], uri: match[2] });
    at = match.index! + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

export function mentionAt(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1] };
}

export function insertMention(
  text: string,
  query: MentionQuery,
  hit: MentionHit,
): { text: string; caret: number } {
  const token = `[@${hit.title.replace(/[[\]]/g, "")}](<${hit.uri}>) `;
  return {
    text: text.slice(0, query.start) + token + text.slice(query.end),
    caret: query.start + token.length,
  };
}

/** Only explicit inserted references are resolved, never arbitrary URLs in prose. */
export function mentionedUris(text: string): string[] {
  return [...new Set([...text.matchAll(/\[@[^\]]+\]\(<(veistra:\/\/[^>]+)>\)/g)].map((m) => m[1]))];
}
