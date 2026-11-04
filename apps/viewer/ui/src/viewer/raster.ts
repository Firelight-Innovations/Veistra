/**
 * Decoded pixels as a PNG `Blob`, for the formats `<img>` cannot decode itself
 * (TGA, a `.blend`'s thumbnail). Encoding back to PNG is what lets them reuse
 * the image viewer's `<img>`, sizing and metadata strip unchanged.
 */
import type { DecodedImage } from "./tga";

export function rgbaToPng(image: DecodedImage): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("This pane cannot draw images (no 2D canvas)."));
  const pixels = new Uint8ClampedArray(image.rgba);
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))),
      "image/png",
    ),
  );
}
