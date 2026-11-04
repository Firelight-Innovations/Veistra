/**
 * Compare mode (#319, spec §12): what changed between two kept versions of a
 * `.blend`. The pickers choose A and B. Changes draws the diff's four classes
 * and Split draws A left of a divider and B right of it, both under one camera
 * (`CompareView` in `@veistra/scene-view`, whose diff runs in a worker). The
 * side list is each part with its counts and material changes, then the notes
 * made on A, with Looks good and Still broken.
 *
 * Keep B and Go back to A are DECISIONS X12's minimum, flagged to the owner.
 * Keep pins B so pruning never takes it and changes no file. Go back opens A's
 * own copy of the `.blend` in Editor mode when the version kept one, and is
 * disabled with that reason when it did not.
 *
 * The app loads this module lazily, so three.js stays out of its first chunk.
 * Editor mode is unmounted while it shows, which hides the embedded Blender.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Pin, RotateCcw, SkipForward } from "lucide-react";
import {
  CHANGE_CLASSES,
  CompareView,
  useCompare,
  type ChangeClass,
  type CompareMode as CompareViewMode,
  type CompareViewHandle,
} from "@veistra/scene-view";
import { anchorLabel, statusView, verdictComment, type Verdict } from "../../../../shared/comments";
import type { Comment } from "../../../../shared/comments";
import { canLaunch } from "../../../../shared/editorSurface";
import { decodeBase64 } from "../../../../shared/sceneNodes";
import { SegmentedControl } from "../../../../shared/SegmentedControl";
import {
  ToolbarEnvChip,
  ViewerToolbar,
  type ToolbarMode,
  type ToolbarStatus,
} from "../../../../shared/ViewerToolbar";
import { COMPARE_NEEDS_TWO, type BlenderMode } from "../modes";
import {
  getVersionGlb,
  keepVersion,
  listVersions,
  type BlenderViewerState,
  type VersionEntry,
  type VersionList,
} from "../rpc";
import {
  ALL_SHOWN,
  defaultPicks,
  materialChanges,
  notesFrom,
  stepRegion,
  toggleClass,
  versionLabel,
  type Picks,
} from "./state";
import "./compare.css";

export interface CompareModeProps {
  /** Slot 1 of the toolbar. */
  modeSwitch: ToolbarMode<BlenderMode>;
  viewer: BlenderViewerState;
  /** B as the Editor banner's "Compare with v<n>" asked for it; the newest otherwise. */
  initialB: number | null;
  comments: readonly Comment[];
  onCommentsChanged: () => unknown;
  /** Go back to A: open this `.blend` (absolute) in Editor mode. */
  onOpenBlend: (path: string) => Promise<void>;
}

const VIEWS = [
  { value: "changes", label: "Changes" },
  { value: "split", label: "Split" },
] as const;

export const CLASS_LABEL: Record<ChangeClass, string> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
  unchanged: "Unchanged",
};

const READ_ONLY = "main is read-only. Open a worktree to keep a version or answer a note.";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Both picks still name kept versions, so a new export leaves the choice alone. */
function stillKept(picks: Picks | null, list: VersionList): Picks | null {
  const has = (n: number) => list.versions.some((v) => v.n === n);
  return picks && has(picks.a) && has(picks.b) ? picks : null;
}

function counts(c: Record<ChangeClass, number>): string {
  const bits = CHANGE_CLASSES.filter((k) => k !== "unchanged" && c[k] > 0).map(
    (k) => `${c[k]} ${k}`,
  );
  return bits.length > 0 ? bits.join(" · ") : "no change";
}

