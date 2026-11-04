/**
 * Record's settings (the "Record settings" board, #321): a chevron beside
 * Record opens them under the toolbar. Record every run, the quality and how
 * many takes to keep are this project's, on this computer (X9), and are kept
 * by `play/record`; the quality and keep apply from the next take, never to
 * the one recording. The folder is shown, not chosen: retention, the asset
 * scope and the git exclude all assume takes live where Rust puts them.
 *
 * The game is a native window over the pane, so the page says when this is
 * open (`onOpen`) and Play mode counts it as covering the frame.
 */
import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { SegmentedControl } from "../../../../shared/SegmentedControl";
import { ToolbarButton } from "../../../../shared/ViewerToolbar";
import type { RecordQuality, RecordSettings as Settings } from "./rpc";

/** What each quality costs, as the board puts it: two minutes of play. */
const QUALITIES = [
  { value: "720p30", label: "720p · 30 fps", size: "About 53 MB for two minutes." },
  { value: "1080p60", label: "1080p · 60", size: "About 120 MB for two minutes." },
] as const;

/** The keeps offered; a different one set elsewhere is listed too. */
const KEEPS = [5, 10, 20, 50];
/** What Rust uses when nothing was set (owner decision: keep 10). */
const DEFAULT_KEEP = 10;

export interface RecordSettingsProps {
  open: boolean;
  onOpen: (open: boolean) => void;
  record: Settings;
  /** Record every run, on or off: the same as the Record button. */
  onRecord: () => void;
  onChange: (settings: { quality?: RecordQuality; keep?: number }) => void;
  onReveal: () => void;
}

export function RecordSettings(props: RecordSettingsProps) {
  const { open, onOpen, record } = props;
  const wrap = useRef<HTMLSpanElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const quality = record.quality ?? "720p30";
  const keep = record.keep ?? DEFAULT_KEEP;
  const keeps = KEEPS.includes(keep) ? KEEPS : [...KEEPS, keep].sort((a, b) => a - b);
  const blocked = record.blocked;

  // Escape and a press anywhere else close it, as a menu would. Escape hands
  // the focus back to the chevron, so the keyboard is not left nowhere.
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onOpen(false);
      wrap.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) onOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, onOpen]);

  return (
    <span className="pl-recset" ref={wrap}>
      <ToolbarButton
        label="Settings for Record"
        expanded={open}
        icon={<ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => onOpen(!open)}
      />
      {open && (
        <div className="pl-recset__pop" role="dialog" aria-label="Record settings">
          <strong className="pl-recset__title">Record settings</strong>
          <label className="pl-recset__row">
            <input
              ref={first}
              type="checkbox"
              checked={record.on}
              disabled={blocked !== null && !record.on}
              onChange={props.onRecord}
            />
            <span>
              Record every run
              <span className="pl-recset__hint">
                {blocked ?? "For this project, on this computer."}
              </span>
            </span>
          </label>
          <div className="pl-recset__row pl-recset__row--column">
            <span className="pl-recset__label">Quality</span>
            <SegmentedControl
              aria-label="Quality"
              value={quality}
              options={QUALITIES}
              onChange={(q) => q !== quality && props.onChange({ quality: q })}
            />
            <span className="pl-recset__hint">
              {QUALITIES.find((q) => q.value === quality)?.size} From the next take.
            </span>
          </div>
          <label className="pl-recset__row">
            <span className="pl-recset__label">Keep last</span>
            <select
              aria-label="Takes to keep"
              value={keep}
              onChange={(e) => props.onChange({ keep: Number(e.target.value) })}
            >
              {keeps.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <span>takes, notes kept forever</span>
          </label>
          <div className="pl-recset__row">
            <span className="pl-recset__label">Folder</span>
            <code className="pl-recset__dir" title={record.dir ?? undefined}>
              {record.inEnvironment === false
                ? "Outside this read-only checkout"
                : ".veistra/takes/ · git-ignored"}
            </code>
            <button type="button" className="k-btn k-btn--ghost k-btn--sm" onClick={props.onReveal}>
              Show folder
            </button>
          </div>
          <div className="pl-recset__row pl-recset__row--later">
            <span>Talk while you play</span>
            <span className="pl-chip">Later</span>
          </div>
        </div>
      )}
    </span>
  );
}
