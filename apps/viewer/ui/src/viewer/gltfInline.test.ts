import { describe, expect, it } from "vitest";
import { inlineGltf } from "./gltfInline";

const doc = {
  asset: { version: "2.0" },
  buffers: [
    { uri: "chair.bin", byteLength: 3 },
    { uri: "data:application/octet-stream;base64,AA==" },
  ],
  images: [{ uri: "tex/wood%20grain.jpg" }, { uri: "https://example.com/x.png" }],
};

describe("inlineGltf", () => {
  it("reads relative buffers and images beside the document and inlines them", async () => {
    const asked: string[] = [];
    const out = JSON.parse(
      await inlineGltf(JSON.stringify(doc), "C:\\game\\models\\chair.gltf", async (path) => {
        asked.push(path);
        return "QUJD";
      }),
    );

    expect(asked.sort()).toEqual([
      "C:\\game\\models\\chair.bin",
      "C:\\game\\models\\tex/wood grain.jpg",
    ]);
    expect(out.buffers[0].uri).toBe("data:application/octet-stream;base64,QUJD");
    expect(out.images[0].uri).toBe("data:image/jpeg;base64,QUJD");
  });

  it("leaves data and web URIs alone", async () => {
    const out = JSON.parse(
      await inlineGltf(JSON.stringify(doc), "/m/chair.gltf", async () => "QQ=="),
    );
    expect(out.buffers[1].uri).toBe(doc.buffers[1].uri);
    expect(out.images[1].uri).toBe(doc.images[1].uri);
  });

  it("names the missing file when one cannot be read", async () => {
    const failing = inlineGltf(JSON.stringify(doc), "/m/chair.gltf", async () => {
      throw new Error("not found");
    });
    await expect(failing).rejects.toThrow(/refers to (chair\.bin|tex\/wood grain\.jpg).*not found/);
  });

  it("says so when the document is not JSON", async () => {
    await expect(inlineGltf("{", "/m/a.gltf", async () => "")).rejects.toThrow(/not valid JSON/);
  });
});
