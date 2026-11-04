/**
 * Model formats other than glTF, parsed into a three.js scene the engine can
 * show. The Files viewer's preview of `.obj`, `.fbx`, `.stl` and friends
 * (issue #342) — read-only, so materials, textures and animation are shown as
 * far as each loader understands them and no further.
 *
 * Every loader is a dynamic `import()`: FBX's alone is ~100 kB, and a viewer
 * opening a `.glb` should not pay for it.
 */
import { Mesh, MeshStandardMaterial, Points, PointsMaterial } from "three";
import type { BufferGeometry, Object3D } from "three";

/** Every format `SceneView` can preview, by lowercase dot-less extension. */
export const MODEL_FORMATS = [
  "glb",
  "gltf",
  "obj",
  "fbx",
  "dae",
  "stl",
  "ply",
  "3ds",
  "3mf",
] as const;

export type ModelFormat = (typeof MODEL_FORMATS)[number];

export function isModelFormat(extension: string): extension is ModelFormat {
  return (MODEL_FORMATS as readonly string[]).includes(extension);
}

/** A model that is not a glb: its bytes, and the format that says how to read them. */
export interface ModelSource {
  bytes: ArrayBuffer;
  format: ModelFormat;
}

/** The neutral grey for a format with no materials of its own (STL, most PLY). */
const UNTEXTURED = 0xb4b4b4;

/**
 * A bare geometry as something visible. STL and PLY carry no material, so they
 * get a neutral one — or white when the file has vertex colours to show.
 */
export function meshOf(geometry: BufferGeometry): Mesh {
  const vertexColors = geometry.hasAttribute("color");
  if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
  return new Mesh(
    geometry,
    new MeshStandardMaterial({
      color: vertexColors ? 0xffffff : UNTEXTURED,
      vertexColors,
      roughness: 0.8,
    }),
  );
}

/**
 * A PLY with no face list is a point cloud (a scan, usually) — drawn as points,
 * because as a mesh it would be nothing at all. `PLYLoader` sets an index
 * exactly when the file had faces, so the index is the whole test.
 */
export function plyObject(geometry: BufferGeometry): Mesh | Points {
  if (geometry.index !== null) return meshOf(geometry);
  const vertexColors = geometry.hasAttribute("color");
  return new Points(
    geometry,
    new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors }),
  );
}

const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

/**
 * Parse a non-glTF model into a scene root. Throws with the loader's own
 * message when the bytes are not what the extension claims.
 */
export async function parseModel(source: ModelSource): Promise<Object3D> {
  const { bytes, format } = source;
  switch (format) {
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      return new OBJLoader().parse(text(bytes));
    }
    case "fbx": {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      return new FBXLoader().parse(bytes, "");
    }
    case "dae": {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      const collada = new ColladaLoader().parse(text(bytes), "");
      if (!collada) throw new Error("Not a COLLADA document");
      return collada.scene;
    }
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      return meshOf(new STLLoader().parse(bytes));
    }
    case "ply": {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      return plyObject(new PLYLoader().parse(bytes));
    }
    case "3ds": {
      const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
      return new TDSLoader().parse(bytes, "");
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      return new ThreeMFLoader().parse(bytes);
    }
    case "glb":
    case "gltf":
      throw new Error("glTF is read by the engine's GLTFLoader, cameras and lights included");
  }
}
