import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { strings } from "../strings";
import { featuredModels, newestModels } from "../preferences";
import { useSlots } from "./registry";
import type { HarnessChoice, ModelMenuProps, PickerChoice, PickerProps } from "./types";
import "./meters.css";
import "./preferences.css";

/** A section's choices, with a value the agent reports but does not offer kept in. */
function choicesOf({ value, choices }: PickerProps): PickerChoice[] {
  if (value === null || choices.some((c) => c.value === value)) return choices;
  return [{ value, name: value }, ...choices];
}

/** What a section is set to, in words, or `null` when it is unset. */
function nameOf(section: PickerProps): string | null {
  if (section.value === null) return null;
  const choice = section.choices.find((c) => c.value === section.value);
  return choice?.name || section.value;
}

/** The model a harness runs, in words, or `null` for its default. */
function modelOf({ model, models }: HarnessChoice): string | null {
  if (model === null) return null;
  return models.find((m) => m.value === model)?.name || model;
}

/**
 * A harness as a section: its models, checked where it is the harness in use.
 * With none known it lists its default, and an unavailable one lists why.
 * The empty value stands for "its own default".
 */
function sectionOf(
  harness: HarnessChoice,
  current: string | null,
  onChoose: ModelMenuProps["onChoose"],
): PickerProps {
  const why = harness.unavailable ?? harness.note;
  const choices: PickerChoice[] =
    why !== null
      ? [{ value: "", name: why }]
      : harness.models.length > 0
        ? harness.models
        : [{ value: "", name: strings.defaultModel }];
  const inUse = harness.id === current && harness.unavailable === null;
  return {
    label: harness.name,
    value: inUse ? (harness.models.length > 0 ? harness.model : "") : null,
    choices,
    disabled: why !== null,
    onChange: onChoose && ((value) => onChoose(harness.id, value === "" ? null : value)),
  };
}

/**
 * Every item the arrows step through, locked ones too: they stay focusable so a
 * screen reader can read them. The effort slider is one stop on the way; its
 * stop names are for the pointer and are left out.
 */
function itemsIn(menu: HTMLElement | null): HTMLElement[] {
  return [
    ...(menu?.querySelectorAll<HTMLElement>(
      'button:not(:disabled):not([tabindex="-1"]), input[type="range"]:not(:disabled)',
    ) ?? []),
  ];
}

/** A locked section whose one row is a sentence, such as why it is empty: drawn as a note. */
function isNote(section: PickerProps, choices: PickerChoice[]): boolean {
  return section.disabled === true && choices.length === 1 && choices[0].value === "";
}

/**
 * The composer's one settings button: harness, model, effort and mode, read
 * as "Claude · Opus 5.5 · High". It opens a menu with a group per harness,
 * its models under it, then a section per other setting. A section without
 * `onChange` is shown but cannot be changed.
 */
