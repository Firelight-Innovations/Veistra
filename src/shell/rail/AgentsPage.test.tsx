// @vitest-environment jsdom
/**
 * The Agents page: each cluster's sessions with their live state, a row that
 * opens its tab, and a `+` that opens a new one in that cluster.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentCluster, AgentSession } from "../state/agentSessions";
import type { SavedSession, SavedSessionsSource } from "../state/savedSessions";
import AgentsPage from "./AgentsPage";

afterEach(cleanup);

const CLUSTERS: AgentCluster[] = [
  {
    id: "c1",
    name: "api",
    tabs: [
      { id: "a1", title: "Agent" },
      { id: "a2", title: "Agent" },
    ],
  },
  { id: "c2", name: "web", tabs: [] },
];

const SESSIONS = new Map<string, AgentSession>([
  ["a1", { state: "working", harness: "claude", prompt: "Fix the session expiry check" }],
  ["a2", { state: "needsInput", harness: "codex", prompt: "Run the migrations" }],
]);

/** Midday, so no time zone moves it to another date. */
const day = (date: number) => Date.UTC(2026, 9, date, 12);

/** A date as the page writes it. */
const when = (date: number) =>
  new Date(day(date)).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const saved = (id: string, title: string, date: number, harness: string, archived = false) => ({
  id,
  title,
  updated: day(date),
  harness,
  archived,
});

const SAVED: SavedSession[] = [
  saved("s1", "Older work", 1, "codex"),
  saved("s2", "@hammer What is this", 20, "claude"),
  saved("s3", "Put away", 5, "claude", true),
];

/** A scripted `agent-tab/history`, and the `agent-tab:history` event. */
function savedSource(sessions: SavedSession[] = SAVED) {
  let heard: (() => void) | undefined;
  const source = {
    list: vi.fn(async (_cluster: string) => sessions),
    archive: vi.fn(async (_cluster: string, id: string, archived: boolean) => {
      sessions = sessions.map((s) => (s.id === id ? { ...s, archived } : s));
    }),
    listen: vi.fn(async (cb: () => void) => {
      heard = cb;
      return () => (heard = undefined);
    }),
  } satisfies SavedSessionsSource;
  return {
    source,
    replace: (next: SavedSession[]) => (sessions = next),
    saved: () => act(async () => heard?.()),
  };
}

function draw(overrides: Partial<Parameters<typeof AgentsPage>[0]> = {}, saved = savedSource([])) {
  const onOpen = vi.fn();
  const onNew = vi.fn();
  const onResume = vi.fn();
  render(
    <AgentsPage
      clusters={CLUSTERS}
      sessions={SESSIONS}
      activeClusterId="c1"
      onOpen={onOpen}
      onNew={onNew}
      onResume={onResume}
      savedSessions={saved.source}
      {...overrides}
    />,
  );
  return { onOpen, onNew, onResume };
}

/** The previous sessions' rows, in order. */
async function previousRows() {
  const section = await screen.findByRole("region", { name: "Previous sessions" });
  return within(section)
    .queryAllByRole("button", { name: /·/ })
    .map((row) => row.textContent);
}

describe("AgentsPage", () => {
  it("lists each cluster's sessions by their latest prompt, with harness and state", () => {
    draw();
    const api = screen.getByRole("region", { name: "api" });
    const rows = within(api).getAllByRole("button", { name: /·/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      "Fix the session expiry checkClaude · Working",
      "Run the migrationsCodex · Needs you",
    ]);
    expect(rows[1].getAttribute("data-state")).toBe("needsInput");
    expect(within(api).getByText("Current cluster")).not.toBeNull();
  });

  it("names a session the way its tab is named, with a reference as its @label", () => {
    draw({
      sessions: new Map([
        [
          "a1",
          {
            state: "working",
            harness: "claude",
            prompt: "[@main](<veistra://canvas/main>) Hey can you take a look",
          },
        ],
      ]),
    });
    const row = screen.getByRole("button", { name: /Hey can you/ });
    expect(row.textContent).toBe("@main Hey can you take a lookClaude · Working");
  });

  it("says a cluster has no sessions rather than leaving it blank", () => {
    draw();
    const web = screen.getByRole("region", { name: "web" });
    expect(within(web).getByText("No agent sessions")).not.toBeNull();
    expect(within(web).queryByText("Current cluster")).toBeNull();
  });

  it("shows a tab that never sent a prompt as not started, under its title", () => {
    draw({ sessions: new Map() });
    const rows = within(screen.getByRole("region", { name: "api" })).getAllByRole("button", {
      name: /Not started/,
    });
    expect(rows[0].textContent).toBe("AgentNot started");
  });

  it("opens a session's tab, and a new session in the cluster whose + was pressed", () => {
    const { onOpen, onNew } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Run the migrations/ }));
    expect(onOpen).toHaveBeenCalledWith("a2");
    fireEvent.click(screen.getByRole("button", { name: "New agent session in web" }));
    expect(onNew).toHaveBeenCalledWith("c2");
  });

  it("starts a session in the current cluster from the top New Agent action", () => {
    const { onNew } = draw();
    fireEvent.click(screen.getByRole("button", { name: "New Agent" }));
    expect(onNew).toHaveBeenCalledWith("c1");
  });

  it("lists Workflows and Customize as actions still to come", () => {
    draw();
    const actions = screen.getByRole("navigation", { name: "Agent actions" });
    const workflows = within(actions).getByRole("button", { name: "Workflows" });
    expect(workflows.hasAttribute("disabled")).toBe(true);
    expect(workflows.getAttribute("title")).toBe("Coming soon");
    expect(within(actions).getByRole("button", { name: "Customize" })).not.toBeNull();
    expect(screen.queryByText(/Automations/)).toBeNull();
  });

  it("marks only the current cluster's card as active", () => {
    draw();
    expect(screen.getByRole("region", { name: "api" }).hasAttribute("data-active")).toBe(true);
    expect(screen.getByRole("region", { name: "web" }).hasAttribute("data-active")).toBe(false);
  });

  it("filters sessions by the search box", () => {
    draw();
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), {
      target: { value: "migrat" },
    });
    expect(screen.queryByRole("button", { name: /Fix the session/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Run the migrations/ })).not.toBeNull();
  });
});

