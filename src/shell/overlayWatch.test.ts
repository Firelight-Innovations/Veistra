// @vitest-environment jsdom
/**
 * The overlay watch. jsdom does no layout, so boxes are given by stubbing
 * `getBoundingClientRect`; what is tested is which elements count, the
 * open/close events, and the overlap rule the Play pane uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { intersects, sameRects, visibleOverlays, watchOverlays } from "./overlayWatch";

function box(el: Element, x: number, y: number, width: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("visibleOverlays", () => {
  it("counts menus, dialogs and the drag ghost, and skips hidden or empty ones", () => {
    document.body.innerHTML = `
      <div role="menu" id="m"></div>
      <div role="dialog" id="d" hidden></div>
      <div class="drag-ghost" id="g"></div>
      <div role="tooltip" id="t"></div>
      <div id="plain"></div>`;
    box(document.getElementById("m")!, 10, 10, 100, 50);
    box(document.getElementById("d")!, 0, 0, 500, 500);
    box(document.getElementById("g")!, 40, 40, 80, 20);
    box(document.getElementById("t")!, 0, 0, 0, 0);
    box(document.getElementById("plain")!, 0, 0, 900, 900);
    expect(visibleOverlays(document.body)).toEqual([
      { x: 10, y: 10, width: 100, height: 50 },
      { x: 40, y: 40, width: 80, height: 20 },
    ]);
  });
});

describe("intersects", () => {
  it("is overlap by area, not touching edges", () => {
    const game = { x: 100, y: 100, width: 400, height: 300 };
    expect(intersects(game, { x: 450, y: 350, width: 100, height: 100 })).toBe(true);
    expect(intersects(game, { x: 500, y: 100, width: 50, height: 50 })).toBe(false);
    expect(intersects(game, { x: 0, y: 0, width: 50, height: 50 })).toBe(false);
  });
});

describe("watchOverlays", () => {
  it("reports changes and dispatches open then close", async () => {
    const seen: number[] = [];
    const events: string[] = [];
    const onOpen = () => events.push("open");
    const onClose = () => events.push("close");
    window.addEventListener("veistra:overlay-open", onOpen);
    window.addEventListener("veistra:overlay-close", onClose);
    const stop = watchOverlays((rects) => seen.push(rects.length));
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    await frame();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    box(menu, 0, 0, 10, 10);
    document.body.appendChild(menu);
    await frame();
    await frame();
    menu.remove();
    await frame();
    await frame();
    stop();
    window.removeEventListener("veistra:overlay-open", onOpen);
    window.removeEventListener("veistra:overlay-close", onClose);

    expect(seen).toEqual([1, 0]);
    expect(events).toEqual(["open", "close"]);
    expect(sameRects([], [])).toBe(true);
  });
});
