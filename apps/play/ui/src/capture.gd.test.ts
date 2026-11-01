/**
 * Structure checks for the capture addon, `src-tauri/src/godot/veistra_capture.gd`.
 * No Godot runs in CI, so these pin the mechanism each fix to the script
 * uses, the way `narrow.css.test.ts` pins declarations that jsdom cannot lay
 * out. What the engine then does rests on the API facts the script's own
 * comments name; these only stop the mechanism from quietly going away.
 */
import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the app tsconfig carries no Node types.
import script from "../../../../src-tauri/src/godot/veistra_capture.gd?raw";

/** One function, from its `func` line to the next line that starts at column zero. */
function fn(name: string): string {
  const start = script.indexOf(`\nfunc ${name}(`);
  expect(start, `func ${name} is missing`).toBeGreaterThanOrEqual(0);
  const rest = script.slice(start + 1);
  const end = rest.search(/\n(?=\S)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Without its comment lines, which name the calls the code avoids. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("the capture addon", () => {
  it("runs its timers on the wall clock, which Engine.time_scale does not slow", () => {
    const body = fn("_process");
    expect(body).toContain("Time.get_ticks_usec()");
    expect(body).not.toMatch(/\+=\s*_?delta\b/);
  });

  it("reports the longest frame since the last tick, not the one it lands on", () => {
    const body = fn("_process");
    expect(body).toContain("_frame_ms = maxf(_frame_ms,");
    expect(body).toMatch(/_tick\(\)\s+_frame_ms = 0\.0/);
  });

  it("goes back in front of the game every frame and when a node joins the root", () => {
    expect(fn("_process")).toMatch(/^\t_to_front\(\)\r?$/m);
    expect(script).toContain("node_added.connect(_on_node_added)");
    expect(fn("_on_node_added")).toContain("_to_front.call_deferred()");
  });

  it("projects corners only for the nearest candidates, up to the cap, and times itself", () => {
    const body = fn("_tracked_rects");
    const sorted = body.indexOf("near.sort()");
    expect(sorted).toBeGreaterThan(0);
    expect(body.indexOf("_project_box(")).toBeGreaterThan(sorted);
    expect(body).toContain("if out.size() >= MAX_NODES:");
    expect(code(body)).not.toContain("sort_custom");
    expect(fn("_tick")).toContain('"tickUs": _tick_usec');
  });

  it("measures colliders from their shapes' own sizes and never builds a debug mesh", () => {
    expect(code(script)).not.toContain("get_debug_mesh");
    for (const shape of ["BoxShape3D", "SphereShape3D", "CapsuleShape3D", "CylinderShape3D"]) {
      expect(fn("_shape_box")).toContain(`shape is ${shape}`);
    }
  });

  it("gives every tracked node a box, whatever its kind", () => {
    const body = fn("_local_box");
    for (const kind of ["Node3D", "AnimatedSprite2D", "Control", "Node2D"]) {
      expect(body).toContain(`node is ${kind}`);
    }
  });

  it("tells the page where in the window the viewport is drawn", () => {
    const body = fn("_tick");
    expect(body).toContain('"window": [win.size.x, win.size.y]');
    expect(body).toContain('"content": [int(content.position.x)');
  });

  it("scales a pick from the capture's pixels into the visible rect before casting", () => {
    const body = fn("_pick");
    const scaled = body.indexOf("var at := on_capture * visible / shot");
    expect(scaled).toBeGreaterThan(0);
    expect(body.indexOf("project_ray_origin(at)")).toBeGreaterThan(scaled);
    expect(fn("_capture")).toContain("_capture_size = ");
  });

  it("uses nothing Godot 4.0 lacks", () => {
    // Vector2.min and max do not exist in 4.0; minf and maxf are global.
    expect(code(script)).not.toMatch(/\.(min|max)\(/);
    // Integer stretch arrived in 4.2, so its property is only read by name.
    expect(script).toContain('win.get("content_scale_stretch")');
    expect(code(script)).not.toMatch(/\.content_scale_stretch|CONTENT_SCALE_STRETCH/);
  });
});