describe("AgentsPage rename", () => {
  const NAMED: AgentCluster[] = [
    {
      id: "c1",
      name: "api",
      tabs: [
        { id: "a1", title: "Login rework" },
        { id: "a2", title: "Agent" },
      ],
    },
  ];

  it("shows a session's name over its latest prompt, and the prompt when it has none", () => {
    draw({ clusters: NAMED });
    const rows = within(screen.getByRole("region", { name: "api" })).getAllByRole("button", {
      name: /·/,
    });
    expect(rows.map((row) => row.textContent)).toEqual([
      "Login reworkClaude · Working",
      "Run the migrationsCodex · Needs you",
    ]);
  });

  it("renames from the pencil, trimming nothing the owner did not ask for", () => {
    const onRename = vi.fn();
    draw({ clusters: NAMED, onRename });
    fireEvent.click(screen.getAllByRole("button", { name: "Rename session" })[1]);
    const field = screen.getByRole("textbox", { name: "Session name" });
    expect(field).toHaveProperty("value", "");
    fireEvent.change(field, { target: { value: "Migrations" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("a2", "Migrations");
    expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
  });

  it("renames on a double click, starting from the current name", () => {
    const onRename = vi.fn();
    draw({ clusters: NAMED, onRename });
    fireEvent.doubleClick(screen.getByRole("button", { name: /Login rework/ }));
    const field = screen.getByRole("textbox", { name: "Session name" });
    expect(field).toHaveProperty("value", "Login rework");
    fireEvent.change(field, { target: { value: "Login v2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("a1", "Login v2");
  });

  it("Escape cancels, and an unchanged name is not sent", () => {
    const onRename = vi.fn();
    draw({ clusters: NAMED, onRename });
    fireEvent.click(screen.getAllByRole("button", { name: "Rename session" })[0]);
    const field = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(field, { target: { value: "Something else" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Rename session" })[0]);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("an open row carries no colour styling of its own", () => {
    draw({ clusters: NAMED });
    const row = screen.getByRole("button", { name: /Login rework/ });
    expect(row.hasAttribute("data-color")).toBe(false);
    expect(row.getAttribute("style")).toBeNull();
  });
});

describe("AgentsPage context menu", () => {
  const SCOPE = { paneTabs: ["a1", "a2"], agentTabs: ["a1", "a2"] };
  const menuActions = () => ({
    close: vi.fn(),
    scope: vi.fn(() => SCOPE),
    split: vi.fn(),
  });
  const item = (name: string) => screen.getByRole("menuitem", { name });
  const rowNames = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole("menuitem")
      .map((row) => row.querySelector(".menu-list__label")?.textContent);

  it("opens on right-click of an open row and lists the groups in order", () => {
    draw({ agentMenu: menuActions() });
    const cancelled = fireEvent.contextMenu(
      screen.getByRole("button", { name: /Run the migrations/ }),
    );
    expect(cancelled).toBe(false);
    expect(rowNames(screen.getByRole("menu", { name: "Agent actions" }))).toEqual([
      "Export Transcript",
      "Copy Request ID",
      "Give Feedback",
      "Rename Chat",
      "Fork Chat",
      "Close",
      "Close Others",
      "Close to the Right",
      "Close Saved",
      "Close All",
      "Reopen Editor With…",
      "Agent Settings",
      "Keep Open",
      "Pin",
      "Split Up",
      "Split Down",
      "Split Left",
      "Split Right",
      "Move into New Window",
    ]);
  });

  it("runs a live row on the right session and closes the menu", async () => {
    const actions = menuActions();
    draw({ agentMenu: actions });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Run the migrations/ }));
    fireEvent.click(item("Close"));
    expect(actions.close).toHaveBeenCalledWith("a2");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Agent actions" })).toBeNull());
  });

  it("does nothing, and stays open, when a disabled row is clicked", () => {
    const actions = menuActions();
    draw({ agentMenu: actions });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Run the migrations/ }));
    for (const name of ["Fork Chat", "Pin", "Export Transcript", "Move into New Window"]) {
      expect(item(name).hasAttribute("disabled"), name).toBe(true);
      fireEvent.click(item(name));
    }
    expect(actions.close).not.toHaveBeenCalled();
    expect(actions.split).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Agent actions" })).not.toBeNull();
  });

  it("renames through the page's own rename", async () => {
    const onRename = vi.fn();
    draw({ agentMenu: menuActions(), onRename });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Run the migrations/ }));
    fireEvent.click(item("Rename Chat"));
    const field = await screen.findByLabelText("Rename chat");
    fireEvent.change(field, { target: { value: "Migrations" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });
    expect(onRename).toHaveBeenCalledWith("a2", "Migrations");
  });

  it("opens a smaller menu on a previous session, and resumes or archives from it", async () => {
    const s = savedSource();
    const { onResume } = draw({ agentMenu: menuActions() }, s);
    await previousRows();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Older work/ }));
    expect(rowNames(screen.getByRole("menu", { name: "Saved session actions" }))).toEqual([
      "Open Session",
      "Export Transcript",
      "Rename Chat",
      "Fork Chat",
      "Archive",
    ]);
    expect(item("Fork Chat").hasAttribute("disabled")).toBe(true);
    fireEvent.click(item("Open Session"));
    expect(onResume).toHaveBeenCalledWith("s1");
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Older work/ }));
    await act(async () => {
      fireEvent.click(item("Archive"));
    });
    expect(s.source.archive).toHaveBeenCalledWith("c1", "s1", true);
  });

  it("dismisses on Escape", async () => {
    draw({ agentMenu: menuActions() });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Run the migrations/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Agent actions" })).toBeNull());
  });
});

