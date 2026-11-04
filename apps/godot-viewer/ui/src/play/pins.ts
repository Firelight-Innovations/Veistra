/**
 * What each pin of a markup sits on, asked after Done of whoever can pick:
 * the running game (`play/pick`) or the Godot editor (`godot/editor-pick`).
 * Neither can answer while the person draws, since each answer is a file
 * round trip, so pins are placed bare and filled in here.
 *
 * The frame is drawn stretched over the box (`object-fit: fill`), so a pin's
 * place on the shown frame scales to the captured frame's pixels on each axis.
 */
import type { MarkupExport } from "@veistra/markup/layer";

export interface Size {
  width: number;
  height: number;
}

/** The excalidraw pins of a markup, with where each sits on the shown frame. */
export function pinCentres(json: MarkupExport["json"]): { n: number; x: number; y: number }[] {
  const out: { n: number; x: number; y: number }[] = [];
  for (const el of json.excalidraw.elements as Array<Record<string, unknown>>) {
    const v = (el.customData as { veistra?: { kind?: string; n?: number } } | undefined)?.veistra;
    if (v?.kind !== "pin" || typeof v.n !== "number") continue;
    const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(el[k]) || 0);
    out.push({ n: v.n, x: x + w / 2, y: y + h / 2 });
  }
  return out;
}

/**
 * Asks `pick` about every pin, in the captured frame's pixels, and writes each
 * answer into its pin. Resolves with the first hit. A pick that fails leaves
 * that pin bare; the picture still says it.
 */
export async function resolvePins<H extends { nodePath: string; worldPoint?: number[] | null }>(
  json: MarkupExport["json"],
  natural: Size,
  shown: Size,
  pick: (x: number, y: number) => Promise<H | null>,
): Promise<H | null> {
  const sx = natural.width > 0 && shown.width > 0 ? natural.width / shown.width : 1;
  const sy = natural.height > 0 && shown.height > 0 ? natural.height / shown.height : 1;
  let first: H | null = null;
  for (const p of pinCentres(json)) {
    try {
      const hit = await pick(p.x * sx, p.y * sy);
      if (!hit) continue;
      const pin = json.pins.find((x) => x.n === p.n);
      const wp = hit.worldPoint;
      if (pin) {
        pin.nodePath = hit.nodePath;
        if (wp && wp.length === 3) pin.worldPoint = [wp[0], wp[1], wp[2]];
      }
      first ??= hit;
    } catch {
      // Bare, as above.
    }
  }
  return first;
}
