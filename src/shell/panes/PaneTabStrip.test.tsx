// @vitest-environment jsdom
/**
 * What a pane tab wears: a File Viewer is one file and looks like it — the
 * file's icon, its path as the tooltip, a dot when it has unsaved edits — while
 * any other app keeps the generic glyph and no colour square.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ClusterMember } from "../contract";
import { resetSubjectsForTest, setSubject } from "../viewerSubjects";
import PaneTabStrip from "./PaneTabStrip";
import stripSource from "./PaneTabStrip.tsx?raw";

beforeEach(() => {
  window.localStorage.clear();
  resetSubjectsForTest();
});
afterEach(cleanup);

const member = (over: Partial<ClusterMember>): ClusterMember => ({
  id: "viewer-1",
  dragId: "viewer-1",
  title: "main.rs",
  kind: "app",
  appId: "viewer",
  paneId: "p1",
  showing: true,
  agentFinished: false,
  ...over,
});

function stripOf(members: ClusterMember[]) {
  return (
    <PaneTabStrip paneId="p1" members={members} caret={null} onSelect={vi.fn()} onClose={vi.fn()} />
  );
}

function strip(members: ClusterMember[]) {
  return render(stripOf(members));
}

describe("a File Viewer tab", () => {
  it("shows the file's icon and its full path as the tooltip", () => {
    setSubject("viewer-1", { path: "C:\\p\\src\\main.rs", preview: false, dirty: false });
    const { container } = strip([member({})]);
    const icon = container.querySelector<HTMLImageElement>("img.pane-tab__fileicon");
    expect(icon?.getAttribute("src")).toMatch(/^\/icons\/material\/.+\.svg$/);
    expect(container.querySelector(".pane-tab")?.getAttribute("title")).toBe("C:\\p\\src\\main.rs");
    expect(container.querySelector(".pane-tab__swatch")).toBeNull();
  });

  it("marks unsaved edits, and updates when the viewer reports them", () => {
    setSubject("viewer-1", { path: "/p/a.ts", preview: false, dirty: false });
    const { container } = strip([member({ title: "a.ts" })]);
    expect(container.querySelector(".pane-tab__dot--dirty")).toBeNull();
    act(() => setSubject("viewer-1", { path: "/p/a.ts", preview: false, dirty: true }));
    expect(container.querySelector(".pane-tab__dot--dirty")).not.toBeNull();
  });

  it("falls back to the app glyph before the viewer has opened a file", () => {
    const { container } = strip([member({ title: "File Viewer" })]);
    expect(container.querySelector("img.pane-tab__fileicon")).toBeNull();
    expect(container.querySelector(".pane-tab__icon--app")).not.toBeNull();
  });
});

describe("double-clicking a tab", () => {
  it("has no maximise gesture bound on the tab", () => {
    expect(stripSource).not.toMatch(/onDoubleClick|onToggleMaximize/);
  });
});

describe("any other app's tab", () => {
  it("keeps the app glyph and has no colour square", () => {
    const { container } = strip([member({ id: "files-1", title: "Files", appId: "files" })]);
    expect(container.querySelector(".pane-tab__icon--app")).not.toBeNull();
    expect(container.querySelector(".pane-tab__swatch")).toBeNull();
    expect(container.querySelector("img.pane-tab__fileicon")).toBeNull();
  });
});

/**
 * Reaching the tabs a strip cuts off, by mouse. jsdom does no layout, so these
 * state the geometry instead of producing it: every tab is `TAB` wide and sits
 * where `scrollLeft` puts it, in a view narrower than all five together. What
 * is asserted is the mechanism — `scrollLeft` and `defaultPrevented` — not that
 * anything moved on screen.
 */
describe("a strip with more tabs than fit", () => {
  const TAB = 100;
  const VIEW = 250;

  const five = (active: number) =>
    Array.from({ length: 5 }, (_, i) =>
      member({
        id: `files-${i}`,
        dragId: `files-${i}`,
        title: `Tab ${i}`,
        appId: "files",
        showing: i === active,
      }),
    );

  function layOut(container: HTMLElement): HTMLElement {
    const el = container.querySelector<HTMLElement>(".pane-tabstrip")!;
    const tabs = [...container.querySelectorAll<HTMLElement>(".pane-tab")];
    Object.defineProperty(el, "clientWidth", { configurable: true, value: VIEW });
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: tabs.length * TAB });
    el.getBoundingClientRect = () => new DOMRect(0, 0, VIEW, 34);
    tabs.forEach((tab, i) => {
      tab.getBoundingClientRect = () => new DOMRect(i * TAB - el.scrollLeft, 0, TAB, 34);
    });
    return el;
  }

  function wheel(target: Element, init: WheelEventInit): WheelEvent {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("scrolls sideways under a plain vertical wheel, and claims the tick", () => {
    const { container } = strip(five(0));
    const el = layOut(container);
    const label = container.querySelectorAll(".pane-tab__label")[1];

    const tick = wheel(label, { deltaY: 120 });
    expect(el.scrollLeft).toBe(120);
    expect(tick.defaultPrevented).toBe(true);

    wheel(label, { deltaY: -3, deltaMode: 1 });
    expect(el.scrollLeft).toBe(72);
  });

  it("leaves a horizontal swipe, a pinch and a strip that fits to the browser", () => {
    const { container } = strip(five(0));
    const el = layOut(container);

    expect(wheel(el, { deltaX: 80, deltaY: 10 }).defaultPrevented).toBe(false);
    expect(wheel(el, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(el.scrollLeft).toBe(0);

    Object.defineProperty(el, "scrollWidth", { configurable: true, value: VIEW });
    expect(wheel(el, { deltaY: 120 }).defaultPrevented).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("scrolls whichever tab becomes active wholly into view, from either side", () => {
    const { container, rerender } = strip(five(0));
    const el = layOut(container);

    // The last tab: its right edge meets the view's.
    rerender(stripOf(five(4)));
    expect(el.scrollLeft).toBe(5 * TAB - VIEW);

    // Already wholly in view, so nothing moves.
    rerender(stripOf(five(3)));
    expect(el.scrollLeft).toBe(5 * TAB - VIEW);

    // Cut off on the left: its left edge meets the view's.
    rerender(stripOf(five(1)));
    expect(el.scrollLeft).toBe(1 * TAB);
  });

  it("does not undo a wheel scroll that leaves the active tab off screen", () => {
    const { container, rerender } = strip(five(0));
    const el = layOut(container);

    wheel(el, { deltaY: 200 });
    expect(el.scrollLeft).toBe(200);

    rerender(stripOf(five(0).map((m) => ({ ...m, agentFinished: true }))));
    expect(el.scrollLeft).toBe(200);
  });
});
