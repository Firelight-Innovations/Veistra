/**
 * How the settings screen is arranged: which pages the sidebar lists, which
 * sections each page holds, where a deep link lands, what a search finds, and
 * which sections are folded.
 *
 * The rows themselves still come from the schema Rust publishes; this file
 * only decides where each group is drawn. A group no page names (a plugin's,
 * or one added in Rust without an edit here) lands on Apps, so a new section
 * is never silently missing from the screen.
 */
import type { Setting, SettingsGroup } from "../../bindings";

/** A section that is not a schema group: drawn by a panel this screen knows. */
export type PanelId = "profile" | "billing" | "usage";

/** One collapsible section of a page: a schema group, or a panel. */
export type SectionDef =
  | { kind: "group"; id: string; title?: string }
  | { kind: "panel"; id: PanelId; title: string; description: string; keywords: string };

export interface PageDef {
  id: string;
  title: string;
  /** The sidebar's divider groups: 0 account, 1 Veistra's settings, 2 app-level. */
  band: 0 | 1 | 2;
  sections: SectionDef[];
}

const group = (id: string, title?: string): SectionDef => ({ kind: "group", id, title });

/** Where `pages` puts a group none of them names. */
export const FALLBACK_PAGE = "apps";

/** The page Settings opens on when nothing asked for one. */
export const DEFAULT_PAGE = "general";

export const PAGES: readonly PageDef[] = [
  {
    id: "account",
    title: "Account",
    band: 0,
    sections: [
      {
        kind: "panel",
        id: "profile",
        title: "Profile",
        description: "Who this computer is signed in to Veistra as.",
        keywords: "profile sign in sign out log out name email photo avatar workspace id",
      },
    ],
  },
  {
    id: "billing",
    title: "Billing",
    band: 0,
    sections: [
      {
        kind: "panel",
        id: "billing",
        title: "Plan",
        description: "The plan your workspace is on, and its monthly limit.",
        keywords: "plan billing upgrade limit payment invoices subscription",
      },
    ],
  },
  {
    id: "usage",
    title: "Usage",
    band: 0,
    sections: [
      {
        kind: "panel",
        id: "usage",
        title: "Your usage",
        description: "What your account has used and spent, by source, day and run.",
        keywords: "usage spend cost tokens runs limit cloud worker gpu renders",
      },
      group("runs"),
    ],
  },
  {
    id: "general",
    title: "General",
    band: 1,
    sections: [group("appearance"), group("keys"), group("updates"), group("telemetry")],
  },
  { id: "editor", title: "Editor", band: 1, sections: [group("editor"), group("search")] },
  { id: "terminal", title: "Terminal", band: 1, sections: [group("terminal")] },
  { id: "agents", title: "Agents", band: 1, sections: [group("skills")] },
  { id: "mcp", title: "MCP servers", band: 1, sections: [group("mcp")] },
  {
    id: "apps",
    title: "Apps",
    band: 1,
    sections: [group("files"), group("canvas"), group("markup"), group("godot"), group("blender")],
  },
  { id: "source-control", title: "Source control", band: 1, sections: [group("github")] },
  { id: "cloud", title: "Cloud", band: 1, sections: [group("cloud")] },
  // Where the account service and website live is wiring for a build, not
  // something a person signing in chooses, so it sits with Developer.
  {
    id: "developer",
    title: "Developer",
    band: 2,
    sections: [group("developer"), group("account", "Account service")],
  },
];

/** A section resolved against the live schema: what the screen draws. */
export interface Section {
  id: string;
  title: string;
  description: string;
  /** The schema group behind it, or null for a panel. */
  group: SettingsGroup | null;
  panel: PanelId | null;
  keywords: string;
}

export interface Page {
  id: string;
  title: string;
  band: 0 | 1 | 2;
  sections: Section[];
}

/**
 * Every page with its sections resolved. A named group the schema does not
 * have (a feature compiled out) is dropped; a group no page names is appended
 * to Apps, in the order the schema sent it.
 */
