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

  it("counts the role-less popovers and the surfaces that cover the whole tool window", () => {
    document.body.innerHTML = `
      <div class="toolhealth__popover" id="health"></div>
      <div class="hamburger__dropdown" id="hamburger"></div>
      <div class="menu-list__beside" data-menu-surface id="beside"></div>
      <div class="toolwindow__surface" data-solo id="takeover"></div>
      <div class="toolwindow__surface" id="pane-surface"></div>
      <div class="frame__page-expanded" id="expanded"></div>
      <div class="frame__page" id="docked"></div>`;
    const ids = ["health", "hamburger", "beside", "takeover", "pane-surface", "expanded", "docked"];
    ids.forEach((id, i) => box(document.getElementById(id)!, i, 0, 10, 10));
    // A pane's own surface and a docked page sit beside the game, not over it.
    expect(visibleOverlays(document.body).map((r) => r.x)).toEqual([0, 1, 2, 3, 5]);
  });

  // A modal's sheet may sit clear of a game in a lower or side pane while its
  // scrim dims the whole window: the scrim is what covers the game then.
  it("counts every full-window scrim, not only the sheet on it", () => {
    const scrims = [
      "palette",
      "k-dialog-scrim",
      "settings__backdrop",
      "shortcuts__backdrop",
      "library__backdrop",
    ];
    document.body.innerHTML = scrims.map((c) => `<div class="${c}" id="${c}"></div>`).join("");
    scrims.forEach((id, i) => box(document.getElementById(id)!, i, 0, 1200, 800));
    expect(visibleOverlays(document.body).map((r) => r.x)).toEqual([0, 1, 2, 3, 4]);
  });

  // The drop highlight covers the whole pane under a dragged tab, the game's
  // box included, though the ghost itself is elsewhere.
  it("counts where a dragged tab would drop, its hint and the detach outline", () => {
    document.body.innerHTML = `
      <span class="pane__drop" id="drop"><span class="pane__drop-label">Split right</span></span>
      <span class="pane__drop pane__drop--edge" id="edge"></span>
      <div class="drag-hint" id="hint"></div>
      <div class="drag-detach-outline" id="outline"></div>
      <span class="pane__drop-label" id="label-alone"></span>`;
    ["drop", "edge", "hint", "outline", "label-alone"].forEach((id, i) =>
      box(document.getElementById(id)!, i, 0, 300, 200),
    );
    // A label is inside its drop, which already counts.
    expect(visibleOverlays(document.body).map((r) => r.x)).toEqual([0, 1, 2, 3]);
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

  it("sees a surface take over the window when only its data-solo changes", async () => {
    // Home already mounted in a pane, then shown from the cluster chip: the
    // same element gains `data-solo` and nothing else this watch listens for.
    document.body.innerHTML = `<div class="toolwindow__surface" id="home"></div>`;
    const home = document.getElementById("home")!;
    box(home, 0, 0, 1200, 800);
    const seen: number[] = [];
    const stop = watchOverlays((rects) => seen.push(rects.length));
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    await frame();

    home.setAttribute("data-solo", "true");
    await frame();
    await frame();
    home.removeAttribute("data-solo");
    await frame();
    await frame();
    stop();

    expect(seen).toEqual([1, 0]);
  });
});
