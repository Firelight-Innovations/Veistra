/**
 * The three.js side of the viewer: renderer, camera, orbit controls, lights,
 * picking and disposal. Everything here needs a WebGL context, which is why it
 * is the one module the unit tests do not load; the logic worth testing lives
 * in `pose.ts`, `nodePath.ts`, `limits.ts`, `highlight.ts` and `debounce.ts`,
 * and this file only wires them to a renderer.
 *
 * Rendering is on demand. There is no animation loop: a frame is drawn when the
 * controls move, the selection changes, the size changes or the pane becomes
 * visible again, and never otherwise. An idle viewer costs nothing, and a
 * hidden one cannot burn a GPU. Orbit damping is off for the same reason, since
 * damping is the one feature that needs a frame nobody asked for.
 *
 * This is a preview, not the engine. glTF carries geometry, PBR materials,
 * cameras and punctual lights, and that is all we draw. Engine-side shaders,
 * post-processing, fog, sky, particles, animation, and light-unit conversion
 * are not reproduced, so brightness and colour will differ from Godot or
 * Blender. Draco, Meshopt and KTX2 compression are not decoded.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  MOUSE,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Material, Mesh, Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SelectionHighlight } from "./highlight";
import { capNotice, checkTriangleCap, countTriangles, hasPunctualLights } from "./limits";
import { findByPath } from "./nodePath";
import { frameBounds, poseFromCamera } from "./pose";
import { pickNode, projectPoint } from "./projection";
import type { CameraPose, PickHit, Vec3, ViewportPoint } from "./markupHost";
import { parseModel, type ModelSource } from "./formats";

export interface LoadedInfo {
  triangles: number;
  hasGltfCamera: boolean;
  hasGltfLights: boolean;
}

export type LoadResult =
  | { ok: true; info: LoadedInfo }
  | { ok: false; reason: "capped"; notice: string; triangles: number };

export interface EngineCallbacks {
  /** The camera came to rest, or was moved by the host. */
  onCameraChange?: (pose: CameraPose) => void;
  /** The user began orbiting, panning or zooming. Pairs with `onCameraChange`. */
  onInteractStart?: () => void;
}

const FALLBACK_FOV = 50;
const MAX_PIXEL_RATIO = 3;

/** Fill light strength, with and without lights authored in the scene. */
const HEMI_WITH_LIGHTS = 0.35;
const HEMI_WITHOUT_LIGHTS = 1.1;
const KEY_LIGHT = 2.2;

function resolveToken(el: Element, name: string): Color {
  const value = getComputedStyle(el).getPropertyValue(`--${name}`).trim();
  return new Color(value || "black");
}

