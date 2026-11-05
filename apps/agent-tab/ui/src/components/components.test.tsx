// @vitest-environment jsdom
/**
 * The components no default tree renders yet: each branch they take, so the
 * work that builds on them starts from checked behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fileIconUrl, folderIconUrl } from "@veistra/file-icons";
import { ContextMeter } from "./ContextMeter";
import { Menu } from "./Menu";
import { Picker } from "./Picker";
import { SessionList } from "./SessionList";
import { UserMessage } from "./UserMessage";
import { ChipOpen } from "../chipOpen";

afterEach(cleanup);

describe("ContextMeter", () => {
  // The ring's filled arc as a share of its circumference, in whole percent.
  const fill = (el: HTMLElement) => {
    const dash = el.querySelector(".at-ring__fill")!.getAttribute("stroke-dasharray")!;
    return `${Math.round((Number(dash.split(" ")[0]) / (2 * Math.PI * 6)) * 100)}%`;
  };

  it("draws nothing until usage and a window size are known", () => {
    expect(render(<ContextMeter used={null} size={100} />).container.firstChild).toBeNull();
    expect(render(<ContextMeter used={10} size={null} />).container.firstChild).toBeNull();
    expect(render(<ContextMeter used={10} size={0} />).container.firstChild).toBeNull();
  });

  it("fills in proportion, and never past either end", () => {
    const meter = (used: number) => {
      const { container } = render(<ContextMeter used={used} size={100} />);
      const width = fill(container);
      cleanup();
      return width;
    };
    expect(meter(0)).toBe("0%");
    expect(meter(50)).toBe("50%");
    expect(meter(250)).toBe("100%");
    expect(meter(-5)).toBe("0%");
  });

  it("names how full the window is for assistive technology, capped at full", () => {
    render(<ContextMeter used={250} size={100} />);
    expect(screen.getByRole("button", { name: "Context window 100% full" })).toBeTruthy();
  });
});

describe("Picker", () => {
  const choices = [
    { value: "a", name: "Alpha", description: "first" },
    { value: "b", name: "" },
  ];

  it("shows its value as text, named by its label, when nothing can be chosen", () => {
    render(<Picker label="Mode" value="default" choices={[]} />);
    expect(screen.getByRole("group", { name: "Mode" }).textContent).toBe("default");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("falls back to the value when a choice has no name", () => {
    render(<Picker label="Model" value="a" choices={choices} onChange={vi.fn()} />);
    expect([...screen.getAllByRole("option")].map((o) => o.textContent)).toEqual(["Alpha", "b"]);
  });

  it("keeps showing a value it was not offered, instead of the first choice", () => {
    render(<Picker label="Model" value="zzz" choices={choices} onChange={vi.fn()} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
    expect(select.value).toBe("zzz");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("reports the chosen value", () => {
    const onChange = vi.fn();
    render(<Picker label="Model" value="a" choices={choices} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Menu", () => {
  const items = [
    { id: "x", label: "/review", detail: "a file" },
    { id: "y", label: "/clear" },
  ];

  it("draws nothing without items", () => {
    expect(
      render(<Menu label="Commands" items={[]} activeId={null} onPick={vi.fn()} />).container
        .firstChild,
    ).toBeNull();
  });

  it("marks the active item, and gives each an id the input can point at", () => {
    render(<Menu label="Commands" items={items} activeId="y" onPick={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.id)).toEqual(["menu-item-x", "menu-item-y"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(options[0].textContent).toContain("a file");
  });

  it("picks on click without taking focus from the input", () => {
    const onPick = vi.fn();
    render(<Menu label="Commands" items={items} activeId={null} onPick={onPick} />);
    const option = screen.getByText("/clear");
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith("y");
  });

  it("leads a file or folder with the icon the Files explorer gives it", () => {
    render(
      <Menu
        label="Project context"
        items={[
          {
            id: "a",
            label: "main.json",
            detail: "canvas/main.json",
            kind: "file",
            fileName: "main.json",
          },
          { id: "b", label: "main.json.bak", kind: "file", fileName: "main.json.bak" },
          { id: "c", label: "docs", kind: "folder", fileName: "docs" },
          { id: "d", label: "Level design", kind: "frame" },
          // Browsing files, with nothing listed: a search row, not a folder named "Files".
          { id: "e", label: "Files", kind: "folder" },
        ]}
        activeId={null}
        onPick={vi.fn()}
      />,
    );
    const [json, bak, folder, frame, category] = screen.getAllByRole("option");
    const src = (row: HTMLElement) => row.querySelector("img")?.getAttribute("src");
    expect(src(json)).toBe(fileIconUrl("main.json"));
    expect(src(bak)).toBe(fileIconUrl("main.json.bak"));
    expect(src(folder)).toBe(folderIconUrl("docs", false));
    // The icon says nothing the name does not, so it is not announced.
    expect(json.querySelector("img")?.getAttribute("alt")).toBe("");
    // Rows that are not files keep their glyph, and a category is not a file name.
    expect(src(frame)).toBeUndefined();
    expect(frame.querySelector("svg")).not.toBeNull();
    expect(src(category)).toBeUndefined();
    expect(category.querySelector("svg")).not.toBeNull();
  });

  it("tags each row with its kind, which colours its glyph", () => {
    render(
      <Menu
        label="Project context"
        items={[
          { id: "a", label: "Design", kind: "design", children: [] },
          { id: "b", label: "Level design", kind: "frame" },
          { id: "c", label: "No kind" },
        ]}
        activeId="b"
        onPick={vi.fn()}
      />,
    );
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["design", "frame", null]);
  });

  it("draws a line above a separated row, but never above the first", () => {
    const { container } = render(
      <Menu
        label="Project context"
        items={[
          { id: "a", label: "Files", kind: "folder", separated: true },
          { id: "b", label: "Design", kind: "design", children: [] },
          { id: "c", label: "Selection", kind: "selection", separated: true },
        ]}
        activeId={null}
        onPick={vi.fn()}
      />,
    );
    const list = container.querySelector(".at-menu__list")!;
    const order = [...list.children].map((li) =>
      li.classList.contains("at-menu__sep") ? "line" : li.textContent,
    );
    expect(order).toEqual(["Files", "Design", "line", "Selection"]);
    // The line is not an option: arrow keys and the option count skip it.
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});

describe("UserMessage", () => {
  it("colours each sent chip by what it points at", () => {
    render(
      <UserMessage text="Fix [@Room 0](<veistra://canvas/levels#frame=f0>) in [@main.gd](<veistra://file/game/main.gd>) and [@x](<veistra://elsewhere/x>)" />,
    );
    const chips = [...document.querySelectorAll(".at-chip")];
    expect(chips.map((c) => c.getAttribute("data-kind"))).toEqual(["frame", "file", null]);
  });

  it("makes a chip an editor can show a button that shows it, and leaves the rest as text", () => {
    const open = vi.fn();
    const opener = { opens: (uri: string) => uri.endsWith(".blend"), open };
    render(
      <ChipOpen.Provider value={opener}>
        <UserMessage text="Look at [@crate.blend](<veistra://file/art/crate.blend>) and [@a.md](<veistra://file/a.md>)" />
      </ChipOpen.Provider>,
    );
    const button = screen.getByRole("button", { name: "@crate.blend" });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(open.mock.calls).toEqual([
      ["veistra://file/art/crate.blend"],
      ["veistra://file/art/crate.blend"],
    ]);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("opens nothing without a tab around it", () => {
    render(<UserMessage text="[@crate.blend](<veistra://file/art/crate.blend>)" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("SessionList", () => {
  const sessions = [
    { id: "s1", title: "Fix the test", state: "working" as const, when: "now" },
    { id: "s2", title: "Older", state: null, when: "Mon" },
  ];

  it("marks the active row, and shows a state badge only where there is a state", () => {
    const { container } = render(
      <SessionList sessions={sessions} activeId="s1" onOpen={vi.fn()} />,
    );
    const rows = screen.getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(container.querySelectorAll(".at-status")).toHaveLength(1);
  });

  it("opens the row clicked", () => {
    const onOpen = vi.fn();
    render(<SessionList sessions={sessions} activeId={null} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Older/ }));
    expect(onOpen).toHaveBeenCalledWith("s2");
  });
});
