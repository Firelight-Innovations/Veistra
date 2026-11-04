import { describe, expect, it } from "vitest";
import { LineDashedMaterial, LineSegments, Mesh, MeshStandardMaterial } from "three";
import type { Group } from "three";
import { buildChangeScene, showClasses } from "./changeScene";
import { diffParts } from "./parts";
import { box, moved } from "./testShapes";

const palette = { added: "#3f76ff", changed: "#d98a3f", removed: "#e5736b", unchanged: "#888888" };
const cube = box([0, 0, 0], [1, 1, 1]);

function scene(): Group {
  const result = diffParts(
    [
      { name: "Frame", positions: cube },
      { name: "Leg", positions: moved(cube, 5, 0, 0) },
    ],
    [
      { name: "Frame", positions: cube },
      { name: "Pillow", positions: moved(cube, 0, 3, 0) },
    ],
  );
  return buildChangeScene(result, palette, 2);
}

describe("buildChangeScene", () => {
  it("has one child a class, named after it, in the legend's order", () => {
    expect(scene().children.map((c) => c.name)).toEqual([
      "added",
      "changed",
      "removed",
      "unchanged",
    ]);
  });

  it("draws Removed as a dashed outline over a faint fill, so a ghost is not a solid", () => {
    const removed = scene().getObjectByName("removed")!;
    const outline = removed.children.find((c) => c instanceof LineSegments) as LineSegments;
    expect(outline.material).toBeInstanceOf(LineDashedMaterial);
    expect(outline.geometry.getAttribute("lineDistance")).toBeDefined();
    const fill = removed.children.find((c) => c instanceof Mesh) as Mesh;
    expect((fill.material as { opacity: number }).opacity).toBeLessThan(0.5);
  });

  it("colours each class from the palette", () => {
    const added = scene().getObjectByName("added")!.children[0] as Mesh;
    expect((added.material as MeshStandardMaterial).color.getHexString()).toBe("3f76ff");
  });

  it("leaves an empty class with nothing to draw", () => {
    expect(scene().getObjectByName("changed")!.children).toHaveLength(0);
  });

  it("hatches Changed in screen pixels, scaled for the display", () => {
    const result = diffParts(
      [{ name: "Top", positions: cube }],
      [{ name: "Top", positions: moved(cube, 0, 0.01, 0) }],
    );
    const changed = buildChangeScene(result, palette, 2).getObjectByName("changed")!;
    const material = (changed.children[0] as Mesh).material as MeshStandardMaterial;
    const shader = {
      uniforms: {} as Record<string, { value: number }>,
      fragmentShader: "void main() {\n#include <color_fragment>\n}",
      vertexShader: "",
    };
    material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.uniforms.uHatch.value).toBe(12);
    expect(shader.fragmentShader).toContain("gl_FragCoord");
  });
});

describe("showClasses", () => {
  it("hides the classes switched off and only those", () => {
    const group = scene();
    showClasses(group, { added: true, changed: true, removed: false, unchanged: false });
    expect(group.children.map((c) => c.visible)).toEqual([true, true, false, false]);
  });
});
