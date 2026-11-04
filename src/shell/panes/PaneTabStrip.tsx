/**
 * One pane's own tab strip — VEISTRA-UX-SPEC.md §1.6: `34px`, a file-type
 * colour square or app icon, the label, and a close button on hover; the
 * active tab carries a 2px accent underline.
 *
 * This is the thing `PaneTree.tsx`'s own header used to say was gone for
 * good, and the reason it is back is written there, not here: the v3 boards
 * (board 07 in particular) draw a strip on every pane, and the `chrome`
 * workstream is pulling the equivalent listing out of `ClusterBar` in the
 * same change, so a tab still appears in exactly one row — it has just moved.
 * `docs/design-notes/shell-chrome.md` has the older argument for why a tab in
 * two rows is a tab that can disagree with itself; nothing about that
 * argument has stopped being true, only which row won.
 */
import { AppWindow, MessageSquare, Terminal } from "lucide-react";
import type { ClusterMember, DragHandleProps, PaneAppPicker } from "../contract";
import { useDropZone } from "../dropZones";
import { fileIconUrl } from "@veistra/file-icons";
import { agentTabState, agentTabStatesVersion, subscribeAgentTabStates } from "../agentTabStates";
import { getSubject, subjectsVersion, subscribeSubjects } from "../viewerSubjects";
import { horizontalWheelDelta, revealScrollLeft } from "../stripScroll";
import { Close } from "../../ui/Icon";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Plus } from "../../ui/Icon";
import AppPicker from "./AppPicker";

export default function PaneTabStrip({
  paneId,
  members,
  caret,
  onSelect,
  onClose,
  dragHandleFor,
  appPicker,
}: {
  paneId: string;
  /** This pane's own tabs, in layout order — already filtered by the caller. */
  members: ClusterMember[];
  /** The insertion index a drag in the air would land at, or `null` when the
   *  drag is aimed elsewhere. Counted over this strip's own tabs, matching
   *  what `dropZones.ts`'s `strip` zone measures below. */
  caret: number | null;
  onSelect: (member: ClusterMember) => void;
  onClose: (member: ClusterMember) => void;
  dragHandleFor?: (member: ClusterMember) => DragHandleProps | undefined;
  /** The list behind the trailing `+`. Omitted, the strip has no `+`. */
  appPicker?: PaneAppPicker;
}) {
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map());

  // The strip's own drop zone, scoped to exactly this pane's tabs — unlike
  // `ClusterBar`'s old row-wide zone, there is only ever one pane's worth of
  // tabs to measure here, so `at` ignores `x` for anything but the caret math.
  const stripZone = useDropZone({
    kind: "strip",
    at: () => ({
      paneId,
      tabRects: members.map(
        (m) => tabRefs.current.get(m.id)?.getBoundingClientRect() ?? new DOMRect(),
      ),
    }),
  });

  const stripRef = useRef<HTMLDivElement | null>(null);
  const setStrip = useCallback(
    (el: HTMLDivElement | null) => {
      stripRef.current = el;
      stripZone(el);
    },
    [stripZone],
  );
  useStripScroll(stripRef, tabRefs, members.find((m) => m.showing)?.id);

  return (
    <div className="pane-tabstrip" ref={setStrip} data-pane-strip={paneId}>
      {members.map((member, i) => (
        <PaneTab
          key={member.id}
          member={member}
          caretBefore={caret === i}
          onSelect={onSelect}
          onClose={onClose}
          dragHandle={dragHandleFor?.(member)}
          tabRef={(el) => {
            if (el) tabRefs.current.set(member.id, el);
            else tabRefs.current.delete(member.id);
          }}
        />
      ))}
      {caret === members.length && <span className="pane-tabstrip__caret" />}
      {appPicker && <AddAppTab paneId={paneId} picker={appPicker} />}
    </div>
  );
}

/**
 * How a mouse reaches the tabs this strip cuts off. Its native scrollbar stays
 * hidden (`.pane-tabstrip` in panes.css), so two things stand in for it: a
 * vertical wheel over the strip scrolls it sideways, and whichever tab becomes
 * active is scrolled wholly into view, so a tab opened past the edge, or one
 * clicked while half cut off, is never left hidden.
 *
 * Chosen over the alternatives:
 * - `OverlayScrollbar`'s hover thumb, which already has the wheel half. It
 *   tracks hover against a rect it caches until its strip resizes, which held
 *   for the fixed bars it was written for and does not here: dragging the
 *   divider of a split above a pane moves that pane's strip without resizing
 *   it. While shown it would also cover the active tab's 2px underline and the
 *   hairline, and take the pointerdown that starts a drag on the tabs under it.
 * - Chevrons or edge fades: chevrons take width from tabs in a pane that may be
 *   200px wide, and a fade over the strip fades the hairline along with it.
 */
