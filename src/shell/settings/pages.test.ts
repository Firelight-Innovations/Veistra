/**
 * Where each settings group is drawn, where a deep link lands, what a search
 * finds, and how folded sections are remembered.
 */
import { describe, expect, it } from "vitest";
import {
  COLLAPSED_KEY,
  PAGES,
  highlight,
  landing,
  pages,
  readCollapsed,
  search,
  writeCollapsed,
} from "./pages";
import type { Setting, SettingsGroup } from "../../bindings";

const row = (key: string, title: string, description = ""): Setting => ({
  key,
  title,
  description,
  control: { kind: "toggle", default: false },
  applies: { when: "now" },
});

const group = (id: string, settings: Setting[], title = id): SettingsGroup => ({
  id,
  title,
  description: "",
  order: 0,
  settings,
});

/** Every group the shell's schema publishes today, plus the apps' and a plugin's. */
const SHELL_GROUPS = [
  "appearance",
  "editor",
  "terminal",
  "keys",
  "search",
  "github",
  "cloud",
  "account",
  "updates",
  "telemetry",
  "mcp",
  "skills",
  "developer",
  "files",
  "canvas",
  "markup",
  "blender",
  "godot",
];

describe("pages", () => {
  it("names a page for every group the schema publishes", () => {
    const named = new Set(
      PAGES.flatMap((p) => p.sections.filter((s) => s.kind === "group").map((s) => s.id)),
    );
    expect(SHELL_GROUPS.filter((id) => !named.has(id))).toEqual([]);
  });

  it("puts a group no page names on Apps, and drops a named one that is absent", () => {
    const all = pages([group("terminal", []), group("plugin-x", [], "Plugin X")]);
    const apps = all.find((p) => p.id === "apps");
    expect(apps?.sections.map((s) => s.id)).toEqual(["plugin-x"]);
    const general = all.find((p) => p.id === "general");
    expect(general?.sections).toEqual([]);
    expect(all.find((p) => p.id === "terminal")?.sections.map((s) => s.id)).toEqual(["terminal"]);
  });

  it("keeps the account pages first and Developer last", () => {
    const ids = pages([]).map((p) => p.id);
    expect(ids.slice(0, 3)).toEqual(["account", "billing", "usage"]);
    expect(ids[ids.length - 1]).toBe("developer");
  });

  it("draws the account service addresses on Developer, not on Account", () => {
    const all = pages([group("developer", []), group("account", [])]);
    expect(all.find((p) => p.id === "account")?.sections.map((s) => s.id)).toEqual(["profile"]);
    expect(all.find((p) => p.id === "developer")?.sections.map((s) => s.id)).toEqual([
      "developer",
      "account",
    ]);
  });
});

describe("landing", () => {
  const all = pages([group("telemetry", []), group("terminal", []), group("account", [])]);

  it("lands a page id on that page", () => {
    expect(landing("usage", all)).toEqual({ page: "usage", section: null });
    expect(landing("account", all)).toEqual({ page: "account", section: null });
  });

  it("lands a section id on the page that holds it, with that section", () => {
    expect(landing("telemetry", all)).toEqual({ page: "general", section: "telemetry" });
    expect(landing("profile", all)).toEqual({ page: "account", section: "profile" });
  });

  it("lands anything else on General", () => {
    expect(landing("no-such-thing", all)).toEqual({ page: "general", section: null });
    expect(landing(null, all)).toEqual({ page: "general", section: null });
  });
});

describe("search", () => {
  const all = pages([
    group("terminal", [row("terminal.scrollback", "Scrollback"), row("terminal.bell", "Bell")]),
    group("editor", [row("editor.wordWrap", "Word wrap", "Wrap long lines")], "Editor"),
  ]);

  it("finds rows by title, description and key, across pages", () => {
    const found = search(all, "wrap");
    expect(found.map((m) => m.page.id)).toEqual(["editor"]);
    expect(found[0].sections[0].settings?.map((s) => s.key)).toEqual(["editor.wordWrap"]);
    expect(search(all, "terminal.bell")[0].sections[0].settings?.map((s) => s.key)).toEqual([
      "terminal.bell",
    ]);
  });

  it("shows a whole section whose title matches", () => {
    const found = search(all, "terminal");
    expect(found[0].sections[0].settings?.length).toBe(2);
  });

  it("matches a panel on its keywords", () => {
    const found = search(all, "invoices");
    expect(found.map((m) => m.page.id)).toEqual(["billing"]);
    expect(found[0].sections[0].settings).toBeNull();
  });

  it("finds nothing for nothing", () => {
    expect(search(all, "  ")).toEqual([]);
  });
});

describe("highlight", () => {
  it("splits text around every case-insensitive hit", () => {
    expect(highlight("Word wrap, wrap", "WRAP")).toEqual([
      { text: "Word ", hit: false },
      { text: "wrap", hit: true },
      { text: ", ", hit: false },
      { text: "wrap", hit: true },
    ]);
  });
});

describe("folded sections", () => {
  function memory(): Storage {
    const items = new Map<string, string>();
    return {
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => void items.set(k, v),
      removeItem: (k) => void items.delete(k),
      clear: () => items.clear(),
      key: () => null,
      get length() {
        return items.size;
      },
    };
  }

  it("round-trips through storage", () => {
    const store = memory();
    writeCollapsed(store, new Set(["terminal", "editor"]));
    expect(store.getItem(COLLAPSED_KEY)).toBe('["editor","terminal"]');
    expect(readCollapsed(store)).toEqual(new Set(["editor", "terminal"]));
  });

  it("reads a damaged or missing value as nothing folded", () => {
    const store = memory();
    expect(readCollapsed(store).size).toBe(0);
    store.setItem(COLLAPSED_KEY, "{not json");
    expect(readCollapsed(store).size).toBe(0);
    store.setItem(COLLAPSED_KEY, '{"a":1}');
    expect(readCollapsed(store).size).toBe(0);
    expect(readCollapsed(null).size).toBe(0);
  });
});
