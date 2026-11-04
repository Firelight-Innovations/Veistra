import { describe, expect, it } from "vitest";
import { MODEL_FORMATS } from "@veistra/scene-view";
import { MODEL_EXTENSIONS } from "./assetFormats";
import { pick, type OpenFile } from "./registry";

const fileNamed = (name: string): OpenFile => ({
  path: `C:/game/${name}`,
  name,
  ext: name.slice(name.lastIndexOf(".") + 1).toLowerCase(),
  size: 1,
  mtime: 1,
});

describe("asset viewers in the registry", () => {
  it.each([
    ["chair.glb", "model"],
    ["chair.gltf", "model"],
    ["rock.obj", "model"],
    ["hero.fbx", "model"],
    ["scan.ply", "model"],
    ["part.stl", "model"],
    ["chair.blend", "blend"],
    ["grass.tga", "image"],
    ["jump.wav", "media"],
    ["theme.ogg", "media"],
    ["intro.webm", "media"],
    ["Pixel.ttf", "font"],
    ["ui.woff2", "font"],
    ["enemy.gd", "text"],
    ["main.tscn", "text"],
  ])("opens %s with the %s viewer", (name, viewer) => {
    expect(pick(fileNamed(name)).id).toBe(viewer);
  });

  it("claims exactly the model formats the scene view can parse", () => {
    expect([...MODEL_EXTENSIONS].sort()).toEqual([...MODEL_FORMATS].sort());
  });
});
