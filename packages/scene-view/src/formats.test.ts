import { describe, expect, it } from "vitest";
import type { Mesh, MeshStandardMaterial, Object3D, Points } from "three";
import { isModelFormat, parseModel, type ModelFormat } from "./formats";
import { countTriangles } from "./limits";

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const parse = (format: ModelFormat, text: string) => parseModel({ bytes: bytesOf(text), format });

function first<T extends Object3D>(root: Object3D, test: (o: Object3D) => boolean): T {
  let found: Object3D | undefined;
  root.traverse((o) => {
    if (!found && test(o)) found = o;
  });
  if (!found) throw new Error("no matching object");
  return found as T;
}

const TRIANGLE_STL = `solid t
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid t`;

const ply = (faces: boolean) =>
  [
    "ply",
    "format ascii 1.0",
    "element vertex 3",
    "property float x",
    "property float y",
    "property float z",
    ...(faces ? ["element face 1", "property list uchar int vertex_indices"] : []),
    "end_header",
    "0 0 0",
    "1 0 0",
    "0 1 0",
    ...(faces ? ["3 0 1 2"] : []),
    "",
  ].join("\n");

describe("isModelFormat", () => {
  it("knows the formats the viewer routes here, and nothing else", () => {
    for (const ext of ["glb", "gltf", "obj", "fbx", "dae", "stl", "ply", "3ds", "3mf"]) {
      expect(isModelFormat(ext)).toBe(true);
    }
    expect(isModelFormat("blend")).toBe(false);
    expect(isModelFormat("png")).toBe(false);
    expect(isModelFormat("")).toBe(false);
  });
});

describe("parseModel", () => {
  it("gives an STL a lit, neutral material and normals", async () => {
    const root = await parse("stl", TRIANGLE_STL);
    const mesh = first<Mesh>(root, (o) => (o as Mesh).isMesh === true);

    expect(countTriangles(root)).toBe(1);
    expect(mesh.geometry.hasAttribute("normal")).toBe(true);
    expect((mesh.material as MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
  });

  it("draws a PLY with faces as a mesh and one without as a point cloud", async () => {
    const withFaces = await parse("ply", ply(true));
    expect(countTriangles(withFaces)).toBe(1);

    const cloud = await parse("ply", ply(false));
    expect((cloud as Points).isPoints).toBe(true);
    expect(countTriangles(cloud)).toBe(0);
  });

  it("reads an OBJ's faces", async () => {
    const root = await parse("obj", "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n");
    expect(countTriangles(root)).toBe(2);
  });

  it("leaves glTF to the engine's own loader", async () => {
    await expect(parse("glb", "")).rejects.toThrow(/GLTFLoader/);
  });
});