export default function CompareMode(props: CompareModeProps) {
  const { viewer, modeSwitch, comments, onCommentsChanged, onOpenBlend } = props;
  const blend = viewer.blend;
  const [list, setList] = useState<VersionList | null>(null);
  const [picks, setPicks] = useState<Picks | null>(null);
  const [glbs, setGlbs] = useState<{ a: ArrayBuffer | null; b: ArrayBuffer | null }>({
    a: null,
    b: null,
  });
  const [view, setView] = useState<CompareViewMode>("changes");
  const [shown, setShown] = useState(ALL_SHOWN);
  const [split, setSplit] = useState(0.5);
  const [region, setRegion] = useState(-1);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handle = useRef<CompareViewHandle | null>(null);
  const cache = useRef(new Map<string, ArrayBuffer>());
  const initialB = useRef(props.initialB);

  const versionsKey = viewer.versions.join(",");
  const reload = useCallback(async () => {
    if (!blend) return;
    const next = await listVersions(blend);
    setList(next);
    setPicks(
      (cur) => stillKept(cur, next) ?? defaultPicks(next.versions, next.kept, initialB.current),
    );
  }, [blend]);

  useEffect(() => {
    reload().catch((err: unknown) => setProblem(message(err)));
  }, [reload, versionsKey]);

  // A version never changes once written, so its bytes are fetched once.
  useEffect(() => {
    if (!blend || !picks) return;
    let live = true;
    const bytesOf = async (n: number) => {
      const key = `${blend}#${n}`;
      const hit = cache.current.get(key);
      if (hit) return hit;
      const bytes = decodeBase64((await getVersionGlb(blend, n)).base64);
      cache.current.set(key, bytes);
      return bytes;
    };
    Promise.all([bytesOf(picks.a), bytesOf(picks.b)]).then(
      ([a, b]) => live && setGlbs({ a, b }),
      (err: unknown) => live && setProblem(message(err)),
    );
    return () => {
      live = false;
    };
  }, [blend, picks]);

  const diff = useCompare(glbs.a, glbs.b);
  const result = diff.kind === "ready" ? diff.outcome.result : null;
  useEffect(() => setRegion(-1), [result]);

  const regions = useMemo(() => result?.regions ?? [], [result]);
  const next = useCallback(
    (back: boolean) => {
      const at = stepRegion(region, regions.length, back);
      setRegion(at);
      const r = regions[at];
      if (r) handle.current?.frameBox(r.min, r.max);
    },
    [region, regions],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e.target)) return;
      e.preventDefault();
      next(e.shiftKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next]);

  const byN = (n: number | undefined) => list?.versions.find((v) => v.n === n) ?? null;
  const a = byN(picks?.a);
  const b = byN(picks?.b);
  const notes = useMemo(
    () => (a && b && viewer.rel ? notesFrom(comments, viewer.rel, a, b) : []),
    [comments, viewer.rel, a, b],
  );

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(false);
    }
  };
  const answer = (id: string, verdict: Verdict) =>
    act(async () => {
      await verdictComment(id, verdict);
      await onCommentsChanged();
    });

  const status: ToolbarStatus | null =
    a && b
      ? {
          tone: diff.kind === "error" ? "danger" : "info",
          label: `v${a.n} → v${b.n}`,
          title:
            diff.kind === "running" || diff.kind === "idle"
              ? `Finding what changed from v${a.n} to v${b.n}…`
              : `A is v${a.n}, B is v${b.n}.`,
        }
      : null;

  const picker = (side: "a" | "b", value: VersionEntry | null, other: VersionEntry | null) => (
    <label className="cmp__pick">
      <span className="cmp__pick-side">{side.toUpperCase()}</span>
      <select
        className="k-vtb__select"
        aria-label={`Version ${side.toUpperCase()}`}
        value={value?.n ?? ""}
        onChange={(e) => {
          const n = Number(e.target.value);
          setPicks((cur) => (cur ? { ...cur, [side]: n } : cur));
        }}
      >
        {list?.versions.map((v) => (
          <option key={v.n} value={v.n} disabled={v.n === other?.n}>
            {versionLabel(v)}
            {list.kept === v.n ? " · kept" : ""}
          </option>
        ))}
      </select>
    </label>
  );

  const launchable = canLaunch(viewer.editor ?? null);
  const goBackWhy = !a
    ? null
    : viewer.readOnly
      ? READ_ONLY
      : !a.blendCopy
        ? `v${a.n} kept no copy of its .blend, so there is nothing to go back to. Your file is unchanged.`
        : !launchable
          ? (viewer.editor?.reason ?? "Blender cannot open here.")
          : null;
  const keptB = b !== null && list?.kept === b.n;
  const keepWhy = viewer.readOnly ? READ_ONLY : keptB ? `v${b?.n} is the version you kept.` : null;

  return (
    <div className="bv cmp">
      <ViewerToolbar
        label="Blender"
        mode={modeSwitch}
        subject={
          <>
            <ToolbarEnvChip kind={viewer.environment?.kind} branch={viewer.environment?.branch} />
            {viewer.rel && <span className="bv__file">{viewer.rel}</span>}
          </>
        }
        status={status}
        actions={
          <SegmentedControl
            aria-label="Compare view"
            value={view}
            onChange={setView}
            options={VIEWS}
          />
        }
      />

      {problem && (
        <p className="bv__error" role="alert">
          {problem}
        </p>
      )}

      {list && list.versions.length < 2 ? (
        <p className="bv__hint bv__empty">{COMPARE_NEEDS_TWO}</p>
      ) : (
        <>
          <div className="cmp__pickers" role="group" aria-label="Versions">
            {picker("a", a, b)}
            <button
              type="button"
              className="sv-icon-btn cmp__swap"
              aria-label="Swap A and B"
              title="Swap A and B"
              disabled={!picks}
              onClick={() => setPicks((cur) => (cur ? { a: cur.b, b: cur.a } : cur))}
            >
              <ArrowLeftRight size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
            {picker("b", b, a)}
          </div>

          <div className="bv__body cmp__body">
            <main className="cmp__view">
              <CompareView
                ref={handle}
                a={glbs.a}
                b={glbs.b}
                result={result}
                mode={view}
                shown={shown}
                split={split}
                onSplitChange={setSplit}
                labels={{ a: a ? `A · v${a.n}` : "A", b: b ? `B · v${b.n}` : "B" }}
              >
                {view === "changes" && result && (
                  <div className="cmp__legend" role="group" aria-label="Change classes">
                    {CHANGE_CLASSES.map((cls) => (
                      <button
                        key={cls}
                        type="button"
                        className={`cmp__class cmp__class--${cls}`}
                        aria-pressed={shown[cls]}
                        title={`${shown[cls] ? "Hide" : "Show"} ${CLASS_LABEL[cls].toLowerCase()} triangles`}
                        onClick={() => setShown((s) => toggleClass(s, cls))}
                      >
                        <span className="cmp__swatch" aria-hidden="true" />
                        {CLASS_LABEL[cls]}{" "}
                        <strong>{result.counts[cls].toLocaleString("en-US")}</strong>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="cmp__class cmp__next"
                      disabled={regions.length === 0}
                      title={
                        regions.length === 0
                          ? "Nothing changed between these versions."
                          : "Frame the next change (N). Shift+N goes back."
                      }
                      onClick={() => next(false)}
                    >
                      <SkipForward size={13} strokeWidth={1.5} aria-hidden="true" />
                      Next change
                      <kbd>N</kbd>
                      {region >= 0 && (
                        <span className="cmp__of">
                          {region + 1} of {regions.length}
                        </span>
                      )}
                    </button>
                  </div>
                )}
                {diff.kind !== "ready" && (
                  <p className="sv-status" role="status">
                    {diff.kind === "error"
                      ? `Could not compare these versions: ${diff.message}`
                      : "Finding what changed…"}
                  </p>
                )}
              </CompareView>
            </main>

            <aside className="bv__parts cmp__side">
              <div className="bv__parts-heading">Parts ({result?.parts.length ?? 0})</div>
              <div className="bv__parts-list">
                {result?.parts.map((p) => {
                  const materials = a && b ? materialChanges(p.name, a, b) : [];
                  return (
                    <button
                      key={p.name}
                      type="button"
                      className={`bv__part-row cmp__part cmp__part--${p.status}`}
                      title="Frame this part"
                      onClick={() => handle.current?.frameBox(p.min, p.max)}
                    >
                      <span className="bv__part-name">{p.name}</span>
                      <span className="bv__part-material">
                        {p.status === "added"
                          ? "only in B"
                          : p.status === "removed"
                            ? "only in A"
                            : counts(p.counts)}
                      </span>
                      {materials.map((m) => (
                        <span key={m} className="bv__part-material cmp__material">
                          {m}
                        </span>
                      ))}
                    </button>
                  );
                })}
              </div>

              <div className="bv__parts-heading cmp__notes-heading">
                Notes from {a ? `v${a.n}` : "A"} ({notes.length})
              </div>
              {notes.length === 0 ? (
                <p className="bv__hint">No open notes on this file from {a ? `v${a.n}` : "A"}.</p>
              ) : (
                <ul className="cmp__notes">
                  {notes.map((c) => (
                    <li key={c.id} className="cmp__note">
                      <span className="bv__part-material">
                        {anchorLabel(c.anchor)} · {statusView(c.status).label}
                      </span>
                      <span className="cmp__note-body">{c.body}</span>
                      <span className="cmp__note-actions">
                        <button
                          type="button"
                          className="k-btn k-btn--secondary k-btn--sm"
                          disabled={busy || viewer.readOnly}
                          title={viewer.readOnly ? READ_ONLY : "B fixes it: resolve the note"}
                          onClick={() => void answer(c.id, "good")}
                        >
                          Looks good
                        </button>
                        <button
                          type="button"
                          className="k-btn k-btn--secondary k-btn--sm"
                          disabled={busy || viewer.readOnly}
                          title={
                            viewer.readOnly ? READ_ONLY : "B does not fix it: keep the note open"
                          }
                          onClick={() => void answer(c.id, "broken")}
                        >
                          Still broken
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>

          <footer className="cmp__footer">
            <span className="cmp__timing">
              {diff.kind === "ready" &&
                `Diffed in ${Math.round(diff.outcome.result.ms)} ms after ${Math.round(diff.outcome.parseMs)} ms reading, ${diff.outcome.where === "worker" ? "in a worker" : "on this thread"}.`}
            </span>
            <button
              type="button"
              className="bv__footer-btn"
              disabled={busy || !a || goBackWhy !== null}
              title={
                goBackWhy ??
                (a
                  ? `Open v${a.n}'s copy of the .blend in Editor mode. Your file is unchanged.`
                  : undefined)
              }
              onClick={() => {
                const copy = a?.blendCopy;
                if (copy) void act(() => onOpenBlend(copy));
              }}
            >
              <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
              {a ? `Go back to v${a.n}` : "Go back to A"}
            </button>
            <button
              type="button"
              className="bv__footer-btn cmp__keep"
              disabled={busy || !b || !blend || keepWhy !== null}
              title={
                keepWhy ??
                (b ? `Keep v${b.n}: it is never pruned. Your .blend is not changed.` : undefined)
              }
              onClick={() => {
                if (!b || !blend) return;
                void act(async () => {
                  await keepVersion(blend, b.n);
                  await reload();
                });
              }}
            >
              <Pin size={13} strokeWidth={1.5} aria-hidden="true" />
              {keptB ? `v${b?.n} kept` : b ? `Keep v${b.n}` : "Keep B"}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
