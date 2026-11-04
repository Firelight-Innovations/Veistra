// @vitest-environment jsdom
/**
 * Marking up locks the camera and Done gives it back. three.js needs WebGL, so
 * the SceneView and the markup layer are stand-ins; what is under test is the
 * view's own promise about the camera, not the renderer.
 */
import { forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  setInteractive: vi.fn(),
  exported: vi.fn(),
}));

const HANDLE = vi.hoisted(() => ({
  getCamera: () => ({ position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 50 }),
  setInteractive: (v: boolean) => h.setInteractive(v),
}));

vi.mock("@veistra/scene-view", () => ({
  SceneView: forwardRef(function Fake({ children }: { children?: ReactNode }, ref) {
    // Stable: a handle that changes every render would be set again every render.
    useImperativeHandle(ref, () => HANDLE, []);
    return <div>{children}</div>;
  }),
}));

vi.mock("@veistra/markup", () => ({
  sceneHost: () => ({}),
  poseMatches: () => true,
}));

vi.mock("@veistra/markup/layer", () => ({
  MarkupLayer: ({
    active,
    onActiveChange,
    onController,
  }: {
    active: boolean;
    onActiveChange: (next: boolean) => void;
    onController: (c: unknown) => void;
  }) => {
    onController({ exportMarkup: h.exported });
    return active ? (
      <button type="button" onClick={() => onActiveChange(false)}>
        Done
      </button>
    ) : null;
  },
}));

import Scene3D from "./Scene3D";
import { MarkupButton, type MarkupTrigger } from "../../../shared/MarkupTrigger";

const lookup = { toView: (p: string | null) => p, toScene: (p: string | null) => p };

/** The view beside the toolbar button it reports to, as Editor mode holds them. */
function WithButton({ onMarkup, onNotice }: { onMarkup: () => void; onNotice: () => void }) {
  const [trigger, setTrigger] = useState<MarkupTrigger | null>(null);
  return (
    <>
      <MarkupButton trigger={trigger} />
      <Scene3D
        glb={new ArrayBuffer(0)}
        lookup={lookup}
        glbPath="C:/p/.veistra/preview/godot/main.glb"
        scenePath="res://main.tscn"
        godot={null}
        selected={null}
        onSelect={vi.fn()}
        onMarkup={onMarkup}
        onNotice={onNotice}
        onTrigger={setTrigger}
      />
    </>
  );
}

function mount(onMarkup = vi.fn(), onNotice = vi.fn()) {
  render(<WithButton onMarkup={onMarkup} onNotice={onNotice} />);
  return { onMarkup, onNotice };
}

beforeEach(() => {
  h.setInteractive.mockReset();
  h.exported.mockReset();
});
afterEach(cleanup);

describe("Scene3D camera lock", () => {
  it("is unlocked at rest, locked while marking, and unlocked again after Done", async () => {
    h.exported.mockResolvedValue({
      png: new Blob(),
      json: { pins: [{ n: 1, note: "x" }], annotations: [] },
    });
    const { onMarkup } = mount();
    await waitFor(() => expect(h.setInteractive).toHaveBeenLastCalledWith(true));

    fireEvent.click(await screen.findByRole("button", { name: /Mark up/ }));
    await waitFor(() => expect(h.setInteractive).toHaveBeenLastCalledWith(false));
    expect(screen.getByText(/camera is locked/i)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.setInteractive).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(onMarkup).toHaveBeenCalledTimes(1));
  });

  it("says nothing was drawn, and unlocks, when Done finds an empty drawing", async () => {
    h.exported.mockResolvedValue({ png: new Blob(), json: { pins: [], annotations: [] } });
    const { onMarkup, onNotice } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Mark up/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Nothing was drawn/)),
    );
    expect(onMarkup).not.toHaveBeenCalled();
    expect(h.setInteractive).toHaveBeenLastCalledWith(true);
  });
});
