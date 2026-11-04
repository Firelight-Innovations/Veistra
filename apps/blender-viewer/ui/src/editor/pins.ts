/**
 * What each pin of a markup on Blender's 3D view sits on. Blender answers a
 * pick by a file round trip (`blender-viewer/editor-pick`), too slow to ask
 * while the person draws, so pins are placed bare and filled in after Done,
 * as the Godot editor's are.
 *
 * The capture is drawn stretched over the box (`object-fit: fill`), so a pin's
 * place on the shown picture scales to the capture's pixels on each axis.
 */
import type { MarkupExport } from "@veistra/markup/layer";
import type { ViewportHit } from "./rpc";

export interface Size {
  width: number;
  height: number;
}

/** The excalidraw pins of a markup, with where each sits on the shown picture. */
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
 * Asks `pick` about every pin, in the capture's pixels, and names the object
 * under each in its pin. A pick that fails leaves that pin bare; the picture
 * still says it. Resolves with how many pins were named.
 */
export async function resolvePins(
  json: MarkupExport["json"],
  natural: Size,
  shown: Size,
  pick: (x: number, y: number) => Promise<ViewportHit | null>,
): Promise<number> {
  const sx = natural.width > 0 && shown.width > 0 ? natural.width / shown.width : 1;
  const sy = natural.height > 0 && shown.height > 0 ? natural.height / shown.height : 1;
  let named = 0;
  for (const p of pinCentres(json)) {
    try {
      const hit = await pick(p.x * sx, p.y * sy);
      const pin = json.pins.find((x) => x.n === p.n);
      if (!hit || !pin) continue;
      pin.nodePath = hit.object;
      const wp = hit.worldPoint;
      if (wp && wp.length === 3) pin.worldPoint = [wp[0], wp[1], wp[2]];
      named += 1;
    } catch {
      // Bare, as above.
    }
  }
  return named;
}