export function pages(groups: SettingsGroup[]): Page[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const named = new Set(
    PAGES.flatMap((p) => p.sections.filter((s) => s.kind === "group").map((s) => s.id)),
  );
  return PAGES.map((def) => {
    const sections: Section[] = [];
    for (const s of def.sections) {
      if (s.kind === "panel") {
        sections.push({ ...s, group: null, panel: s.id });
        continue;
      }
      const g = byId.get(s.id);
      if (g === undefined) continue;
      sections.push({
        id: g.id,
        title: s.title ?? g.title,
        description: g.description,
        group: g,
        panel: null,
        keywords: "",
      });
    }
    if (def.id === FALLBACK_PAGE) {
      for (const g of groups) {
        if (named.has(g.id)) continue;
        sections.push({
          id: g.id,
          title: g.title,
          description: g.description,
          group: g,
          panel: null,
          keywords: "",
        });
      }
    }
    return { id: def.id, title: def.title, band: def.band, sections };
  });
}

/** Where a request to open Settings lands: a page, and the section to unfold and show. */
export interface Landing {
  page: string;
  section: string | null;
}

/**
 * A page id lands on that page; a section id (a group's, or a panel's) on the
 * page that holds it, with that section unfolded. Anything else, the default
 * page: a stale shortcut still opens on something.
 */
export function landing(request: string | null, all: Page[]): Landing {
  if (request !== null) {
    const page = all.find((p) => p.id === request);
    if (page) return { page: page.id, section: null };
    const holder = all.find((p) => p.sections.some((s) => s.id === request));
    if (holder) return { page: holder.id, section: request };
  }
  return { page: DEFAULT_PAGE, section: null };
}

/** One section's part in a search: the rows that matched, or all of it. */
export interface SectionMatch {
  section: Section;
  /** The matching rows. Null for a panel, which matched as a whole. */
  settings: Setting[] | null;
}

export interface PageMatch {
  page: Page;
  sections: SectionMatch[];
}

/**
 * What a search finds, page by page in sidebar order. A row matches on its
 * title, description or key (a key is what an error message or a colleague
 * names a setting by). A panel has no rows to filter, so it matches as a whole
 * on its title, description and keywords. A section whose own title matches
 * shows every row it has.
 */
export function search(all: Page[], needle: string): PageMatch[] {
  const n = needle.trim().toLowerCase();
  if (n === "") return [];
  const has = (text: string) => text.toLowerCase().includes(n);
  const found: PageMatch[] = [];
  for (const page of all) {
    const sections: SectionMatch[] = [];
    for (const section of page.sections) {
      const named = has(section.title) || has(page.title);
      if (section.group === null) {
        if (named || has(`${section.description} ${section.keywords}`)) {
          sections.push({ section, settings: null });
        }
        continue;
      }
      const rows = named
        ? section.group.settings
        : section.group.settings.filter((s) => has(`${s.title} ${s.description} ${s.key}`));
      if (rows.length > 0) sections.push({ section, settings: rows });
    }
    if (sections.length > 0) found.push({ page, sections });
  }
  return found;
}

/** `text` split around each case-insensitive occurrence of `needle`, for `<mark>`. */
export function highlight(text: string, needle: string): { text: string; hit: boolean }[] {
  const n = needle.trim().toLowerCase();
  if (n === "") return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), hit: false });
    parts.push({ text: text.slice(i, i + n.length), hit: true });
    at = i + n.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

// --- which sections are folded ---------------------------------------------

export const COLLAPSED_KEY = "veistra.settings.collapsed";

/**
 * The ids of folded sections. Stored as the folded ones rather than the open
 * ones, so a section added by a later build arrives open. A store that cannot
 * be read reads as nothing folded.
 */
export function readCollapsed(storage: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsed(storage: Pick<Storage, "setItem"> | null, ids: Set<string>): void {
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify([...ids].sort()));
  } catch {
    // A section that opens unfolded next time is not worth an error.
  }
}
