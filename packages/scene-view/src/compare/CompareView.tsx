/**
 * `<CompareView>`: two versions of a model under one camera. In Changes it
 * draws the diff's classes; in Split it draws A left of a divider and B
 * right of it, both from the same viewpoint. The host owns the diff
 * (`useCompare`), the class toggles and the divider; this owns the canvas.
 *
 * The canvas is made imperatively for the reason `SceneView` gives: a fresh
 * one per engine is what survives StrictMode's second mount.
 */
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { debounce, RESIZE_DEBOUNCE_MS } from "../debounce";
import type { Vec3 } from "../markupHost";
import { compareGlbs } from "./client";
import type { CompareOutcome } from "./client";
import { CompareEngine, cssColor } from "./engine";
import type { CompareMode } from "./engine";
import type { Palette } from "./changeScene";
import { nudgeSplit } from "./split";
import type { ChangeClass, DiffResult } from "./types";
import "../scene-view.css";
import "./compare.css";

export interface CompareViewHandle {
  /** Moves the camera to frame a box, keeping the direction it looks from. */
  frameBox(min: Vec3, max: Vec3): void;
  frameAll(): void;
}

export interface CompareViewProps {
  /** The versions' glbs, for Split. */
  a: ArrayBuffer | null;
  b: ArrayBuffer | null;
  result: DiffResult | null;
  mode: CompareMode;
  shown: Record<ChangeClass, boolean>;
  /** The divider, as a fraction of the width from the left. */
  split: number;
  onSplitChange?: (fraction: number) => void;
  labels: { a: string; b: string };
  ref?: Ref<CompareViewHandle>;
  children?: ReactNode;
}

function palette(el: Element): Palette {
  return {
    added: cssColor(el, "accent-blue", "#3f76ff"),
    changed: cssColor(el, "accent-amber", "#d98a3f"),
    removed: cssColor(el, "accent-coral", "#e5736b"),
    unchanged: cssColor(el, "txt-tertiary", "#8a8a8a"),
  };
}

export function CompareView(props: CompareViewProps) {
  const { a, b, result, mode, shown, split, onSplitChange, labels, ref, children } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CompareEngine | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [splitUsed, setSplitUsed] = useState(mode === "split");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "sv-canvas";
    host.prepend(canvas);
    let engine: CompareEngine;
    try {
      engine = new CompareEngine(canvas);
    } catch (err) {
      canvas.remove();
      setFailed(err instanceof Error ? err.message : "WebGL is not available");
      return;
    }
    engineRef.current = engine;
    const apply = debounce((w: number, h: number) => engine.resize(w, h), RESIZE_DEBOUNCE_MS);
    let first = true;
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      if (first) engine.resize(rect.width, rect.height);
      else apply(rect.width, rect.height);
      first = false;
    });
    resizeObserver.observe(host);
    const seen = new IntersectionObserver((entries) => {
      engine.setVisible((entries[entries.length - 1]?.isIntersecting ?? true) && !document.hidden);
    });
    seen.observe(host);
    return () => {
      seen.disconnect();
      resizeObserver.disconnect();
      apply.cancel();
      engine.dispose();
      engineRef.current = null;
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host) engineRef.current?.setChanges(result, palette(host));
  }, [result]);

  useEffect(() => engineRef.current?.setShown(shown), [shown]);

  useEffect(() => {
    engineRef.current?.setMode(mode);
    if (mode === "split") setSplitUsed(true);
  }, [mode]);

  useEffect(() => engineRef.current?.setSplit(split), [split]);

  // The versions themselves, materials and all, only once Split is wanted.
  useEffect(() => {
    if (!splitUsed) return;
    const live = { current: true };
    for (const [side, bytes] of [
      ["a", a],
      ["b", b],
    ] as const) {
      engineRef.current?.setVersion(side, null);
      if (!bytes) continue;
      new GLTFLoader()
        .parseAsync(bytes.slice(0), "")
        .then((gltf) => {
          if (live.current) engineRef.current?.setVersion(side, gltf.scene);
        })
        .catch((err: unknown) => {
          if (live.current) setFailed(err instanceof Error ? err.message : String(err));
        });
    }
    return () => {
      live.current = false;
    };
  }, [a, b, splitUsed]);

  useImperativeHandle(
    ref,
    () => ({
      frameBox: (min, max) => engineRef.current?.frameBox(min, max),
      frameAll: () => engineRef.current?.frameAll(),
    }),
    [],
  );

  const pct = `${Math.round(split * 100)}%`;
  return (
    <div ref={hostRef} className="sv-root cv-root" data-mode={mode}>
      <div className="sv-overlay">{children}</div>
      {failed && (
        <div className="sv-status sv-status-error" role="alert">
          Could not show these versions: {failed}
        </div>
      )}
      {mode === "split" && (
        <>
          <span className="cv-label cv-label-a">{labels.a}</span>
          <span className="cv-label cv-label-b">{labels.b}</span>
          <div className="cv-divider" style={{ left: pct }} aria-hidden="false">
            <button
              type="button"
              className="sv-icon-btn cv-nudge"
              aria-label="Show more of B"
              title="Show more of B"
              onClick={() => onSplitChange?.(nudgeSplit(split, "b"))}
            >
              ‹
            </button>
            <button
              type="button"
              className="sv-icon-btn cv-nudge"
              aria-label="Show more of A"
              title="Show more of A"
              onClick={() => onSplitChange?.(nudgeSplit(split, "a"))}
            >
              ›
            </button>
          </div>
        </>
      )}
      <div className="sv-foot cv-foot">
        <span className="sv-chip">One camera for A and B. Orbit moves both.</span>
      </div>
    </div>
  );
}

export type CompareState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ready"; outcome: CompareOutcome }
  | { kind: "error"; message: string };

/** Diffs `a` against `b` whenever either changes, abandoning a diff that is overtaken. */
export function useCompare(a: ArrayBuffer | null, b: ArrayBuffer | null): CompareState {
  const [state, setState] = useState<CompareState>({ kind: "idle" });
  useEffect(() => {
    if (!a || !b) {
      setState({ kind: "idle" });
      return;
    }
    const abort = new AbortController();
    setState({ kind: "running" });
    compareGlbs(a, b, abort.signal).then(
      (outcome) => setState({ kind: "ready", outcome }),
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => abort.abort();
  }, [a, b]);
  return state;
}
