/**
 * A picked file, made into the small square picture `account/set-avatar`
 * sends (`PUT /v1/me/avatar`, `docs/account-api.md`). The website does the
 * same in its own `picture.ts`, so a picture set in either place comes out
 * alike; an app may not import the website's source, nor it ours.
 */

/**
 * The file center-cropped to a square and shrunk to `side` pixels, as a
 * `data:` URL: WebP, or JPEG where the webview cannot encode WebP. Whatever
 * was picked is re-encoded, so the service gets a few KB in one of the three
 * types it keeps. Rejects when the webview cannot open the file.
 */
export async function shrink(file: Blob, side = 256): Promise<string> {
  const image = await createImageBitmap(file);
  const crop = Math.min(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(side, crop);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no canvas");
  const sx = (image.width - crop) / 2;
  const sy = (image.height - crop) / 2;
  ctx.drawImage(image, sx, sy, crop, crop, 0, 0, canvas.width, canvas.height);
  image.close();
  const webp = canvas.toDataURL("image/webp", 0.85);
  if (webp.startsWith("data:image/webp")) return webp;
  // JPEG has no transparency: a transparent corner would come out black.
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