describe("AgentsPage previous sessions", () => {
  it("lists the current cluster's saved sessions newest first, with harness and date", async () => {
    const s = savedSource();
    draw({}, s);
    expect(await previousRows()).toEqual([
      `@hammer What is thisClaude · ${when(20)}`,
      `Older workCodex · ${when(1)}`,
    ]);
    expect(s.source.list).toHaveBeenCalledWith("c1");
  });

  it("keeps archived sessions in a fold that starts closed", async () => {
    draw({}, savedSource());
    const fold = await screen.findByRole("button", { name: "Archived (1)" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Put away/ })).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /^Put away/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Restore Put away" })).not.toBeNull();
  });

  it("archives a session from its row and lists them again", async () => {
    const s = savedSource();
    draw({}, s);
    await previousRows();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive Older work" }));
    });
    expect(s.source.archive).toHaveBeenCalledWith("c1", "s1", true);
    expect(await previousRows()).toEqual([`@hammer What is thisClaude · ${when(20)}`]);
    expect(screen.getByRole("button", { name: "Archived (2)" })).not.toBeNull();
  });

  it("resumes a session from its row", async () => {
    const { onResume } = draw({}, savedSource());
    await previousRows();
    fireEvent.click(screen.getByRole("button", { name: /^Older work/ }));
    expect(onResume).toHaveBeenCalledWith("s1");
  });

  it("lists them again when a session is saved", async () => {
    const s = savedSource();
    draw({}, s);
    await previousRows();
    s.replace([...SAVED, saved("s4", "Just now", 25, "claude")]);
    await s.saved();
    expect((await previousRows())[0]).toBe(`Just nowClaude · ${when(25)}`);
  });

  it("filters previous sessions by the search box too", async () => {
    draw({}, savedSource());
    await previousRows();
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), {
      target: { value: "hammer" },
    });
    expect(await previousRows()).toEqual([`@hammer What is thisClaude · ${when(20)}`]);
  });

  it("shows nothing for a cluster whose history cannot be read", async () => {
    const s = savedSource();
    s.source.list.mockRejectedValue(new Error("notAWorktree"));
    draw({}, s);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Previous sessions" })).toBeNull();
  });
});
