/**
 * The Changes view's scene: one object a class, each with its own colour and
 * pattern so the classes read apart without colour alone (spec §12.1, and
 * the board's legend). Added is a plain fill, Changed a screen-space hatch,
 * Removed a dashed outline over a faint fill, Unchanged plain grey.
 *
 * Built from plain buffers and materials, with no renderer, so a test can
 * check what is drawn without a GL context.
 */
import {
  BufferGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "three";
import type { Object3D } from "three";
import { CHANGE_CLASSES } from "./types";
import type { ChangeClass, DiffResult } from "./types";

/** CSS colours, read from the design tokens by the caller. */
export type Palette = Record<ChangeClass, string>;

/** Hatch stripes, in CSS pixels, so they look the same at any zoom. */
export const HATCH_PX = 6;

/** Edges sharper than this get a dashed outline on the removed ghost. */
const GHOST_EDGE_DEG = 20;
const GHOST_FILL_OPACITY = 0.12;
const DASH = 0.02;

function geometryOf(positions: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Darkens every other diagonal band of fragments. Measured on the screen,
 * not the surface, so a stripe is never thinner than a pixel however far
 * away the face is.
 */
function hatched(material: MeshStandardMaterial, pixelRatio: number): MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHatch = { value: HATCH_PX * pixelRatio };
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform float uHatch;\nvoid main() {")
      .replace(
        "#include <color_fragment>",
        [
          "#include <color_fragment>",
          "if (mod(gl_FragCoord.x + gl_FragCoord.y, 2.0 * uHatch) < uHatch) diffuseColor.rgb *= 0.45;",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => `veistra-hatch-${pixelRatio}`;
  return material;
}

/** The Changes view, one child a class, named after it. */
export function buildChangeScene(result: DiffResult, palette: Palette, pixelRatio = 1): Group {
  const group = new Group();
  group.name = "changes";
  for (const cls of CHANGE_CLASSES) {
    const positions = result.geometry[cls];
    const part = new Group();
    part.name = cls;
    group.add(part);
    if (positions.length === 0) continue;
    const geometry = geometryOf(positions);
    const color = new Color(palette[cls]);

    if (cls === "removed") {
      const fill = new Mesh(
        geometry,
        new MeshBasicMaterial({
          color,
          transparent: true,
          opacity: GHOST_FILL_OPACITY,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
      const outline = new LineSegments(
        new EdgesGeometry(geometry, GHOST_EDGE_DEG),
        new LineDashedMaterial({ color, dashSize: DASH, gapSize: DASH, depthTest: false }),
      );
      outline.computeLineDistances();
      outline.renderOrder = 2;
      fill.renderOrder = 1;
      part.add(fill, outline);
      continue;
    }

    const material = new MeshStandardMaterial({
      color,
      roughness: 0.8,
      metalness: 0,
      side: DoubleSide,
      // Unchanged sits behind the classes it shares faces with.
      polygonOffset: cls === "unchanged",
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    part.add(new Mesh(geometry, cls === "changed" ? hatched(material, pixelRatio) : material));
  }
  return group;
}

/** Shows only the classes `shown` turns on. */
export function showClasses(group: Object3D, shown: Record<ChangeClass, boolean>) {
  for (const child of group.children) {
    if (child.name in shown) child.visible = shown[child.name as ChangeClass];
  }
}
