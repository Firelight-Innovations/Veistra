// @vitest-environment jsdom
/**
 * The Model tab's states: nothing to show offers Export instead of an empty
 * canvas, a stale export is shown but cannot be marked up, and a ready one
 * mounts the shared 3D stage with the glb and the part selection. three.js needs
 * WebGL, so the stage is a stand-in that reports what it was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ getGlb: vi.fn(), scene: vi.fn() }));

vi.mock("./rpc", () => ({ getGlb: h.getGlb }));
vi.mock("../../../shared/MarkupScene", () => ({
  default: (props: Record<string, unknown>) => {
    h.scene(props);
    return (
      <button type="button" onClick={() => (props.onSelect as (p: string) => void)("Bed/Frame")}>
        stage
      </button>
    );
  },
}));

import ModelPreview, { STALE_MARKUP_NOTE, type ModelPreviewProps } from "./ModelPreview";

const parts = [
  { name: "Bed", kind: "empty", parent: null },
  { name: "Frame", kind: "mesh", parent: "Bed" },
] as unknown as ModelPreviewProps["parts"];

const lastProps = () =>
  h.scene.mock.calls[h.scene.mock.calls.length - 1]![0] as Record<string, unknown>;

function mount(over: Partial<ModelPreviewProps> = {}) {
  const props: ModelPreviewProps = {
    blend: "C:/p/bed.blend",
    rel: "bed.blend",
    model: "C:/p/.veistra/blender/bed/model.glb",
    exportedAt: 1,
    blenderVersion: "4.2",
    stale: false,
    parts,
    selected: null,
    onSelect: vi.fn(),
    onMarkup: vi.fn(),
    onNotice: vi.fn(),
    onTrigger: vi.fn(),
    canExport: true,
    onExport: vi.fn(),
    ...over,
  };
  render(<ModelPreview {...props} />);
  return props;
}

beforeEach(() => {
  h.getGlb.mockReset();
  h.scene.mockReset();
  h.getGlb.mockResolvedValue({ base64: "QUJD", size: 3 });
});
afterEach(cleanup);

describe("ModelPreview", () => {
  it("offers Export, not an empty canvas, when the export made no glb", () => {
    const props = mount({ model: null });
    expect(screen.queryByText("stage")).toBeNull();
    expect(h.getGlb).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(props.onExport).toHaveBeenCalledTimes(1);
  });

  it("disables Export while Blender is busy or missing", () => {
    mount({ model: null, canExport: false });
    expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("mounts the stage with the glb, its source and the part selection", async () => {
    const props = mount({ selected: "Frame" });
    await screen.findByText("stage");
    expect(h.getGlb).toHaveBeenCalledWith("C:/p/bed.blend");
    const given = lastProps();
    expect(given.glbPath).toBe("C:/p/.veistra/blender/bed/model.glb");
    expect(given.extra).toEqual({ engine: "blender", blend: "bed.blend", blender: "4.2" });
    expect(given.selectedPath).toBe("Bed/Frame");
    expect(given.markupDisabled).toBeNull();
    expect(given.onTrigger).toBe(props.onTrigger);
    // A pick in the 3D view comes back as the part name.
    fireEvent.click(screen.getByText("stage"));
    expect(props.onSelect).toHaveBeenCalledWith("Frame");
  });

  it("shows a stale export, offers Re-export, and turns marking up off", async () => {
    const props = mount({ stale: true });
    await screen.findByText("stage");
    expect(screen.getByText(/changed after this export/)).toBeTruthy();
    expect(lastProps()).toMatchObject({ markupDisabled: STALE_MARKUP_NOTE });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(props.onExport).toHaveBeenCalled();
  });

  it("says why the model could not load, and can try again or export", async () => {
    h.getGlb.mockRejectedValueOnce(new Error("could not read model.glb"));
    mount();
    await screen.findByText(/could not read model\.glb/);
    expect(screen.queryByText("stage")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("stage");
    expect(h.getGlb).toHaveBeenCalledTimes(2);
  });

  it("does not fetch the model again for an unchanged export, but does for a new one", async () => {
    const base = mount();
    await screen.findByText("stage");
    cleanup();
    h.getGlb.mockClear();
    const { rerender } = render(<ModelPreview {...base} />);
    await screen.findByText("stage");
    rerender(<ModelPreview {...base} parts={[...parts]} />);
    expect(h.getGlb).toHaveBeenCalledTimes(1);
    rerender(<ModelPreview {...base} exportedAt={2} />);
    await waitFor(() => expect(h.getGlb).toHaveBeenCalledTimes(2));
  });
});
