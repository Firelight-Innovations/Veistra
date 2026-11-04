/**
 * The renderer behind `<CompareView>`: one camera, one set of orbit
 * controls, and three things to draw with them, the change scene and the two
 * versions. Changes draws the change scene. Split draws A left of a divider
 * and B right of it in one frame, by scissor, so orbiting moves both and
 * there is no second camera to keep in step.
 *
 * Like `SceneEngine`, it draws on demand only, and it is the one compare
 * module the tests do not load, since it needs WebGL.
 */
import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  MOUSE,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { disposeTree } from "../engine";
import { frameBounds } from "../pose";
import type { Vec3 } from "../markupHost";
import { buildChangeScene, showClasses } from "./changeScene";
import type { Palette } from "./changeScene";
import type { ChangeClass, DiffResult } from "./types";

export type CompareMode = "changes" | "split";

const FOV = 50;
const MAX_PIXEL_RATIO = 3;
const DEFAULT_DIRECTION = new Vector3(1, 0.7, 1);

export function cssColor(el: Element, token: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(`--${token}`).trim() || fallback;
}

export class CompareEngine {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  private controls: OrbitControls;
  private key = new DirectionalLight(0xffffff, 2.2);
  private changes: Object3D | null = null;
  private versions: { a: Object3D | null; b: Object3D | null } = { a: null, b: null };
  private shown: Record<ChangeClass, boolean> | null = null;
  private mode: CompareMode = "changes";
  private split = 0.5;
  private framed = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private visible = true;
  private dirty = false;
  private frameHandle: number | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.scene.background = new Color(cssColor(canvas, "bg-surface-2", "#1e1e1e"));
    this.scene.add(new HemisphereLight(0xffffff, 0x444444, 1.1), this.key, this.key.target);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.controls.addEventListener("change", this.requestRender);
  }

  get scale(): number {
    return this.pixelRatio;
  }

  /** Replaces the change scene. `null` clears it. */
  setChanges(result: DiffResult | null, palette: Palette) {
    if (this.changes) {
      this.scene.remove(this.changes);
      disposeTree(this.changes);
    }
    this.changes = result ? buildChangeScene(result, palette, this.pixelRatio) : null;
    if (this.changes) {
      if (this.shown) showClasses(this.changes, this.shown);
      this.scene.add(this.changes);
    }
    this.frameOnce();
    this.requestRender();
  }

  /** The two versions as loaded for Split. Either may be `null` while it loads. */
  setVersion(side: "a" | "b", root: Object3D | null) {
    const old = this.versions[side];
    if (old) {
      this.scene.remove(old);
      disposeTree(old);
    }
    this.versions[side] = root;
    if (root) this.scene.add(root);
    this.frameOnce();
    this.requestRender();
  }

  setShown(shown: Record<ChangeClass, boolean>) {
    this.shown = shown;
    if (this.changes) showClasses(this.changes, shown);
    this.requestRender();
  }

  setMode(mode: CompareMode) {
    this.mode = mode;
    this.requestRender();
  }

  /** Where the divider sits, as a fraction of the width from the left. */
  setSplit(fraction: number) {
    this.split = fraction;
    this.requestRender();
  }

  private everything(): Box3 {
    const box = new Box3();
    for (const obj of [this.changes, this.versions.a, this.versions.b]) {
      if (obj) box.union(new Box3().setFromObject(obj));
    }
    return box;
  }

  /** The first content to arrive sets the view; later loads keep the user's. */
  private frameOnce() {
    if (this.framed) return;
    const box = this.everything();
    if (box.isEmpty()) return;
    this.framed = true;
    this.frameBox(box.min.toArray() as Vec3, box.max.toArray() as Vec3, DEFAULT_DIRECTION);
  }

  /** Frames a box, from the direction the camera already looks along. */
  frameBox(min: Vec3, max: Vec3, direction?: Vector3) {
    const box = new Box3(new Vector3(...min), new Vector3(...max));
    const dir = direction ?? this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-12) dir.copy(DEFAULT_DIRECTION);
    const framing = frameBounds(box, FOV, this.width / this.height, dir);
    this.camera.position.set(...framing.position);
    this.controls.target.set(...framing.target);
    const radius = this.everything().getSize(new Vector3()).length() / 2;
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(dist / 1000, 1e-4);
    this.camera.far = Math.max(dist + radius * 20, dist * 10, 10);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  frameAll() {
    const box = this.everything();
    if (!box.isEmpty()) this.frameBox(box.min.toArray() as Vec3, box.max.toArray() as Vec3);
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && this.dirty) this.requestRender();
  }

  requestRender = () => {
    this.dirty = true;
    if (this.frameHandle !== null || this.disposed || !this.visible) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      this.render();
    });
  };

  private only(obj: Object3D | null) {
    for (const o of [this.changes, this.versions.a, this.versions.b]) {
      if (o) o.visible = o === obj;
    }
  }

  private render() {
    if (this.disposed) return;
    this.dirty = false;
    const dist = this.camera.position.distanceTo(this.controls.target) || 1;
    const offset = new Vector3(0.6, 0.9, 0.3).applyQuaternion(this.camera.quaternion);
    this.key.position.copy(this.camera.position).addScaledVector(offset, dist);
    this.key.target.position.copy(this.controls.target);

    if (this.mode === "changes") {
      this.only(this.changes);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const left = Math.round(this.width * this.split);
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(0, 0, left, this.height);
    this.only(this.versions.a);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissor(left, 0, this.width - left, this.height);
    this.only(this.versions.b);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.dispose();
    for (const o of [this.changes, this.versions.a, this.versions.b]) if (o) disposeTree(o);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
