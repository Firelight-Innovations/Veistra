// @vitest-environment jsdom
/**
 * The title bar's two collapse steps, both on the window's width (#336): the
 * right-hand buttons fold into one overflow button below 1440px, and the menus
 * into the hamburger below 1180px.
 *
 * jsdom has no `matchMedia`, so this one answers the `(width < Npx)` queries the
 * hooks ask for against a width the test sets, and fires `change` on each list
 * a resize flips, which is what a browser does. A query in any other form
 * throws, so the strict `<` the hooks rely on is part of what is tested.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  ACTIONS_COLLAPSE_BELOW,
  MENUS_COLLAPSE_BELOW,
  useCollapsedTitlebarActions,
  useNarrowTitlebar,
} from "./useNarrowTitlebar";

type Listener = (e: MediaQueryListEvent) => void;

interface FakeList {
  query: string;
  matches: boolean;
  listeners: Set<Listener>;
}

let windowWidth = 1600;
const lists = new Set<FakeList>();

function answer(query: string): boolean {
  const m = /^\(width < (\d+(?:\.\d+)?)px\)$/.exec(query);
  if (!m) throw new Error(`unexpected media query: ${query}`);
  return windowWidth < Number(m[1]);
}

window.matchMedia = (query: string) => {
  const list: FakeList = { query, matches: answer(query), listeners: new Set() };
  lists.add(list);
  return {
    media: query,
    get matches() {
      return list.matches;
    },
    addEventListener: (_type: string, fn: Listener) => list.listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => list.listeners.delete(fn),
  } as unknown as MediaQueryList;
};

function resizeTo(px: number) {
  windowWidth = px;
  act(() => {
    for (const list of lists) {
      const now = answer(list.query);
      if (now === list.matches) continue;
      list.matches = now;
      for (const fn of list.listeners)
        fn({ matches: now, media: list.query } as MediaQueryListEvent);
    }
  });
}

/** Both answers, from a bar mounted at `px`. */
function at(px: number) {
  windowWidth = px;
  const menus = renderHook(() => useNarrowTitlebar()).result.current;
  const actions = renderHook(() => useCollapsedTitlebarActions()).result.current;
  return { menus, actions };
}

afterEach(() => {
  cleanup();
  lists.clear();
  windowWidth = 1600;
});

describe("the title bar's collapse steps", () => {
  it("folds the menus into the hamburger below 1180px, and not at it", () => {
    expect(MENUS_COLLAPSE_BELOW).toBe(1180);
    expect(at(1179).menus).toBe(true);
    // A fractional width between the two whole pixels is still below.
    expect(at(1179.5).menus).toBe(true);
    expect(at(1180).menus).toBe(false);
    expect(at(2000).menus).toBe(false);
  });

  it("folds the right-hand buttons into one button below 1440px, and not at it", () => {
    expect(ACTIONS_COLLAPSE_BELOW).toBe(1440);
    expect(at(1439).actions).toBe(true);
    expect(at(1439.5).actions).toBe(true);
    expect(at(1440).actions).toBe(false);
    expect(at(2000).actions).toBe(false);
  });

  it("folds the buttons first, so between the steps only they have collapsed", () => {
    for (const px of [1180, 1330, 1439]) expect(at(px)).toEqual({ menus: false, actions: true });
    for (const px of [480, 900, 1179]) expect(at(px)).toEqual({ menus: true, actions: true });
  });

  it("follows a resize without a remount", () => {
    const menus = renderHook(() => useNarrowTitlebar());
    const actions = renderHook(() => useCollapsedTitlebarActions());
    const now = () => ({ menus: menus.result.current, actions: actions.result.current });
    expect(now()).toEqual({ menus: false, actions: false });

    resizeTo(1330);
    expect(now()).toEqual({ menus: false, actions: true });
    resizeTo(1000);
    expect(now()).toEqual({ menus: true, actions: true });
    resizeTo(1600);
    expect(now()).toEqual({ menus: false, actions: false });
  });

  it("stops listening once unmounted", () => {
    const menus = renderHook(() => useNarrowTitlebar());
    const actions = renderHook(() => useCollapsedTitlebarActions());
    menus.unmount();
    actions.unmount();
    for (const list of lists) expect(list.listeners.size).toBe(0);
  });
});
