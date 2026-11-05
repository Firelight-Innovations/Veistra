import { useEffect, useRef, useState, type MouseEvent } from "react";
import { chipSegments } from "../mentions";
import { strings } from "../strings";
import { Mic, Pencil, Plus, X } from "lucide-react";
import { useSlots } from "./registry";
import type { ComposerProps } from "./types";
import "./composer.css";
import "./composer-effects.css";
import "./kinds.css";

/** What a press on the card that misses its controls should not take focus from. */
const INTERACTIVE = "button, a, input, textarea, select, [role='menu'], [role='listbox']";

/**
 * The prompt box: notices, then one rounded card holding the chips, the input,
 * and a toolbar along its foot — attach at the left, dictation and Send or Stop
 * at the right. Below the card, as in Claude Code, sit the settings button
 * (model, effort, mode) and the meters.
 *
 * Pressing anywhere on the card that is not a control puts the caret in the
 * input, the way a text field the size of the card would.
 */
export function Composer({
  ref,
  value,
  placeholder,
  onChange,
  onKeyDown,
  notices,
  menu,
  menuActiveId,
  controls,
  meters,
  action,
  onAttach,
  onDictate,
  onSelect,
  sideChat,
  plan,
  auxiliary,
  chips = [],
  images = [],
  onPasteImages,
  onRemoveImage,
  queued = [],
  onUnqueue,
  onReplaceImage,
  effortLevel,
}: ComposerProps) {
  const focusInput = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
    event.preventDefault();
    const input = event.currentTarget.querySelector("textarea");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  };
  // Turning Ultra on sweeps the card once, then it is the plain card again.
  // No other effort change touches it.
  const [surge, setSurge] = useState(false);
  const lastEffort = useRef(effortLevel);
  useEffect(() => {
    const was = lastEffort.current;
    lastEffort.current = effortLevel;
    if (was === effortLevel) return;
    setSurge(effortLevel === "ultra");
    if (effortLevel !== "ultra") return;
    const timer = window.setTimeout(() => setSurge(false), 1400);
    return () => window.clearTimeout(timer);
  }, [effortLevel]);
  const S = useSlots();
  const floating = auxiliary ?? menu;
  const [viewing, setViewing] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const shown = images.find((image) => image.id === viewing);
  // Skills lead the prompt, so they sit ahead of the input. A reference sits in
  // the text where it was picked: the input holds its `@label`, and a mirror
  // under it draws that run as a chip, the same width so the caret lines up.
  const skills = chips.filter((chip) => !chip.uri);
  const segments = chipSegments(value, chips);
  const inline = segments.some((part) => part.chip);
  const mirror = useRef<HTMLDivElement>(null);
  return (
    <footer className="at-prompt" data-surge={surge ? "" : undefined}>
      {sideChat}
      {plan}
      {notices}
      {floating && <div className="at-prompt__menu">{floating}</div>}
      {queued.length > 0 && (
        <ul className="at-queue" aria-label={strings.queuedLabel}>
          {queued.map((item) => (
            <li key={item.id} className="at-queue__item">
              <span className="at-queue__text">{item.text || strings.queuedLabel}</span>
              <button
                type="button"
                className="at-queue__remove"
                aria-label={strings.unqueue}
                title={strings.unqueue}
                onClick={() => onUnqueue?.(item.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="at-prompt__box" onMouseDown={focusInput}>
        {images.length > 0 && (
          <div className="at-prompt__images">
            {images.map((image) => (
              <div key={image.id} className="at-thumb">
                <button
                  type="button"
                  className="at-thumb__open"
                  aria-label={strings.viewImage}
                  onClick={() => setViewing(image.id)}
                >
                  <img src={`data:${image.mime};base64,${image.data}`} alt="" />
                </button>
                <button
                  type="button"
                  className="at-thumb__remove"
                  aria-label={strings.removeImage}
                  title={strings.removeImage}
                  onClick={() => onRemoveImage?.(image.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="at-prompt__field">
          {skills.length > 0 && (
            <div className="at-prompt__chips">
              {skills.map((chip) => {
                return (
                  <span
                    key={chip.id}
                    className="at-chip"
                    role="group"
                    aria-label={chip.label}
                    data-kind={chip.kind}
                    title={chip.uri ?? chip.command}
                  >
                    <span>
                      {chip.command ? "" : "@"}
                      {chip.label}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
          <div className="at-prompt__editor" data-inline={inline ? "" : undefined}>
            {inline && (
              <div ref={mirror} className="at-prompt__mirror" aria-hidden="true">
                {segments.map((part) =>
                  part.chip ? (
                    <span
                      key={part.start}
                      className="at-chip"
                      role="group"
                      aria-label={part.chip.label}
                      data-kind={part.chip.kind}
                    >
                      {part.text}
                    </span>
                  ) : (
                    part.text
                  ),
                )}
                {/* A last line break draws a line only with something after it. */}
                {"​"}
              </div>
            )}
            <textarea
              ref={ref}
              className="at-prompt__input"
              aria-label={strings.promptLabel}
              placeholder={placeholder}
              value={value}
              rows={1}
              aria-activedescendant={menuActiveId ? `menu-item-${menuActiveId}` : undefined}
              onChange={(event) => onChange(event.target.value, event.target.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.items)
                  .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                  .flatMap((item) => item.getAsFile() ?? []);
                if (files.length === 0) return;
                event.preventDefault();
                onPasteImages?.(files);
              }}
              onSelect={(event) => onSelect?.(event.currentTarget.selectionStart)}
              onScroll={(event) => {
                if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
              }}
            />
          </div>
        </div>
        <div className="at-prompt__toolbar">
          <button
            className="at-prompt__icon"
            type="button"
            aria-label={strings.attachContext}
            title={strings.attachContext}
            onClick={onAttach}
          >
            <Plus size={16} />
          </button>
          <span className="at-prompt__spacer" />
          <button
            className="at-prompt__icon"
            type="button"
            aria-label={strings.dictate}
            title={strings.dictateLater}
            onClick={onDictate}
          >
            <Mic size={15} />
          </button>
          {action}
        </div>
      </div>
      <div className="at-prompt__foot">
        {controls}
        <span className="at-prompt__spacer" />
        {meters}
      </div>
      {shown && (
        <div
          className="at-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={strings.viewImage}
          onClick={() => setViewing(null)}
        >
          <img src={`data:${shown.mime};base64,${shown.data}`} alt="" />
          <button
            type="button"
            className="at-lightbox__close at-lightbox__edit"
            aria-label={strings.markup.open}
            title={strings.markup.open}
            onClick={(event) => {
              event.stopPropagation();
              setMarking(true);
            }}
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="at-lightbox__close"
            aria-label={strings.closeImage}
            onClick={() => setViewing(null)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      )}
      {shown && marking && (
        <S.MarkupEditor
          src={`data:${shown.mime};base64,${shown.data}`}
          onClose={() => setMarking(false)}
          onSave={(mime, data) => {
            onReplaceImage?.(shown.id, { mime, data });
            setMarking(false);
          }}
        />
      )}
    </footer>
  );
}
