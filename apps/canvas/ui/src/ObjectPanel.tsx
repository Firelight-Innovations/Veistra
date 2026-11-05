import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardCopy, ExternalLink, Link2Off, Settings2 } from "lucide-react";
import { chipToAgent, type ContextRef } from "../../../shared/context";
import { SendButton } from "../../../shared/SendFooter";
import type { CanvasSummary } from "./rpc";
import { linkable } from "./nesting";
import {
  fieldText,
  modelDraft,
  parseInput,
  valueOf,
  type FieldDef,
  type FrameObject,
  type TypeDef,
} from "./objects";
import { dragContext } from "./sendToAgent";
import { exportDraft, validateDraft } from "./spec";
import TypeIcon from "./TypeIcon";

export interface FrameView {
  id: string;
  name: string;
  object: FrameObject | null;
  child: string | null;
}

interface Props {
  frame: FrameView;
  types: TypeDef[];
  readOnly: boolean;
  /** Stored reference images, offered as one-click links on path-list fields. */
  refs: { name: string; path: string }[];
  /** Focus and select the name, for a frame that was just made. */
  focusName: boolean;
  canvases: CanvasSummary[];
  current: string;
  onName: (name: string) => void;
  onType: (typeId: string) => void;
  onProp: (key: string, value: unknown) => void;
  onOpenChild: (id: string) => void;
  onUnlink: () => void;
  onCreateChild: (name: string) => void;
  onLinkExisting: (id: string) => void;
  onManageTypes: () => void;
  putCard: (name: string, json: string) => Promise<ContextRef>;
  onSendError: (message: string) => void;
  /** The shared footer's slot: Send card renders there, not in the panel. */
  sendSlot: HTMLElement | null;
}

interface FieldProps {
  field: FieldDef;
  value: unknown;
  disabled: boolean;
  refs: { name: string; path: string }[];
  onCommit: (value: unknown) => void;
}

/**
 * One field of a type, drawn by its kind. Text is held locally and committed on
 * blur, so typing does not rewrite the file on every key; choices commit at once.
 */
function FieldInput({ field, value, disabled, refs, onCommit }: FieldProps) {
  const id = useId();
  const shown = fieldText(field, value);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);

  const commit = (raw: string) => {
    focused.current = false;
    const parsed = parseInput(field, raw);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (fieldText(field, parsed.value) !== shown) onCommit(parsed.value);
  };

  const label = <label htmlFor={id}>{field.label}</label>;
  const note = error ? (
    <small className="cv__field-error" role="alert">
      {error}
    </small>
  ) : field.help ? (
    <small className="cv__hint">{field.help}</small>
  ) : null;

  if (field.kind === "bool") {
    return (
      <div className="cv__field cv__field--check">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.checked)}
        />
        {label}
      </div>
    );
  }
  if (field.kind === "enum") {
    return (
      <div className="cv__field">
        {label}
        <select
          id={id}
          className="cv__select"
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value)}
        >
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {note}
      </div>
    );
  }
  const area = field.kind === "multiline" || field.kind === "path-list";
  const shared = {
    id,
    className: "cv__input",
    value: text,
    disabled,
    "aria-invalid": error ? true : undefined,
    onFocus: () => {
      focused.current = true;
    },
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: (e: { target: { value: string } }) => commit(e.target.value),
  };
  return (
    <div className="cv__field">
      {label}
      {area ? (
        <textarea {...shared} rows={3} />
      ) : (
        <input
          {...shared}
          inputMode={field.kind === "number" ? "decimal" : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
          }}
        />
      )}
      {field.kind === "path-list" && !disabled && refs.length > 0 && (
        <div className="cv__row" role="group" aria-label="Link a stored reference image">
          {refs
            .filter((r) => !text.split("\n").some((l) => l.trim() === r.path))
            .map((r) => (
              <button
                key={r.path}
                type="button"
                className="cv__chip"
                title={r.path}
                onClick={() => {
                  const next = [text.trim(), r.path].filter(Boolean).join("\n");
                  setText(next);
                  commit(next);
                }}
              >
                + {r.name}
              </button>
            ))}
        </div>
      )}
      {note}
    </div>
  );
}

/**
 * The Inspector for a selected frame: its name, its type, that type's fields,
 * and its child canvas. A frame is the unit of detail, so this is the only place
 * detail is entered; a plain shape shows its frame's summary instead.
 */
