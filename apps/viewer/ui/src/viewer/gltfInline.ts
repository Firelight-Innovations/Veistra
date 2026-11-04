/**
 * A `.gltf` with its external buffers and images folded in as data URIs.
 *
 * A `.gltf` is JSON that names its geometry (`model.bin`) and textures by
 * relative URI. The viewer has no URL those resolve against — the loader would
 * fetch them relative to the app's own page — so each is read through the
 * backend and inlined before the loader sees the document.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ktx2: "image/ktx2",
};

interface UriHolder {
  uri?: unknown;
  mimeType?: unknown;
}

/** Whether a URI names a file beside the document, rather than data or the web. */
function isRelative(uri: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith("/") && !uri.startsWith("\\");
}

/**
 * Inline every relative `buffers[].uri` and `images[].uri`. `read` takes an
 * absolute path and answers its bytes as base64 (`files/read-bytes`). A file
 * that cannot be read fails the whole preview with a sentence naming it: a
 * model missing its geometry has nothing true to show.
 */
export async function inlineGltf(
  json: string,
  documentPath: string,
  read: (path: string) => Promise<string>,
): Promise<string> {
  let gltf: { buffers?: UriHolder[]; images?: UriHolder[] };
  try {
    gltf = JSON.parse(json) as typeof gltf;
  } catch {
    throw new Error("This .gltf is not valid JSON.");
  }
  const cut = Math.max(documentPath.lastIndexOf("/"), documentPath.lastIndexOf("\\"));
  const dir = documentPath.slice(0, cut + 1);

  const holders = [
    ...(gltf.buffers ?? []).map((holder) => ({ holder, fallback: "application/octet-stream" })),
    ...(gltf.images ?? []).map((holder) => ({ holder, fallback: "image/png" })),
  ];
  await Promise.all(
    holders.map(async ({ holder, fallback }) => {
      if (typeof holder.uri !== "string" || !isRelative(holder.uri)) return;
      const name = decodeURIComponent(holder.uri);
      const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const mime =
        typeof holder.mimeType === "string"
          ? holder.mimeType
          : (MIME_BY_EXTENSION[extension] ?? fallback);
      const base64 = await read(dir + name).catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`This .gltf refers to ${name}, which could not be read: ${why}`);
      });
      holder.uri = `data:${mime};base64,${base64}`;
    }),
  );
  return JSON.stringify(gltf);
}