function useStripScroll(
  stripRef: RefObject<HTMLElement | null>,
  tabRefs: RefObject<Map<string, HTMLElement>>,
  activeId: string | undefined,
) {
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    // Native and `passive: false`: React registers its wheel listener as
    // passive, where `preventDefault` is ignored, and a tick spent moving the
    // strip must not go on to scroll anything else.
    const onWheel = (e: WheelEvent) => {
      // A trackpad pinch arrives as Ctrl+wheel; it is not a request to scroll.
      if (e.ctrlKey || e.metaKey) return;
      // Nothing cut off, nothing to reach: the tick is not claimed.
      if (strip.scrollWidth - strip.clientWidth < 1) return;
      const delta = horizontalWheelDelta(strip, e.deltaX, e.deltaY, e.deltaMode);
      if (delta === null) return;
      strip.scrollLeft += delta;
      e.preventDefault();
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [stripRef]);

  // A layout effect, so the strip never paints one frame at the old offset.
  // Keyed on the active tab alone: a wheel scroll that leaves it off screen is
  // the user's choice, and re-running on every render would undo it.
  //
  // Not `tab.scrollIntoView`, which goes on to scroll every ancestor that still
  // cannot show the whole tab, `overflow: hidden` ones included. A tab can be
  // wider than a 200px pane, and scrolling `.pane` would slide the pane host
  // out from under the surfaces `ToolWindow` places by measured rect, with
  // nothing to scroll it back. Writing the strip's own `scrollLeft` cannot.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tab = activeId === undefined ? undefined : tabRefs.current.get(activeId);
    if (!strip || !tab) return;
    const view = strip.getBoundingClientRect();
    const next = revealScrollLeft(
      { left: view.left, right: view.right, scrollLeft: strip.scrollLeft },
      tab.getBoundingClientRect(),
    );
    if (next !== strip.scrollLeft) strip.scrollLeft = next;
  }, [stripRef, tabRefs, activeId]);
}

/**
 * The `+` at the end of a pane's tabs: opens the app picker, and the chosen app
 * becomes a new tab in this pane. Distinct from the cluster switcher's `+`, which
 * makes a whole cluster — the label says which one this is.
 */
function AddAppTab({ paneId, picker }: { paneId: string; picker: PaneAppPicker }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="pane-tabstrip__add"
        data-open={at !== null || undefined}
        aria-haspopup="dialog"
        aria-expanded={at !== null}
        aria-label="Open an app in this pane"
        title="Open an app in this pane"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setAt({ top: rect.bottom + 2, left: rect.left });
        }}
        // A press here must not start a tab drag or refocus through the strip.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Plus size={13} />
      </button>
      {at !== null && (
        <AppPicker
          apps={picker.apps}
          blocked={picker.blocked}
          anchor={at}
          onPick={(entry) => picker.onOpen(entry, paneId)}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

function PaneTab({
  member,
  caretBefore,
  onSelect,
  onClose,
  dragHandle,
  tabRef,
}: {
  member: ClusterMember;
  caretBefore: boolean;
  onSelect: (member: ClusterMember) => void;
  onClose: (member: ClusterMember) => void;
  dragHandle?: DragHandleProps;
  tabRef: (el: HTMLElement | null) => void;
}) {
  const classes = ["pane-tab"];
  if (member.showing) classes.push("pane-tab--active");

  // A File Viewer is one file: its tab is named for it, wears its icon, and
  // says where it is and whether it has unsaved edits. Re-read when the shell
  // learns something new about a viewer.
  useSyncExternalStore(subscribeSubjects, subjectsVersion);
  const file = member.appId === "viewer" ? getSubject(member.id) : undefined;
  // An agent tab's bubble is filled once its agent is done and fades while it works.
  useSyncExternalStore(subscribeAgentTabStates, agentTabStatesVersion);
  const agent = member.appId === "agent-tab" ? agentTabState(member.id) : undefined;

  return (
    <>
      {caretBefore && <span className="pane-tabstrip__caret" />}
      <div
        ref={tabRef}
        role="tab"
        aria-selected={member.showing}
        tabIndex={0}
        className={classes.join(" ")}
        title={file ? file.path : member.title}
        onClick={() => onSelect(member)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(member);
          }
        }}
        // Middle-click closes, same as a browser tab. `auxclick` rather than
        // `mousedown`/`mouseup`, which would also catch the press that starts
        // a drag on some pointing devices — `auxclick` fires only once a
        // button other than the primary one both went down and came back up
        // over this element.
        onAuxClick={(e) => {
          if (e.button === 1) onClose(member);
        }}
        onPointerDown={dragHandle?.onPointerDown}
        style={dragHandle?.style}
      >
        {member.kind === "terminal" ? (
          <Terminal size={16} strokeWidth={1.5} className="pane-tab__icon" aria-hidden="true" />
        ) : (
          <>
            {file ? (
              <img
                className="pane-tab__fileicon"
                src={fileIconUrl(member.title)}
                alt=""
                width={14}
                height={14}
                draggable={false}
              />
            ) : member.appId === "agent-tab" ? (
              <MessageSquare
                size={14}
                strokeWidth={1.5}
                className="pane-tab__icon pane-tab__icon--app pane-tab__icon--agent"
                data-agent={agent}
                aria-hidden="true"
              />
            ) : (
              <AppWindow
                size={14}
                strokeWidth={1.5}
                className="pane-tab__icon pane-tab__icon--app"
                aria-hidden="true"
              />
            )}
          </>
        )}

        <span className="pane-tab__label">{member.title}</span>

        {/* Same one-box, two-occupant trade `switcher.css`'s member tab
            makes: the agent-finished dot normally, the close button on
            hover or keyboard focus, never both, so the tab's width does not
            change under the pointer. There is no modified-file dot here —
            nothing in `ClusterMember`/`SurfaceInstance` tracks a dirty
            state, and drawing one from nothing is exactly what the rework
            brief's "never fake data" rule forbids. A File Viewer is the one
            exception, because it reports its own (`viewerSubjects`). */}
        <span className="pane-tab__end">
          {member.agentFinished && <span className="pane-tab__dot" />}
          {file?.dirty && (
            <span className="pane-tab__dot pane-tab__dot--dirty" title="Unsaved changes" />
          )}
          <button
            type="button"
            className="pane-tab__close"
            aria-label={`Close ${member.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(member);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Close />
          </button>
        </span>
      </div>
    </>
  );
}
