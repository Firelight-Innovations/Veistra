/**
 * What the model is told about Veistra, and how an ACP prompt becomes Pi's text and images.
 */

/** Appended to Pi's own system prompt, which already describes its tools. */
export const VEISTRA_PROMPT = `You are Veistra's agent. Veistra is a desktop studio for making games; you work inside it, in one git worktree of the user's project, which is your working directory.

- Stay inside the worktree. A file tool that names a path outside it is refused.
- Edits, commands and Veistra's own tools may wait for the user to approve them. If one is declined, do not retry the same call; say what you wanted to do and ask.
- Tools named mcp__veistra-* (spelled mcp__veistra_*) are Veistra's: its canvas, the user's selection and comments, and the components it can show in the conversation. Prefer them to guessing at what the user is looking at.
- When the task produces something runnable, finish with the built result and say how to open it, not only the source that would produce it.`;

/** One block of an ACP prompt, as the host sends it. */
export interface PromptBlock {
  type?: string;
  text?: string;
  uri?: string;
  name?: string;
  title?: string;
  mimeType?: string;
  data?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiPrompt {
  text: string;
  images: PiImage[];
}

/**
 * Text blocks in order, chip references as text the model can read, pictures as images. The host
 * puts a chip's hidden context first and the user's words after it (`session.rs`, `turn`).
 */
export function toPi(blocks: unknown): PiPrompt {
  const parts: string[] = [];
  const images: PiImage[] = [];
  for (const raw of Array.isArray(blocks) ? (blocks as PromptBlock[]) : []) {
    if (typeof raw !== "object" || raw === null) continue;
    switch (raw.type) {
      case "text":
        if (raw.text) parts.push(raw.text);
        break;
      case "image":
        if (raw.data && raw.mimeType) {
          images.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
        }
        break;
      case "resource_link":
        if (raw.uri) parts.push(`[${raw.title ?? raw.name ?? raw.uri}](${raw.uri})`);
        break;
      case "resource": {
        const r = raw.resource;
        if (!r?.uri) break;
        if (typeof r.text === "string") {
          parts.push(`<context uri="${r.uri}">\n${r.text}\n</context>`);
        } else if (r.blob && r.mimeType?.startsWith("image/")) {
          images.push({ type: "image", data: r.blob, mimeType: r.mimeType });
        } else {
          parts.push(`[${r.uri}](${r.uri})`);
        }
        break;
      }
      default:
        break;
    }
  }
  return { text: parts.join("\n\n"), images };
}