export default function ObjectPanel(p: Props) {
  const { frame, types, readOnly, canvases, current } = p;
  const def = types.find((t) => t.id === frame.object?.type) ?? null;
  const props = useMemo(() => frame.object?.props ?? {}, [frame.object]);
  const [name, setName] = useState(frame.name);
  const [childName, setChildName] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const nameFocused = useRef(false);
  useEffect(() => {
    if (!nameFocused.current) setName(frame.name);
  }, [frame.name]);
  useEffect(() => {
    if (p.focusName) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [p.focusName, frame.id]);

  const options = useMemo(
    () => linkable(canvases, current).filter((c) => c.id !== frame.child),
    [canvases, current, frame.child],
  );
  const picker = options.length > 0 && !readOnly && (
    <div className="cv__frame-form">
      <select
        className="cv__select"
        aria-label="Link to canvas"
        value=""
        onChange={(e) => {
          if (e.target.value) p.onLinkExisting(e.target.value);
        }}
      >
        <option value="">{frame.child ? "Link to another canvas..." : "Link to canvas..."}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
    </div>
  );
  const model = frame.object?.type === "model";
  const draft = useMemo(() => modelDraft(frame.name, props), [frame.name, props]);
  const exported = useMemo(() => exportDraft(draft), [draft]);
  const issues = useMemo(() => validateDraft(draft), [draft]);

  const copy = async () => {
    if (!exported.ok) {
      setCopied("Fill in the name, size and triangle budget first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exported.json);
      setCopied("Copied the JSON.");
    } catch {
      setCopied("The clipboard is not available. Select the JSON below and copy it.");
    }
  };

  const sendCard = () => {
    if (!exported.ok) return;
    p.putCard(draft.name, exported.json)
      // One chip on the prompt of the agent tab last worked in; no words.
      .then((item) => chipToAgent(item))
      .then(
        (said) => {
          if (!said.delivered) {
            p.onSendError(
              `The card is in the Context strip, but no agent took it: ${said.reason}.`,
            );
            return;
          }
          setSent(true);
          setTimeout(() => setSent(false), 1800);
        },
        (err: unknown) =>
          p.onSendError(
            `Couldn't send the card to the agent: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
  };

  return (
    <section className="cv__object cv__side-section" aria-label="Frame">
      <div className="cv__spec-head">
        <strong>Frame</strong>
        {def ? (
          <span className="cv__typechip" style={{ borderColor: def.color }}>
            <TypeIcon icon={def.icon} color={def.color} size={12} /> {def.name}
          </span>
        ) : (
          frame.object && <span className="cv__typechip">{frame.object.type} (type missing)</span>
        )}
      </div>

      <div className="cv__field">
        <label htmlFor="frame-name">Name</label>
        <input
          id="frame-name"
          ref={nameRef}
          className="cv__input"
          value={name}
          disabled={readOnly}
          placeholder="What the agent will call this"
          onFocus={() => {
            nameFocused.current = true;
          }}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            nameFocused.current = false;
            if (name !== frame.name) p.onName(name);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>

      <div className="cv__field">
        <label htmlFor="frame-type">Type</label>
        <select
          id="frame-type"
          className="cv__select"
          value={frame.object?.type ?? ""}
          disabled={readOnly}
          onChange={(e) => p.onType(e.target.value)}
        >
          {!frame.object && (
            <option value="" disabled>
              Choose a type...
            </option>
          )}
          {frame.object && !def && (
            <option value={frame.object.type}>{frame.object.type} (missing)</option>
          )}
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {def?.description && <small className="cv__hint">{def.description}</small>}
      </div>

      {def?.fields.map((f) => (
        <FieldInput
          key={`${def.id}:${f.key}`}
          field={f}
          value={valueOf(f, props)}
          disabled={readOnly}
          refs={p.refs}
          onCommit={(v) => p.onProp(f.key, v)}
        />
      ))}
      {!frame.object && !readOnly && (
        <p className="cv__hint">Pick a type to describe this frame for the agent.</p>
      )}

      {model && (
        <div className="cv__spec-actions">
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            onClick={() => void copy()}
          >
            <ClipboardCopy size={14} aria-hidden /> Copy JSON
          </button>
          {p.sendSlot &&
            createPortal(
              <SendButton
                label="Send card"
                sent={sent}
                disabled={!exported.ok}
                title="Add this card, as JSON, to the agent's context. Drag to a terminal to send it."
                onPointerDown={
                  exported.ok ? dragContext(() => p.putCard(draft.name, exported.json)) : undefined
                }
                onClick={sendCard}
              />,
              p.sendSlot,
            )}
        </div>
      )}
      {model && Object.keys(issues).length > 0 && (
        <small className="cv__hint">To export this card: {Object.values(issues).join(" ")}</small>
      )}
      {copied && <small role="status">{copied}</small>}
      {model && exported.ok && (
        <pre className="cv__json" aria-label="Exported JSON">
          {exported.json}
        </pre>
      )}

      {!readOnly && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm cv__manage"
          onClick={p.onManageTypes}
        >
          <Settings2 size={14} aria-hidden /> Manage types
        </button>
      )}

      {(frame.child || !readOnly) && (
        <div className="cv__frame" aria-label="Child canvas">
          <h3>Child canvas</h3>
          {frame.child ? (
            <>
              <span className="cv__frame-label">
                Linked to <code>{frame.child}</code>
              </span>
              <div className="cv__spec-actions">
                <button
                  type="button"
                  className="k-btn k-btn--primary k-btn--sm"
                  onClick={() => p.onOpenChild(frame.child!)}
                >
                  <ExternalLink size={14} aria-hidden /> Open child canvas
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    className="k-btn k-btn--ghost k-btn--sm"
                    onClick={p.onUnlink}
                  >
                    <Link2Off size={14} aria-hidden /> Unlink
                  </button>
                )}
              </div>
              {picker}
            </>
          ) : (
            <>
              <form
                className="cv__frame-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  p.onCreateChild(childName);
                  setChildName("");
                }}
              >
                <input
                  className="cv__input"
                  aria-label="Child canvas name"
                  placeholder={frame.name || "Child canvas name"}
                  value={childName}
                  onChange={(e) => setChildName(e.target.value)}
                />
                <button type="submit" className="k-btn k-btn--secondary k-btn--sm">
                  Create child canvas
                </button>
              </form>
              {picker}
            </>
          )}
        </div>
      )}
    </section>
  );
}
