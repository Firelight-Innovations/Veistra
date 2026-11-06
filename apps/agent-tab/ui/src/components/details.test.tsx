// @vitest-environment jsdom
/**
 * The Details panel, one task opened in it, and the agent map: each row opens
 * what it names, and each closes the way a panel or a dialog should.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentMap } from "./AgentMap";
import { DetailsPanel } from "./DetailsPanel";
import { Layout } from "./Layout";
import { TaskDetail } from "./TaskDetail";
import type { DetailsPanelProps } from "./types";
import { strings } from "../strings";

afterEach(cleanup);

const base: DetailsPanelProps = {
  onClose: () => {},
  environment: {
    kind: strings.details.worktree,
    branch: "braden/harness-ui",
    path: "C:/w",
    sync: strings.details.sync(2, 0),
    remote: "git@github.com:org/repo.git",
    uncommitted: { label: strings.details.uncommitted(3), added: 10, removed: 4 },
  },
  onOpenGit: () => {},
  context: { used: 1000, size: 10_000 },
  connectors: [{ id: "veistra:canvas", label: "veistra-canvas", detail: "Veistra" }],
  onManageConnectors: () => {},
  outputs: [],
  changes: [],
  tasks: [],
  agents: null,
};

describe("DetailsPanel", () => {
  it("shows every section, with what each one has", () => {
    render(<DetailsPanel {...base} />);
    for (const title of [
      strings.details.environment,
      strings.details.context,
      strings.details.connectors,
      strings.details.outputs,
      strings.details.changes,
      strings.details.tasks,
    ])
      expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText("braden/harness-ui")).toBeTruthy();
    expect(screen.getByText(strings.details.sync(2, 0))).toBeTruthy();
    expect(screen.getByText("veistra-canvas")).toBeTruthy();
    expect(screen.getByText(strings.details.noChanges)).toBeTruthy();
  });

  it("opens a changed file, the Git sidebar and the connector settings", () => {
    const onOpen = vi.fn();
    const onOpenGit = vi.fn();
    const onManageConnectors = vi.fn();
    render(
      <DetailsPanel
        {...base}
        onOpenGit={onOpenGit}
        onManageConnectors={onManageConnectors}
        changes={[{ id: "a", label: "src/a.ts", added: 3, removed: 1, onOpen }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
    expect(onOpen).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: strings.details.openGit }));
    expect(onOpenGit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: strings.details.manageConnectors }));
    expect(onManageConnectors).toHaveBeenCalled();
  });

  it("says it is loading until the environment arrives", () => {
    render(<DetailsPanel {...base} environment={null} connectors={null} />);
    expect(screen.getAllByText(strings.details.loading)).toHaveLength(2);
  });

  it("closes on Escape from inside it", () => {
    const onClose = vi.fn();
    render(<DetailsPanel {...base} onClose={onClose} />);
    screen.getByRole("button", { name: strings.details.close }).focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a task in place of the sections when one is open", () => {
    render(<DetailsPanel {...base} detail={<div>one task</div>} />);
    expect(screen.getByText("one task")).toBeTruthy();
    expect(screen.queryByText(strings.details.environment)).toBeNull();
  });
});

describe("TaskDetail", () => {
  it("lists phases with their agents, then what is up next, and goes back", () => {
    const onBack = vi.fn();
    render(
      <TaskDetail
        name="Review"
        type="Workflow"
        state="running"
        stateLabel="Running"
        figures="1m 5s"
        description={null}
        summary={null}
        lastTool={null}
        phases={[
          {
            title: "Survey",
            detail: null,
            state: "running",
            stateLabel: "Running",
            agents: [{ id: "a", label: "map-wire", state: "running", meta: "opus", result: null }],
          },
        ]}
        upNext={[
          { title: "Verify", detail: null, state: "next", stateLabel: "Up next", agents: [] },
        ]}
        loose={[]}
        looseTitle=""
        onBack={onBack}
        onStop={null}
        stopping={false}
      />,
    );
    expect(screen.getByText("map-wire")).toBeTruthy();
    expect(screen.getByText(strings.task.upNext)).toBeTruthy();
    expect(screen.getByText("Verify")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.task.back }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("AgentMap", () => {
  it("opens a node, and closes on Escape or a click outside the card", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <AgentMap
        main={{ id: "main", label: "Harness work", meta: "Opus", state: "running" }}
        agents={[{ id: "c1", label: "Survey the code", meta: "5m 18s", state: "running", onOpen }]}
        tasks={[{ id: "k1", label: "Run tests", meta: "Shell", state: "running" }]}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("dialog", { name: strings.map.title })).toBeTruthy();
    expect(screen.getByText(strings.map.agents(2))).toBeTruthy();
    expect(screen.getByText(strings.map.tasks(1))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Survey the code/ }));
    expect(onOpen).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(container.querySelector(".at-map__backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Layout", () => {
  it("draws the panel beside the conversation only while it is open", () => {
    const { container, rerender } = render(
      <Layout header={null} transcript={<main />} composer={null} />,
    );
    expect(container.querySelector(".at[data-details]")).toBeNull();
    rerender(<Layout header={null} transcript={<main />} composer={null} details={<aside />} />);
    expect(container.querySelector(".at[data-details] > aside")).toBeTruthy();
  });
});
