/**
 * `<SceneView>`: an orbitable three.js preview of a glb.
 *
 * The component is the React shell around `SceneEngine`. It owns the DOM the
 * engine cannot (sizing, visibility, toolbar, keyboard) and exposes the engine
 * to a markup layer through the `SceneViewHandle` contract in `markupHost.ts`.
 * Markup itself is not drawn here: `@veistra/markup` mounts as `children`, inside
 * this box, and drives the camera, picking and capture through the handle.
 *
 * The canvas is created imperatively, not rendered by React. A WebGL context
 * cannot be recovered after `forceContextLoss`, and StrictMode mounts, unmounts
 * and remounts every effect; a fresh canvas per engine is what makes the second
 * mount work.
 *
 * The handle is passed as the `ref` prop, which is what `forwardRef` is in
 * React 19 (this repository is on 19), so there is no wrapper to unwrap.
 */
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Focus, RotateCcw } from "lucide-react";
import { debounce, RESIZE_DEBOUNCE_MS } from "./debounce";
import { SceneEngine } from "./engine";
import type { LoadedInfo } from "./engine";
import { DEFAULT_MAX_TRIANGLES } from "./limits";
import type { ModelSource } from "./formats";
import type { CameraPose, SceneViewHandle } from "./markupHost";
import "./scene-view.css";

export interface SceneViewProps {
  /**
   * A glb, as bytes or as a URL the webview can fetch — or another format's
   * bytes with the format named (see `./formats`). Keep the object stable
   * across renders: a new one reloads the scene.
   */
  source: ArrayBuffer | string | ModelSource;
  /** Starting view. Without it: the glTF's first camera, else the scene's bounds. */
  initialPose?: CameraPose;
  /** Node path such as "Main/Chair/Leg3". `null` clears; leave undefined to let clicks decide. */
  selectedPath?: string | null;
  onSelect?: (path: string | null) => void;
  /** Called when the camera comes to rest after a move, and after programmatic moves. */
  onCameraChange?: (pose: CameraPose) => void;
  onLoad?: (info: LoadedInfo) => void;
  onError?: (message: string) => void;
  /** Scenes over this are not loaded. Zero disables the check. */
  maxTriangles?: number;
  /**
   * While true, renderer resizes are held back. The shell has no splitter-drag
   * signal a nested app can read yet, so today this is for hosts that do; the
   * debounce covers the rest.
   */
  resizeHold?: boolean;
  /**
   * Rendered over the canvas, absolutely positioned and the same size. The slot
   * itself ignores the pointer; a child opts in with `pointer-events: auto`.
   */
  children?: ReactNode;
  ref?: Ref<SceneViewHandle>;
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "capped"; notice: string }
  | { kind: "error"; message: string };

const CLICK_SLOP_PX = 4;
const ANIMATE_MS = 220;

/** Returned before a scene exists, so the handle never has to hand back `null`. */
const NO_POSE: CameraPose = { position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 50 };

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function blobOf(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"),
  );
}