export class SceneEngine {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FALLBACK_FOV, 1, 0.1, 1000);
  private controls: OrbitControls;
  private raycaster = new Raycaster();
  private highlight = new SelectionHighlight();
  private hemi = new HemisphereLight(0xffffff, 0x444444, HEMI_WITHOUT_LIGHTS);
  private key = new DirectionalLight(0xffffff, KEY_LIGHT);
  private root: Object3D | null = null;
  private home: CameraPose | null = null;
  private frameHandle: number | null = null;
  private animationHandle: number | null = null;
  private selection: { target: Object3D; tint: string } | null = null;
  private cameraListeners = new Set<(pose: CameraPose) => void>();
  private visible = true;
  private dirty = false;
  private disposed = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private themeObserver: MutationObserver | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: EngineCallbacks = {},
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.setPixelRatio(window.devicePixelRatio || 1);

    this.scene.background = resolveToken(canvas, "bg-surface-2");
    // The backdrop is a design token, not a fixed colour, so a light/dark
    // switch (`<html data-theme>`, set by the bridge) has to re-read it.
    if (typeof MutationObserver !== "undefined") {
      this.themeObserver = new MutationObserver(() => {
        this.scene.background = resolveToken(canvas, "bg-surface-2");
        this.requestRender();
      });
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }
    this.scene.add(this.hemi, this.key, this.key.target, this.camera);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.controls.addEventListener("change", this.requestRender);
    this.controls.addEventListener("end", this.emitCamera);
    this.controls.addEventListener("start", this.emitStart);
  }

  /**
   * Parses and adds a glb — or, given a `ModelSource`, any format `./formats`
   * reads. A scene over `maxTriangles` is parsed, counted and thrown away rather
   * than uploaded; the count is the only reason to have paid for the parse.
   * Calling `load` twice replaces the first scene.
   */
  async load(
    source: ArrayBuffer | string | ModelSource,
    maxTriangles: number,
    signal?: AbortSignal,
  ): Promise<LoadResult> {
    const gltf = await this.parse(source, signal);
    if (this.disposed || signal?.aborted) {
      disposeTree(gltf.scene);
      throw new DOMException("aborted", "AbortError");
    }

    const triangles = countTriangles(gltf.scene);
    const verdict = checkTriangleCap(triangles, maxTriangles);
    if (verdict.exceeded) {
      disposeTree(gltf.scene);
      return { ok: false, reason: "capped", notice: capNotice(verdict), triangles };
    }

    this.unloadScene();
    this.root = gltf.scene;
    this.scene.add(gltf.scene);
    gltf.scene.updateMatrixWorld(true);

    const hasLights = hasPunctualLights(gltf.scene);
    this.hemi.intensity = hasLights ? HEMI_WITH_LIGHTS : HEMI_WITHOUT_LIGHTS;
    this.key.visible = !hasLights;

    const authored = gltf.cameras.find((c): c is PerspectiveCamera => "isPerspectiveCamera" in c);
    this.home = authored ? this.poseFromAuthored(authored) : this.framedPose();
    this.applyPose(this.home);
    return { ok: true, info: { triangles, hasGltfCamera: !!authored, hasGltfLights: hasLights } };
  }

  /** A scene and its authored cameras. Only glTF carries cameras worth starting from. */
  private async parse(
    source: ArrayBuffer | string | ModelSource,
    signal?: AbortSignal,
  ): Promise<{ scene: Object3D; cameras: Object3D[] }> {
    if (typeof source === "string") {
      const data = await fetch(source, { signal }).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${source}`);
        return r.arrayBuffer();
      });
      return new GLTFLoader().parseAsync(data, "");
    }
    if (source instanceof ArrayBuffer) return new GLTFLoader().parseAsync(source, "");
    if (source.format === "glb" || source.format === "gltf") {
      return new GLTFLoader().parseAsync(source.bytes, "");
    }
    return { scene: await parseModel(source), cameras: [] };
  }

  /** Overrides the pose the view starts at and `resetView` returns to. */
  setHomePose(pose: CameraPose) {
    this.home = pose;
    this.applyPose(pose);
  }

  private bounds(obj: Object3D | null): Box3 {
    return obj ? new Box3().setFromObject(obj) : new Box3();
  }

  private aspect(): number {
    return this.width / Math.max(this.height, 1);
  }

  private framedPose(): CameraPose {
    const fov = FALLBACK_FOV;
    const framing = frameBounds(this.bounds(this.root), fov, this.aspect());
    return { position: framing.position, target: framing.target, fov, up: [0, 1, 0] };
  }

  /**
   * A glTF camera knows where it is and which way it faces, not what it looks
   * at, and orbit controls need a target. The nearest point on the view ray to
   * the scene's centre is the natural pivot: it keeps the framing the author
   * chose and orbits about the thing they were looking at.
   */
  private poseFromAuthored(cam: PerspectiveCamera): CameraPose {
    const base = poseFromCamera(cam, null);
    const position = new Vector3(...base.position);
    const forward = new Vector3(...base.target).sub(position).normalize();
    const center = this.bounds(this.root).getCenter(new Vector3());
    const t = Math.max(center.clone().sub(position).dot(forward), 1);
    const target = position.clone().addScaledVector(forward, t);
    return { ...base, target: [target.x, target.y, target.z] };
  }

  /** Puts the camera at `pose`. `emit` is false for the middle frames of an animation. */
  applyPose(pose: CameraPose, emit = true) {
    if (emit) this.cancelAnimation();
    this.camera.position.set(...pose.position);
    this.camera.up.set(...pose.up);
    this.camera.fov = pose.fov;
    this.controls.target.set(...pose.target);
    const dist = new Vector3(...pose.position).distanceTo(new Vector3(...pose.target));
    const radius = this.bounds(this.root).getSize(new Vector3()).length() / 2;
    this.camera.near = Math.max(dist / 1000, 1e-4);
    this.camera.far = Math.max(dist + radius * 20, dist * 10, 10);
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    if (emit) this.emitCamera();
    this.requestRender();
  }

  getPose(): CameraPose {
    return poseFromCamera(this.camera, this.controls.target);
  }

  resetView() {
    if (this.home) this.applyPose(this.home);
  }

  /**
   * Frames the node at `path`, or the whole scene when `path` is null. Keeps
   * the direction the camera is looking from, so framing does not spin the view.
   */
  frame(path: string | null) {
    const obj = path && this.root ? findByPath(this.root, path) : this.root;
    if (!obj) return;
    const box = this.bounds(obj);
    if (box.isEmpty()) return;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-12) dir.set(1, 0.7, 1);
    const framing = frameBounds(box, this.camera.fov, this.aspect(), dir);
    this.applyPose({
      position: framing.position,
      target: framing.target,
      fov: this.camera.fov,
      up: [this.camera.up.x, this.camera.up.y, this.camera.up.z],
    });
  }

  setSelected(path: string | null, tint: string) {
    this.highlight.clear();
    const target = path && this.root ? findByPath(this.root, path) : null;
    this.selection = target ? { target, tint } : null;
    if (target) this.highlight.apply(target, tint);
    this.requestRender();
  }

  hasNode(path: string): boolean {
    return !!this.root && findByPath(this.root, path) !== null;
  }

  /** Casts a ray through viewport pixel (x, y), origin at the element's top left. */
  pick(x: number, y: number): PickHit | null {
    if (!this.root) return null;
    return pickNode(this.root, this.camera, x, y, this.width, this.height, this.raycaster);
  }

  project(point: Vec3): ViewportPoint {
    return projectPoint(this.camera, point, this.width, this.height);
  }

  setOrbitEnabled(enabled: boolean) {
    this.controls.enabled = enabled;
  }

  /**
   * Eases to `pose` over `ms`. Draws its own frames for the duration and
   * nothing after, so it does not undermine render-on-demand. A second call,
   * or any other `applyPose`, cancels the first.
   */
  animateTo(pose: CameraPose, ms: number) {
    this.cancelAnimation();
    const from = this.getPose();
    const started = performance.now();
    const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
    const step = (now: number) => {
      const linear = Math.min((now - started) / ms, 1);
      const t = linear * linear * (3 - 2 * linear);
      const last = linear >= 1;
      this.applyPose(
        {
          position: lerp(from.position, pose.position, t),
          target: lerp(from.target, pose.target, t),
          up: pose.up,
          fov: from.fov + (pose.fov - from.fov) * t,
        },
        last,
      );
      this.animationHandle = last ? null : requestAnimationFrame(step);
    };
    this.animationHandle = requestAnimationFrame(step);
  }

  private cancelAnimation() {
    if (this.animationHandle !== null) cancelAnimationFrame(this.animationHandle);
    this.animationHandle = null;
  }

  /** Subscribes to camera-at-rest events. Returns the unsubscribe. */
  onCameraChange(cb: (pose: CameraPose) => void): () => void {
    this.cameraListeners.add(cb);
    return () => this.cameraListeners.delete(cb);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && this.dirty) this.requestRender();
  }

  /** Applies a size now. The host debounces; this does not. */
  resize(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  size(): { width: number; height: number; pixelRatio: number } {
    return { width: this.width, height: this.height, pixelRatio: this.pixelRatio };
  }

  private setPixelRatio(ratio: number) {
    this.pixelRatio = Math.min(Math.max(ratio, 1), MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(this.pixelRatio);
  }

  requestRender = () => {
    this.dirty = true;
    if (this.frameHandle !== null || this.disposed || !this.visible) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      this.renderNow();
    });
  };

  private emitStart = () => {
    this.cancelAnimation();
    this.callbacks.onInteractStart?.();
  };

  private emitCamera = () => {
    const pose = this.getPose();
    this.callbacks.onCameraChange?.(pose);
    for (const cb of this.cameraListeners) cb(pose);
  };

  private renderNow() {
    if (this.disposed) return;
    this.dirty = false;
    this.key.position.copy(this.camera.position).add(this.keyOffset());
    this.key.target.position.copy(this.controls.target);
    this.renderer.render(this.scene, this.camera);
  }

  /** Up and to the right of the view, so faces catch light. */
  private keyOffset(): Vector3 {
    const dist = this.camera.position.distanceTo(this.controls.target) || 1;
    return new Vector3(0.6, 0.9, 0.3).applyQuaternion(this.camera.quaternion).multiplyScalar(dist);
  }

  /**
   * A copy of the current frame, drawn now, at `scale` output pixels per CSS
   * pixel (default: the current pixel ratio). Rendering and copying happen in
   * one task, which is what keeps `preserveDrawingBuffer` off: the drawing
   * buffer is only guaranteed to hold the frame until the browser composites
   * it. A different `scale` resizes the buffer for the render and puts it
   * back, then redraws so the visible canvas is not left blank.
   */
  snapshot(scale?: number): HTMLCanvasElement {
    const wanted = scale ? Math.min(Math.max(scale, 0.25), MAX_PIXEL_RATIO) : this.pixelRatio;
    const changed = wanted !== this.pixelRatio;
    if (changed) {
      this.renderer.setPixelRatio(wanted);
      this.renderer.setSize(this.width, this.height, false);
    }
    // The selection tint is chrome, not scene: an export should show the scene.
    this.highlight.clear();
    this.renderNow();
    const out = document.createElement("canvas");
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    out.getContext("2d")?.drawImage(this.canvas, 0, 0);
    if (this.selection) this.highlight.apply(this.selection.target, this.selection.tint);
    if (changed) {
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(this.width, this.height, false);
    }
    this.renderNow();
    return out;
  }

  private unloadScene() {
    this.highlight.clear();
    if (this.root) {
      this.scene.remove(this.root);
      disposeTree(this.root);
      this.root = null;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.cancelAnimation();
    this.cameraListeners.clear();
    this.themeObserver?.disconnect();
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.removeEventListener("end", this.emitCamera);
    this.controls.removeEventListener("start", this.emitStart);
    this.controls.dispose();
    this.unloadScene();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

const TEXTURE_KEYS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "bumpMap",
  "displacementMap",
  "lightMap",
  "envMap",
];

function disposeMaterial(material: Material) {
  const bag = material as unknown as Record<string, unknown>;
  for (const key of TEXTURE_KEYS) {
    const tex = bag[key] as Texture | null | undefined;
    if (tex && (tex as { isTexture?: boolean }).isTexture) tex.dispose();
  }
  material.dispose();
}

/** Frees the GPU-side resources of everything under `root`. */
export function disposeTree(root: Object3D) {
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
  });
}
