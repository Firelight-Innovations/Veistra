/**
 * A glb's triangles, in world space, grouped by the glTF node they belong to.
 * CPU only: this runs inside the diff worker, which has no DOM and no WebGL.
 */
import { InstancedMesh, Matrix4, Object3D, Vector3 } from "three";
import type { BufferGeometry, Mesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { PartTriangles } from "./types";

/**
 * Drops every primitive's material before the loader sees it. The diff
 * needs positions only, and textures are the expensive part of a parse; a
 * worker also cannot decode the images some loaders use without a DOM.
 */
function withoutMaterials(parser: GLTFParser) {
  return {
    name: "VEISTRA_geometry_only",
    beforeRoot() {
      for (const mesh of parser.json.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) delete primitive.material;
      }
      return null;
    },
  };
}

/** Parses a glb for its triangles. Rejects what `GLTFLoader` rejects. */
export async function parseParts(glb: ArrayBuffer): Promise<PartTriangles[]> {
  const loader = new GLTFLoader();
  loader.register(withoutMaterials);
  const gltf = await loader.parseAsync(glb, "");
  const parser = gltf.parser;
  const nodes: { name?: string }[] = parser.json.nodes ?? [];
  return flatten(gltf.scene, (obj) => {
    for (let o: Object3D | null = obj; o; o = o.parent) {
      const index = parser.associations.get(o)?.nodes;
      if (index !== undefined) return nodes[index]?.name ?? o.name;
    }
    return obj.name;
  });
}

/**
 * Every mesh under `root`, transformed to world space and filed under
 * `partOf(mesh)`. Takes the name as a function because three rewrites node
 * names (`PropertyBinding.sanitizeNodeName` turns "Bed Frame.001" into
 * "Bed_Frame001"), and the part list must match Blender's names.
 */
export function flatten(root: Object3D, partOf: (mesh: Mesh) => string): PartTriangles[] {
  root.updateMatrixWorld(true);
  const lists = new Map<string, Float32Array[]>();
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const name = partOf(mesh);
    const list = lists.get(name) ?? [];
    if (mesh instanceof InstancedMesh) {
      const local = new Matrix4();
      for (let k = 0; k < mesh.count; k++) {
        mesh.getMatrixAt(k, local);
        list.push(
          triangles(mesh.geometry, new Matrix4().multiplyMatrices(mesh.matrixWorld, local)),
        );
      }
    } else {
      list.push(triangles(mesh.geometry, mesh.matrixWorld));
    }
    lists.set(name, list);
  });
  return [...lists].map(([name, list]) => ({ name, positions: join(list) }));
}

function triangles(geometry: BufferGeometry, matrix: Matrix4): Float32Array {
  const pos = geometry.getAttribute("position");
  if (!pos) return new Float32Array(0);
  const world = new Float32Array(pos.count * 3);
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    world[i * 3] = v.x;
    world[i * 3 + 1] = v.y;
    world[i * 3 + 2] = v.z;
  }
  const index = geometry.getIndex();
  const n = index ? index.count : pos.count;
  const out = new Float32Array(Math.floor(n / 3) * 9);
  for (let c = 0; c < out.length / 3; c++) {
    const i = index ? index.getX(c) : c;
    out[c * 3] = world[i * 3];
    out[c * 3 + 1] = world[i * 3 + 1];
    out[c * 3 + 2] = world[i * 3 + 2];
  }
  return out;
}

function join(list: Float32Array[]): Float32Array {
  if (list.length === 1) return list[0];
  const out = new Float32Array(list.reduce((n, l) => n + l.length, 0));
  let w = 0;
  for (const l of list) {
    out.set(l, w);
    w += l.length;
  }
  return out;
}