export function SceneView(props: SceneViewProps) {
  const {
    source,
    initialPose,
    selectedPath,
    onSelect,
    onCameraChange,
    onLoad,
    onError,
    maxTriangles = DEFAULT_MAX_TRIANGLES,
    resizeHold = false,
    children,
    ref,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SceneEngine | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [loadedVersion, setLoadedVersion] = useState(0);
  const [selection, setSelection] = useState<string | null>(selectedPath ?? null);
  const [visible, setVisible] = useState(true);

  const latest = useRef({ onCameraChange, onSelect, onLoad, onError, initialPose });
  latest.current = { onCameraChange, onSelect, onLoad, onError, initialPose };
  const interactive = useRef(true);
  const holdRef = useRef(resizeHold);
  const deferred = useRef<{ w: number; h: number } | null>(null);
  const listeners = useRef(new Set<(pose: CameraPose) => void>());

  // The engine, its canvas, and everything that watches the host element.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "sv-canvas";
    host.prepend(canvas);

    let engine: SceneEngine;
    try {
      engine = new SceneEngine(canvas, {
        onCameraChange: (pose) => {
          latest.current.onCameraChange?.(pose);
          for (const cb of listeners.current) cb(pose);
        },
      });
    } catch (err) {
      canvas.remove();
      const message = err instanceof Error ? err.message : "WebGL is not available";
      setStatus({ kind: "error", message });
      latest.current.onError?.(message);
      return;
    }
    engineRef.current = engine;

    const apply = debounce((w: number, h: number) => {
      if (holdRef.current) deferred.current = { w, h };
      else engine.resize(w, h);
    }, RESIZE_DEBOUNCE_MS);
    let first = true;
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      if (first) {
        first = false;
        engine.resize(rect.width, rect.height);
      } else {
        apply(rect.width, rect.height);
      }
    });
    resizeObserver.observe(host);

    // Nothing draws while the pane is off screen; coming back draws once.
    const seen = new IntersectionObserver((entries) => {
      const shown = entries[entries.length - 1]?.isIntersecting ?? true;
      engine.setVisible(shown && !document.hidden);
      setVisible(shown);
    });
    seen.observe(host);
    const onDocVisibility = () => engine.setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onDocVisibility);

    const selectNode = (path: string | null) => {
      setSelection(path);
      latest.current.onSelect?.(path);
    };
    const pickAt = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return engine.pick(e.clientX - rect.left, e.clientY - rect.top);
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || e.button !== 0 || !interactive.current) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;
      selectNode(pickAt(e)?.nodePath ?? null);
    };
    const onDouble = (e: MouseEvent) => {
      if (!interactive.current) return;
      const path = pickAt(e)?.nodePath ?? null;
      selectNode(path);
      engine.frame(path);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDouble);

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("dblclick", onDouble);
      document.removeEventListener("visibilitychange", onDocVisibility);
      seen.disconnect();
      resizeObserver.disconnect();
      apply.cancel();
      engine.dispose();
      engineRef.current = null;
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    holdRef.current = resizeHold;
    const pending = deferred.current;
    if (!resizeHold && pending) {
      deferred.current = null;
      engineRef.current?.resize(pending.w, pending.h);
    }
  }, [resizeHold]);

  // Load, and reload when the glb changes.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const abort = new AbortController();
    setStatus({ kind: "loading" });
    engine
      .load(source, maxTriangles, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        if (!result.ok) {
          setStatus({ kind: "capped", notice: result.notice });
          latest.current.onError?.(result.notice);
          return;
        }
        if (latest.current.initialPose) engine.setHomePose(latest.current.initialPose);
        setStatus({ kind: "ready" });
        setLoadedVersion((v) => v + 1);
        latest.current.onLoad?.(result.info);
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message });
        latest.current.onError?.(message);
      });
    return () => abort.abort();
  }, [source, maxTriangles]);

  useEffect(() => {
    if (selectedPath !== undefined) setSelection(selectedPath);
  }, [selectedPath]);

  useEffect(() => {
    const host = hostRef.current;
    const engine = engineRef.current;
    if (!host || !engine || loadedVersion === 0) return;
    const tint = getComputedStyle(host).getPropertyValue("--accent").trim() || "white";
    engine.setSelected(selection, tint);
  }, [selection, loadedVersion]);

  useImperativeHandle(
    ref,
    () => ({
      getCamera: () => engineRef.current?.getPose() ?? NO_POSE,
      setCamera: (pose, opts) => {
        const engine = engineRef.current;
        if (!engine) return;
        if (opts?.animate && !prefersReducedMotion()) engine.animateTo(pose, ANIMATE_MS);
        else engine.applyPose(pose);
      },
      setInteractive: (enabled) => {
        interactive.current = enabled;
        engineRef.current?.setOrbitEnabled(enabled);
      },
      pick: (x, y) => engineRef.current?.pick(x, y) ?? null,
      project: (point) => engineRef.current?.project(point) ?? { x: 0, y: 0, visible: false },
      capture: async (opts) => {
        const engine = engineRef.current;
        if (!engine) throw new Error("The scene is not ready to capture");
        return blobOf(engine.snapshot(opts?.scale));
      },
      viewportSize: () => {
        const { width, height } = engineRef.current?.size() ?? { width: 0, height: 0 };
        return { width, height };
      },
      onCameraChange: (cb) => {
        listeners.current.add(cb);
        return () => {
          listeners.current.delete(cb);
        };
      },
    }),
    [],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey || !interactive.current) return;
    const key = e.key.toLowerCase();
    if (key === "f") engineRef.current?.frame(selection);
    else if (key === "escape" && selection) {
      setSelection(null);
      onSelect?.(null);
    }
  };

  return (
    <div
      ref={hostRef}
      className="sv-root"
      tabIndex={0}
      data-visible={visible}
      onKeyDown={onKeyDown}
    >
      <div className="sv-overlay">{children}</div>

      {status.kind === "loading" && <div className="sv-status">Loading scene</div>}
      {status.kind === "capped" && (
        <div className="sv-status sv-status-warn" role="alert">
          {status.notice}
        </div>
      )}
      {status.kind === "error" && (
        <div className="sv-status sv-status-error" role="alert">
          Could not show this scene: {status.message}
        </div>
      )}

      {status.kind === "ready" && (
        <div className="sv-toolbar" role="toolbar" aria-label="Scene view">
          <IconButton label="Reset view" onClick={() => engineRef.current?.resetView()}>
            <RotateCcw size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label="Frame selection (F)"
            onClick={() => engineRef.current?.frame(selection)}
          >
            <Focus size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
      )}

      {status.kind === "ready" && (
        <div className="sv-foot">
          {selection && <span className="sv-chip sv-path">{selection}</span>}
          <span
            className="sv-chip"
            title="Rendered with three.js from the exported glTF. Lighting, tone mapping, shaders and engine effects differ from Godot or Blender."
          >
            Approximate preview
          </span>
        </div>
      )}
    </div>
  );
}

interface IconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
}

function IconButton({ label, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      className="sv-icon-btn"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
