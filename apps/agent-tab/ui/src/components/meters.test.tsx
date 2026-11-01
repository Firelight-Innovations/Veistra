// @vitest-environment jsdom
/**
 * The composer footer's settings button and meters: what each shows at a
 * glance, what its popup lists, and how it opens and closes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { defaultSlots } from "./registry";
import type { HarnessChoice, PickerProps } from "./types";

const { ModelMenu, UsageRing, ContextMeter } = defaultSlots;

afterEach(cleanup);

function sections(onModel = vi.fn()): PickerProps[] {
  return [
    { label: "Agent", value: "claude", choices: [{ value: "claude", name: "Claude" }] },
    {
      label: "Model",
      value: "opus",
      choices: [
        { value: "opus", name: "Opus 5.5" },
        { value: "sonnet", name: "Sonnet 5.5", description: "Faster" },
      ],
      onChange: onModel,
    },
    { label: "Effort", value: "high", choices: [] },
    { label: "Mode", value: null, choices: [] },
  ];
}

describe("the model menu", () => {
  it("reads every setting that is set, in order", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    expect(screen.getByRole("button", { name: /Agent settings/ }).textContent).toBe(
      "Claude · Opus 5.5 · high",
    );
  });

  it("lists a section per setting, and changes one when it is picked", () => {
    const onModel = vi.fn();
    render(<ModelMenu label="Agent settings" sections={sections(onModel)} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));

    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    // A section with nothing to list (Mode, unset) is left out.
    expect(groups).toEqual(["Agent", "Model", "Effort"]);
    expect(
      screen.getByRole("menuitemradio", { name: "Claude" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "Opus 5.5" }).getAttribute("aria-checked"),
    ).toBe("true");
    // The checked item takes focus, so the arrows start from it.
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Opus 5.5" }));

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet 5.5/ }));
    expect(onModel).toHaveBeenCalledWith("sonnet");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves with the arrows and closes on Esc, back on its button", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    const button = screen.getByRole("button", { name: /Agent settings/ });
    fireEvent.click(button);
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Sonnet 5.5");

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("wraps with the arrows, and jumps to either end with Home and End", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    const items = screen.getAllByRole("menuitemradio");
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("closes when Tab leaves it", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps its keys after a click on a part of the menu that is not an item", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    const menu = screen.getByRole("menu");
    // A click on a heading or a gap focuses the menu, not the page.
    expect(menu.tabIndex).toBe(-1);
    menu.focus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lists a value the agent reports but does not offer, first and checked", () => {
    render(
      <ModelMenu
        label="Agent settings"
        sections={[
          {
            label: "Model",
            value: "haiku",
            choices: [{ value: "opus", name: "Opus 5.5" }],
            onChange: vi.fn(),
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((el) => el.textContent)).toEqual(["haiku", "Opus 5.5"]);
    expect(items[0].getAttribute("aria-checked")).toBe("true");
  });

  it("can be read and left from the keys when nothing in it can change", () => {
    const locked = sections().map(({ onChange: _, ...section }) => section);
    render(<ModelMenu label="Agent settings" sections={locked} />);
    const button = screen.getByRole("button", { name: /Agent settings/ });
    fireEvent.click(button);
    // A locked item still takes focus, so a screen reader can read the setting.
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Claude" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet 5.5/ }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    // Esc on the button itself, before focus moves in, closes it too.
    fireEvent.click(button);
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when the pointer goes down outside it", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the model menu's harnesses", () => {
  const HARNESSES: HarnessChoice[] = [
    {
      id: "claude",
      name: "Claude",
      models: [
        { value: "opus", name: "Opus 5.5" },
        { value: "sonnet", name: "Sonnet 5.5" },
      ],
      model: "opus",
      unavailable: null,
      note: null,
    },
    {
      id: "codex",
      name: "Codex",
      models: [{ value: "gpt-6-astra", name: "GPT-6 Astra" }],
      model: "gpt-6-astra",
      unavailable: null,
      note: null,
    },
    { id: "pi", name: "Pi", models: [], model: null, unavailable: null, note: null },
    {
      id: "veistra",
      name: "Veistra",
      models: [],
      model: null,
      unavailable: "Coming soon",
      note: null,
    },
  ];
  const EFFORT: PickerProps = { label: "Effort", value: "high", choices: [] };

  function menu(harness: string, onChoose?: (harness: string, model: string | null) => void) {
    render(
      <ModelMenu
        label="Agent settings"
        harness={harness}
        harnesses={HARNESSES}
        onChoose={onChoose}
        sections={[EFFORT]}
      />,
    );
    const button = screen.getByRole("button", { name: /Agent settings/ });
    return button;
  }

  it("reads the harness in use and its model first", () => {
    expect(menu("codex").textContent).toBe("Codex · GPT-6 Astra · high");
  });

  it("groups each harness's models under it, and checks only the one in use", () => {
    fireEvent.click(menu("claude", vi.fn()));
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Harness", "Model", "Effort"]);
    expect(screen.queryByRole("menuitemradio", { name: "GPT-6 Astra" })).toBeNull();
    const checked = screen
      .getAllByRole("menuitemradio")
      .filter((el) => el.getAttribute("aria-checked") === "true")
      .map((el) => el.textContent);
    // Codex's own model is not checked: Codex is not the harness in use.
    expect(checked).toEqual(["Opus 5.5", "high"]);
    expect(document.activeElement?.textContent).toBe("Opus 5.5");
  });

  it("picks a harness and a model in one choice", () => {
    const onChoose = vi.fn();
    fireEvent.click(menu("claude", onChoose));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6 Astra" }));
    expect(onChoose).toHaveBeenCalledWith("codex", "gpt-6-astra");
  });

  it("offers a harness with no known models at its default", () => {
    const onChoose = vi.fn();
    fireEvent.click(menu("claude", onChoose));
    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default model" }));
    expect(onChoose).toHaveBeenCalledWith("pi", null);
  });

  it("shows a harness that cannot run yet, locked, with why", () => {
    const onChoose = vi.fn();
    fireEvent.click(menu("claude", onChoose));
    const soon = screen.getByRole("button", { name: "Veistra" });
    expect(soon.getAttribute("aria-disabled")).toBe("true");
    expect(soon.title).toBe("Coming soon");
    fireEvent.click(soon);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("locks every harness without onChoose", () => {
    fireEvent.click(menu("claude"));
    expect(
      screen.getByRole("menuitemradio", { name: "Opus 5.5" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("compact preferences and friendly notices", () => {
  it("keeps older models behind More models and can collapse them again", () => {
    const models = ["Opus 4.6", "Opus 5.5", "Sonnet 5.5", "Fable 5.1", "Haiku 5.5"].map((name) => ({
      value: name,
      name,
    }));
    render(
      <ModelMenu
        label="Agent settings"
        harness="claude"
        harnesses={[
          {
            id: "claude",
            name: "Claude",
            model: "Opus 5.5",
            models,
            unavailable: null,
            note: null,
          },
        ]}
        onChoose={vi.fn()}
        sections={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    expect(screen.queryByRole("menuitemradio", { name: "Opus 4.6" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More models" }));
    expect(screen.getByRole("menuitemradio", { name: "Opus 4.6" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Latest models" }));
    expect(screen.queryByRole("menuitemradio", { name: "Opus 4.6" })).toBeNull();
  });

  it("disables unsupported effort levels and skips them with the keyboard", () => {
    const onChange = vi.fn();
    render(
      <defaultSlots.EffortPicker
        label="Effort"
        value="low"
        choices={[
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ]}
        onChange={onChange}
      />,
    );
    const unsupported = screen.getByRole("button", { name: "Xhigh" });
    expect((unsupported as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(unsupported);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Effort" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("keeps focus on the slider when a stop name is clicked or the reset goes away", () => {
    function Stateful() {
      const [value, setValue] = useState("high");
      return (
        <defaultSlots.EffortPicker
          label="Effort"
          value={value}
          choices={["low", "medium", "high"].map((v) => ({ value: v, name: v }))}
          onChange={setValue}
        />
      );
    }
    render(<Stateful />);
    const slider = screen.getByRole("slider", { name: "Effort" });
    fireEvent.click(screen.getByRole("button", { name: "Low" }));
    expect(document.activeElement).toBe(slider);
    const reset = screen.getByRole("button", { name: "Reset effort" });
    reset.focus();
    fireEvent.click(reset);
    // Back at Medium the reset has nothing to do and is gone; focus stays in the picker.
    expect(screen.queryByRole("button", { name: "Reset effort" })).toBeNull();
    expect(document.activeElement).toBe(slider);
  });

  it("previews only a stop that can be applied", () => {
    const { container } = render(
      <defaultSlots.EffortPicker
        label="Effort"
        value="low"
        choices={[{ value: "low", name: "Low" }]}
        onChange={vi.fn()}
      />,
    );
    const level = () => container.querySelector(".at-effort")?.getAttribute("data-level");
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Max" }));
    expect(level()).toBe("low");
  });

  it("includes Ultra as a Claude slider stop that changes the current conversation", () => {
    const onChange = vi.fn();
    render(
      <ModelMenu
        label="Agent settings"
        harness="claude"
        sections={[
          {
            label: "Effort",
            value: "high",
            choices: [{ value: "high", name: "High" }],
            onChange: vi.fn(),
          },
        ]}
        ultracode={{ enabled: true, disabled: false, onChange }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    const slider = screen.getByRole("slider", { name: "Effort" });
    expect(slider.getAttribute("aria-valuetext")).toBe("Ultra effort");
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(onChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Ultra effort" }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("makes a usage-limit notice readable and dismissible without losing the reset time", () => {
    const onRetry = vi.fn();
    render(
      <defaultSlots.ErrorItem
        message="Internal error: You've hit your session limit · resets 11:50pm (America/Chicago)"
        hint={null}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("11:50pm (America/Chicago)");
    expect(screen.getByRole("status").textContent).not.toContain("Internal error");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the usage ring", () => {
  const limits = [
    { id: "session", label: "Session limit", share: 0.86, resets: "Resets in 22 min" },
    { id: "week", label: "Weekly", share: 0.45, resets: "Resets Fri 7:00 AM" },
  ];

  it("draws nothing until there is a limit", () => {
    const { container } = render(<UsageRing limits={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("fills to the tightest limit, and lists each one on hover", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<UsageRing limits={limits} />);
      const button = screen.getByRole("button", { name: "Usage: 86% of the tightest limit used" });
      expect(container.querySelector(".at-ring")?.getAttribute("data-tone")).toBe("high");

      const card = screen.getByRole("tooltip", { hidden: true });
      expect(card.hasAttribute("data-open")).toBe(false);
      fireEvent.pointerEnter(button.parentElement!);
      expect(card.hasAttribute("data-open")).toBe(true);
      expect(card.textContent).toContain("Session limit86% used");
      expect(card.textContent).toContain("Resets Fri 7:00 AM");
      expect([...card.querySelectorAll(".at-bar")].map((b) => b.getAttribute("data-tone"))).toEqual(
        ["high", "low"],
      );

      // It lingers long enough for the pointer to reach the card.
      fireEvent.pointerLeave(button.parentElement!);
      expect(card.hasAttribute("data-open")).toBe(true);
      act(() => void vi.advanceTimersByTime(200));
      expect(card.hasAttribute("data-open")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on focus and closes on Esc", () => {
    render(<UsageRing limits={limits} />);
    const button = screen.getByRole("button");
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip", { hidden: true }).hasAttribute("data-open")).toBe(true);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.getByRole("tooltip", { hidden: true }).hasAttribute("data-open")).toBe(false);
  });

  it("closes on Esc when hover opened it and focus is elsewhere", () => {
    render(<UsageRing limits={limits} />);
    fireEvent.pointerEnter(screen.getByRole("button").parentElement!);
    expect(screen.getByRole("tooltip", { hidden: true }).hasAttribute("data-open")).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("tooltip", { hidden: true }).hasAttribute("data-open")).toBe(false);
  });
});

describe("the context meter", () => {
  it("draws nothing before the first usage report", () => {
    const { container } = render(<ContextMeter used={null} size={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows how full the window is, and what is used and free", () => {
    render(<ContextMeter used={124_600} size={300_000} />);
    // A ring alone, as Claude Code draws it; the share is in its name and its card.
    expect(screen.getByRole("button", { name: "Context window 42% full" }).textContent).toBe("");
    const card = screen.getByRole("tooltip", { hidden: true });
    expect(card.querySelector(".at-card__head")?.textContent).toBe(
      "Context window124.6k / 300k (42%)",
    );
    const rows = [...card.querySelectorAll(".at-rows__row")].map((r) => r.textContent);
    expect(rows).toEqual(["Used124.6k42%", "Free space175.4k58%"]);
  });

  it("fills its ring as far as the window is full, and no further", () => {
    const around = 2 * Math.PI * 6;
    const fill = (used: number) => {
      const { container } = render(<ContextMeter used={used} size={300_000} />);
      const ring = container.querySelector<SVGElement>(".at-ring")!;
      const dash = ring.querySelector(".at-ring__fill")!.getAttribute("stroke-dasharray")!;
      cleanup();
      return [
        Math.round((Number(dash.split(" ")[0]) / around) * 100),
        ring.getAttribute("data-tone"),
      ];
    };
    expect(fill(124_600)).toEqual([42, "low"]);
    expect(fill(255_000)).toEqual([85, "high"]);
    expect(fill(288_000)).toEqual([96, "full"]);
    expect(fill(400_000)).toEqual([100, "full"]);
  });

  it("breaks the used tokens down when the agent says what they are", () => {
    render(
      <ContextMeter
        used={30_000}
        size={100_000}
        categories={[
          { id: "messages", label: "Messages", tokens: 20_000 },
          { id: "tools", label: "System tools", tokens: 10_000 },
        ]}
      />,
    );
    const card = screen.getByRole("tooltip", { hidden: true });
    expect([...card.querySelectorAll(".at-rows__row dt")].map((r) => r.textContent)).toEqual([
      "Messages",
      "System tools",
      "Free space",
    ]);
    const parts = [...card.querySelectorAll<HTMLElement>(".at-stack__part")];
    expect(parts.map((p) => p.style.width)).toEqual(["20%", "10%"]);
  });
});

describe("the ring", () => {
  const { Ring } = defaultSlots;
  const AROUND = 2 * Math.PI * 6;
  const dash = (share: number) => {
    const { container } = render(<Ring share={share} tone="low" />);
    const value = container.querySelector(".at-ring__fill")!.getAttribute("stroke-dasharray");
    cleanup();
    return value;
  };

  it("fills as far as its share, clamped to empty and full", () => {
    expect(dash(0.5)).toBe(`${AROUND / 2} ${AROUND}`);
    expect(dash(1.5)).toBe(`${AROUND} ${AROUND}`);
    expect(dash(-0.5)).toBe(`0 ${AROUND}`);
  });
});