export function ModelMenu({
  label,
  harness = null,
  harnesses = [],
  onChoose,
  sections: settings,
  openRequest = 0,
  harnessLocked = false,
  ultracode,
}: ModelMenuProps) {
  const S = useSlots();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    // Start on the first setting that can change, at its checked item, so the
    // arrows move from where it is; failing that, anywhere that is checked.
    const items = itemsIn(menu.current);
    const checked = items.filter((el) => el.getAttribute("aria-checked") === "true");
    (
      checked.find((el) => el.getAttribute("aria-disabled") !== "true") ??
      checked[0] ??
      items[0]
    )?.focus();
    const away = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
      setMore(false);
      setBrowsing(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  /** Closes the menu, forgetting what was browsed in it. */
  const dismiss = () => {
    setOpen(false);
    setMore(false);
    setBrowsing(null);
  };
  const close = () => {
    dismiss();
    button.current?.focus();
  };

  // On the root, not the menu, so the keys work from the button as well as the
  // items. The menu itself takes focus on a click that lands on no item.
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!open) return;
    const items = itemsIn(menu.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        // Only the menu closes: no handler above it, on the page or the
        // document, acts on this Esc too.
        event.stopPropagation();
        close();
        break;
      case "ArrowDown":
        event.preventDefault();
        go(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        go(at - 1);
        break;
      case "Home":
        event.preventDefault();
        go(0);
        break;
      case "End":
        event.preventDefault();
        go(items.length - 1);
        break;
      case "Tab":
        // Focus would otherwise fall out of the page with the menu.
        event.preventDefault();
        close();
        break;
    }
  };

  const inUse = harnesses.find((h) => h.id === harness);
  const selected = harnesses.find((h) => h.id === browsing) ?? inUse ?? harnesses[0];
  const shown = [
    ...(inUse ? [inUse.name, modelOf(inUse)] : []),
    ...settings.map((s) =>
      s.label === strings.preferences.effort && harness === "claude" && ultracode?.enabled
        ? strings.preferences.ultracode
        : nameOf(s),
    ),
  ].filter((name) => name !== null);
  // A harness's checked item is the model it runs, so only the one in use has one.
  const modelSection = selected && sectionOf(selected, harness, onChoose);
  if (modelSection && selected.models.length > 0) {
    modelSection.label = strings.preferences.model;
    modelSection.choices = more
      ? newestModels(selected.models)
      : featuredModels(selected.models, selected.model);
    if (harnessLocked && selected.id !== harness) modelSection.disabled = true;
  }
  const sections = [...(modelSection ? [modelSection] : []), ...settings];
  return (
    <span className="at-model" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="at-model__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={[label, ...shown].join(strings.settingsSpoken)}
        title={label}
        onClick={() => (open ? dismiss() : setOpen(true))}
      >
        <span className="at-model__value">{shown.join(strings.settingsJoin)}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          ref={menu}
          role="menu"
          aria-label={label}
          className="at-model__menu"
          tabIndex={-1}
        >
          {harnesses.length > 0 && (
            <div
              className="at-model__harnesses"
              role="group"
              aria-label={strings.preferences.harness}
            >
              {harnesses.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  className="at-model__harness"
                  aria-pressed={h.id === selected?.id}
                  aria-disabled={
                    !onChoose || h.unavailable !== null || (harnessLocked && h.id !== harness)
                  }
                  title={
                    h.unavailable ??
                    (harnessLocked && h.id !== harness
                      ? strings.preferences.nextSession
                      : h.note
                        ? `${h.name}: ${h.note}`
                        : h.name)
                  }
                  data-note={h.note === null ? undefined : ""}
                  onClick={() => {
                    if (!onChoose || h.unavailable !== null || (harnessLocked && h.id !== harness))
                      return;
                    setBrowsing(h.id);
                    setMore(false);
                    if (h.id !== harness) onChoose?.(h.id, h.model);
                  }}
                >
                  {h.name}
                </button>
              ))}
            </div>
          )}
          {sections.map((section) => {
            if (section.label === strings.preferences.effort && section.choices.length > 0)
              return (
                <S.EffortPicker
                  key={section.label}
                  {...section}
                  ultra={harness === "claude" ? ultracode : undefined}
                />
              );
            const choices = choicesOf(section);
            if (choices.length === 0) return null;
            const locked = !section.onChange || section.disabled === true;
            const note = isNote(section, choices);
            return (
              <div
                key={section.label}
                role="group"
                aria-label={section.label}
                className="at-model__group"
                data-unavailable={section.disabled ? "" : undefined}
                title={section.title ?? undefined}
              >
                <div className="at-model__heading" aria-hidden="true">
                  {section.label}
                </div>
                {choices.map((choice) => {
                  const checked = choice.value === section.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      aria-disabled={locked}
                      className={note ? "at-model__item at-model__item--note" : "at-model__item"}
                      onClick={() => {
                        if (locked) return;
                        if (!checked) section.onChange?.(choice.value);
                        close();
                      }}
                    >
                      {!note && (
                        <span className="at-model__check">
                          {checked && <Check size={14} aria-hidden="true" />}
                        </span>
                      )}
                      <span className="at-model__name">{choice.name || choice.value}</span>
                      {choice.description && (
                        <span className="at-model__detail">{choice.description}</span>
                      )}
                    </button>
                  );
                })}
                {section === modelSection &&
                  selected &&
                  selected.models.length >
                    featuredModels(selected.models, selected.model).length && (
                    <button
                      type="button"
                      className="at-model__more"
                      aria-expanded={more}
                      onClick={() => setMore((was) => !was)}
                    >
                      {more ? strings.preferences.less : strings.preferences.more}
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                  )}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
