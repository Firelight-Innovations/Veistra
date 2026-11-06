/**
 * The props every slot takes: the whole contract between the tab's logic and
 * its look. A replacement component implements the same props and nothing
 * else. Everything here is plain data and callbacks; no slot is handed state,
 * an RPC or the transcript.
 */
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import type {
  AgentState,
  ApprovalOption,
  PlanEntry,
  QuestionChoice,
  SessionState,
  TaskState,
  ToolStatus,
} from "../protocol.generated";
import type { DiffLine } from "../diff";
import type { Tone } from "../meters";
import type { ContextChip } from "../mentions";
import type { LintCheck, LintReport } from "../validation";

/**
 * The tab's frame: header on top, transcript in the middle, composer below,
 * and the Details panel beside them when it is open. In a narrow tab the
 * panel covers the conversation instead.
 */
export interface LayoutProps {
  header: ReactNode;
  transcript: ReactNode;
  composer: ReactNode;
  /** The Details panel, or nothing while it is closed. */
  details?: ReactNode;
  /** Drawn over everything, such as the agent map. */
  overlay?: ReactNode;
}
export interface ContextLinkProps {
  /** Which tracker the link is for, `jira` or `linear`, for the title and example. */
  provider?: string;
  onAdd: (url: string) => void;
  onCancel: () => void;
}

export interface SideChatProps {
  children: ReactNode;
  working: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onClose: () => void;
  onClear: () => void;
  onStop: () => void;
}

export interface HeaderProps {
  onHistory?: () => void;
  onSideChat?: () => void;
  /** Show or hide the shell's Agents list, beside the work. */
  onAgents?: () => void;
  /** Show or hide the Details panel. */
  onDetails?: () => void;
  detailsOpen?: boolean;
  history?: ReactNode;
  /** The session's state, or `null` before there is a session. */
  state: SessionState | null;
  onNewSession: () => void;
}

export interface HistoryPanelProps {
  sessions: import("../rpc").SavedSession[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpen: (id: string, harness?: import("../protocol.generated").Harness) => void;
  onArchive: (id: string, archived: boolean) => void;
}

export interface StatusBadgeProps {
  state: SessionState | null;
}

/**
 * The scrolling list. Rendered inside assistant-ui's runtime, so a default may
 * use its thread primitives; it keeps the bottom in view while the agent works.
 */
export interface TranscriptProps {
  children: ReactNode;
}

/** One turn of the conversation; `children` is its items, already drawn. */
export interface TurnProps {
  children: ReactNode;
}

/** Shown in an agent turn that has nothing to show yet. */
export interface WorkingProps {
  /** What the agent is at, in words, such as "Running pnpm test". Without it, "Working…". */
  activity?: string;
  /** Which stretch of the turn this is: before any output, thinking, or a tool running. */
  phase?: WorkingPhase;
  /** When the turn started, in milliseconds since the epoch, for its running clock. */
  since?: number;
}

/**
 * Which stretch of a running turn the agent is in, for how `Working` animates:
 * `reading` before the agent has said or done anything, `thinking` while it
 * reasons or decides its next step, `acting` while a tool runs.
 */
export type WorkingPhase = "reading" | "thinking" | "acting";

/** Actions on a whole agent turn, such as copying it. */
export type TurnActionsProps = Record<string, never>;

export interface EmptyStateProps {
  /**
   * A refusal code for the whole cluster, or `null`. Unlike `setupHint` it stays
   * a code: the component words it itself, from `strings.refusal`.
   */
  blocked: string | null;
  /** What the harness still needs, already in words, or `null`. */
  setupHint: string | null;
  /** The card that sets the harness up, shown in place of `setupHint`, or `null`. */
  setup?: SetupCardProps | null;
}

/** A harness's setup, with the buttons that do it (`SetupCard`). */
export interface SetupCardProps {
  /** What stands in the way, or what is happening: "Installing Claude…". */
  title: string;
  /** One more sentence, or `null`. */
  body: string | null;
  /** The command a person could type instead, already in words, or `null`. */
  typed: string | null;
  /** The end of what a failed installer printed, folded away, or `null`. */
  detail: { label: string; text: string } | null;
  /** The buttons, the first one primary. Empty while a step runs. */
  actions: { label: string; onClick: () => void }[];
  /** A step is running. */
  busy: boolean;
}

export interface UserMessageProps {
  text: string;
  /** Accepted, but not sent yet: the agent is still starting. */
  pending?: boolean;
}

/** Sanitised HTML from `renderMarkdown`. The handlers copy code and stop links. */
export interface AssistantTextProps {
  html: string;
  /** Still streaming in: the reply ends on a blinking caret. */
  streaming?: boolean;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLDivElement>) => void;
}

/** A run of tool calls folded into one line; `children` are the calls' own rows. */
export interface ActionGroupProps {
  /**
   * Two or more calls, drawn as a line that opens. A lone call is passed with
   * `false` and should be drawn as it is, at the same place in the tree.
   */
  grouped: boolean;
  /** "Ran 2 commands, read a file". */
  summary: string;
  /** Some call has not finished: the line shimmers. */
  running: boolean;
  /** "1 failed", or `null` when none did. */
  failed: string | null;
  children: ReactNode;
}

export interface ThinkingProps {
  text: string;
  /** Still being written: the label shimmers and the latest line shows under it. */
  live?: boolean;
}

/** One file's change, already diffed. `lines` is `null` when it is too large. */
export interface DiffProps {
  path: string;
  isNew: boolean;
  lines: DiffLine[] | null;
  added: number;
  removed: number;
}

export interface ToolCallProps {
  title: string;
  /** ACP's tool kind: `read`, `edit`, `execute`, `search`, ... */
  toolKind: string;
  status: ToolStatus;
  output: string;
  truncated: boolean;
  paths: string[];
  diffs: DiffProps[];
  /** The item's id, so the tab can scroll to the row and open it. */
  anchor?: string;
  /** A subagent's own work, already drawn, nested under the call that started it. */
  children?: ReactNode;
}

export interface PathListProps {
  paths: string[];
}

/** A canvas topology check, drawn as its own card in the transcript. */
export interface ValidationProps {
  status: ToolStatus;
  /** `null` while the check runs, or when its answer could not be read. */
  report: LintReport | null;
}

/** The rules of one canvas validation report, each ticked or crossed. */
export interface ValidationChecksProps {
  checks: LintCheck[];
}

/**
 * The composer's validation badge: the session's latest canvas report at a
 * glance, and every rule in a popover. Draws nothing without one.
 */
export interface ValidationBadgeProps {
  /** A check is running now. */
  running: boolean;
  /** The newest readable report, or `null` before there is one. */
  report: LintReport | null;
}

export interface ApprovalProps {
  title: string;
  detail: string | null;
  /** Only the start of `detail` is shown, so the person should not allow it blind. */
  detailTruncated: boolean;
  paths: string[];
  diffs: DiffProps[];
  options: ApprovalOption[];
  /** What was answered, in words, or `null` while it waits. */
  answer: string | null;
  /** The option being sent, while it is in flight; every option is disabled meanwhile. */
  sending: string | null;
  onChoose: (optionId: string) => void;
}

/** One question on a `QuestionCard`, with the user's reply so far. */
export interface QuestionCardQuestion {
  header: string | null;
  /** The question; `null` when the card's `message` is the question. */
  text: string | null;
  choices: QuestionChoice[];
  /** Checkboxes rather than one pick. */
  multi: boolean;
  /** The composer's text answers it. */
  other: boolean;
  /** The values picked. */
  picks: string[];
  /** What was typed, if anything. */
  typed: string | null;
}

/**
 * The agent's question, with numbered choices. Open, a click on a row picks it
 * (or toggles it, for `multi`) and Submit sends; answered, it shows what was
 * chosen, read-only.
 */
export interface QuestionCardProps {
  message: string;
  questions: QuestionCardQuestion[];
  /** The card is open: the keyboard and the composer answer it. */
  open: boolean;
  /** How it ended, in words, once it has; `null` while open. */
  ended: string | null;
  /** The question number keys pick on, while open. */
  current: number;
  /** A Submit button is needed: more than one question, or a multi-select. */
  submit: boolean;
  /** Every question has an answer, so Submit may be pressed. */
  ready: boolean;
  /** The answer is in flight; everything is disabled meanwhile. */
  sending: boolean;
  onPick: (question: number, value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
}

export interface TodoListProps {
  entries: PlanEntry[];
  /** The turn is running, so the step in progress turns. */
  live?: boolean;
}

export interface UsageProps {
  used: number;
  size: number;
}

/** One part of what fills the context window: messages, tools, memory files. */
export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
}

/** The composer's context meter: the latest usage, or `null` before one arrives. */
export interface ContextMeterProps {
  used: number | null;
  size: number | null;
  /** What the used tokens are made of, when the agent says. Without it, one "Used" row. */
  categories?: ContextCategory[];
}

/** One usage limit of the plan the agent runs on, such as the session or the week. */
export interface UsageLimit {
  id: string;
  label: string;
  /** How much of it is used, 0 to 1. */
  share: number;
  /** When it resets, already in words ("Resets in 22 min"), or `null`. */
  resets: string | null;
}

/** The usage ring. With no limits it draws nothing. */
export interface UsageRingProps {
  limits: UsageLimit[];
}

/** A small button that shows a card while it is hovered or focused. */
export interface HoverCardProps {
  /** Names the button for assistive tech, with the figure it stands for. */
  label: string;
  /** What the button shows: a ring, a bar, a number. */
  trigger: ReactNode;
  /** Which edge of the button the card lines up with; `end` by default. */
  align?: "start" | "end";
  children: ReactNode;
}

/** A small progress ring. */
export interface RingProps {
  /** How full, 0 to 1. */
  share: number;
  tone: Tone;
}

/** A harness in the settings menu, with the models it offers. */
export interface HarnessChoice {
  /** `claude`, `codex`, `veistra`. */
  id: string;
  /** "Claude". */
  name: string;
  /** Its models, in the harness's order. Empty when they are not known yet. */
  models: PickerChoice[];
  /** The model it would run, or `null` for its own default. */
  model: string | null;
  /** Why it cannot be picked, in words ("Coming soon"), or `null`. */
  unavailable: string | null;
  /**
   * What it still needs, in words ("Not set up"), or `null`. Unlike
   * `unavailable` it can still be picked: the tab then offers to set it up.
   */
  note: string | null;
}

/** The composer's settings button: the harnesses and their models, then effort, mode and the rest. */
export interface ModelMenuProps {
  openRequest?: number;
  harnessLocked?: boolean;
  ultracode?: { enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void };
  label: string;
  /** The harness in use, by id. */
  harness?: string | null;
  /**
   * Listed first, one group each, with its models under it: picking a model
   * picks its harness too. Leave out to list `sections` alone.
   */
  harnesses?: HarnessChoice[];
  /** Picks a harness and one of its models, `null` for its default. Without it the harnesses are shown but locked. */
  onChoose?: (harness: string, model: string | null) => void;
  /** The other settings, such as effort and mode, after the harnesses. */
  sections: PickerProps[];
}

/** Draws over a picture; `onSave` hands back the marked-up one as base64 PNG. */
export interface MarkupEditorProps {
  src: string;
  onSave: (mime: string, data: string) => void;
  onClose: () => void;
}

export interface ErrorItemProps {
  message: string;
  /** The one-line fix, already in words, or `null`. */
  hint: string | null;
  onRetry: () => void;
}

/** A quiet line of text in the transcript, like "The agent stopped." */
export interface NoteProps {
  text: string;
}

/** A fix the user can make, in warning colours. */
export interface HintProps {
  text: string;
}

/** A refusal or failure above the composer, with an optional fix and action. */
export interface NoticeProps {
  text: string;
  hint: string | null;
  action: { label: string; onClick: () => void } | null;
}

export interface ComposerProps {
  auxiliary?: ReactNode;
  /** The agent's task list, pinned over the prompt box while it has steps left. */
  plan?: ReactNode;
  chips?: ContextChip[];
  /** Pictures pasted into the box, shown as thumbnails above the text. */
  images?: Array<{ id: string; mime: string; data: string }>;
  /** Pictures found on the clipboard when the user pastes. */
  onPasteImages?: (files: File[]) => void;
  onRemoveImage?: (id: string) => void;
  /** Prompts waiting for the running turn to end; each can be taken back out. */
  queued?: Array<{ id: string; text: string }>;
  onUnqueue?: (id: string) => void;
  /** A picture was marked up and saved: swap it for the annotated one. */
  onReplaceImage?: (id: string, image: { mime: string; data: string }) => void;
  effortLevel?: string;
  onAttach?: () => void;
  onDictate?: () => void;
  onSelect?: (caret: number) => void;
  sideChat?: ReactNode;
  ref: Ref<HTMLTextAreaElement>;
  value: string;
  placeholder: string;
  /** The new text and, when the input knows it, where the caret now is. */
  onChange: (text: string, caret?: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Notices to show above the input. */
  notices: ReactNode;
  /** The slash-command list, floated above the box while one is being typed. */
  menu?: ReactNode;
  /** The id of the menu item Enter and Tab would pick, for the input to point at. */
  menuActiveId?: string | null;
  /** In the box's toolbar, after attach: the settings button. */
  controls: ReactNode;
  /** In the box's toolbar, before dictation: the context meter and the usage ring. */
  meters: ReactNode;
  /** Inside the box, at the end of the input: Send or Stop. */
  action: ReactNode;
}

export interface SendButtonProps {
  disabled: boolean;
  onClick: () => void;
}

export interface StopButtonProps {
  onClick: () => void;
}

export interface PickerChoice {
  value: string;
  name: string;
  description?: string | null;
}

/**
 * A setting with a few choices: mode, model, effort, harness, or any other
 * option the agent reports. Without `onChange` it is shown, not chosen.
 */
export interface PickerProps {
  onPreview?: (value: string | null) => void;
  ultra?: { enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void };
  label: string;
  title?: string | null;
  value: string | null;
  choices: PickerChoice[];
  disabled?: boolean;
  onChange?: (value: string) => void;
}

export interface MenuItem {
  id: string;
  label: string;
  /** A second line or hint, such as a command's argument or a file's folder. */
  detail?: string;
  children?: MenuItem[];
  disabled?: boolean;
  /** What the row is, for its leading glyph and its colour: `file`, `canvas`, `skill`, … */
  kind?: string;
  /**
   * The file or folder name a `file` or `folder` row stands for, which leads
   * it with that type's icon from the Files explorer. Absent on a row that
   * only browses or searches files, whose label is not a file name.
   */
  fileName?: string;
  /** Draws a line above the row: where the places to browse end and the results begin. */
  separated?: boolean;
}

/** A popup list under the caret: slash commands, @ mentions. */
export interface MenuProps {
  path?: string[];
  onPathChange?: (path: string[]) => void;
  label: string;
  /** The top level's heading, in place of `label`, such as a search scope. */
  title?: string;
  /** One quiet line under the rows: searching, nothing found, or a failure. */
  status?: string | null;
  /**
   * A search line under the heading. It shows what is typed in the input,
   * which keeps the focus and the keys, or `placeholder` while that is empty.
   */
  search?: { query: string; placeholder: string };
  /** A back arrow at the top level too, for a scope the caller can leave. */
  onBack?: () => void;
  items: MenuItem[];
  activeId: string | null;
  onPick: (id: string) => void;
}

export interface SessionRow {
  id: string;
  title: string;
  state: SessionState | null;
  /** When it was last active, already formatted for display. */
  when: string;
}

export interface SessionListProps {
  sessions: SessionRow[];
  activeId: string | null;
  onOpen: (id: string) => void;
}

/** A background task in the transcript: a workflow, a shell command, a monitor. */
export interface TaskCardProps {
  /** The item's id, so the tab can scroll to the card. */
  anchor: string;
  name: string;
  /** "Workflow", "Shell", in words. */
  type: string;
  /** `workflow`, `shell`, ..., for its glyph. */
  taskType: string;
  state: TaskState;
  /** The agent's line about it, or `null`. */
  description: string | null;
  /** What it said last, or how it ended. */
  summary: string | null;
  /** How long it has run, in words, or `null`. */
  elapsed: string | null;
  /** A workflow's place, "Phase 2 of 4: Review", or `null`. */
  phase: string | null;
  /** "3 running, 5 done", or the tokens it has used, or `null`. */
  progress: string | null;
  onDetails: () => void;
  /** Stops it; `null` when it cannot be stopped or has ended. */
  onStop: (() => void) | null;
  stopping: boolean;
}

/** An advisory from the agent, such as a rate-limit warning. */
export interface NoticeItemProps {
  /** `info` or `warning`. */
  severity: string;
  title: string;
  description: string | null;
}

/** The conversation being compacted: a divider, with what was kept folded under it. */
export interface CompactionItemProps {
  /** `inProgress`, `completed`, `failed` or `cancelled`. */
  status: string;
  summary: string;
  error: string | null;
}

/** One row in a Details section: a file, a card shown, a connector. */
export interface DetailRow {
  id: string;
  label: string;
  /** A second, quieter part: a folder, a source, a state. */
  detail?: string | null;
  /** Lines added and removed, for a changed file. */
  added?: number;
  removed?: number;
  /** Marks a file the agent made. */
  isNew?: boolean;
  /** A coloured dot: `running`, `done`, `failed`, `idle`. */
  dot?: "running" | "done" | "failed" | "idle";
  /** Without it the row is plain text. */
  onOpen?: () => void;
}

/** Where the session works, in words. `null` fields are not shown. */
export interface EnvironmentView {
  /** "Local worktree", "Main checkout". */
  kind: string;
  branch: string | null;
  path: string | null;
  /** "2 ahead, 1 behind". */
  sync: string | null;
  remote: string | null;
  /** "3 uncommitted files", with line counts. */
  uncommitted: { label: string; added: number; removed: number } | null;
}

/**
 * The Details panel: Environment, Context, Connectors, Outputs, Changes and
 * Background tasks, as Claude's own app lays them out. With `detail` set it
 * shows that instead, such as one task's phases.
 */
export interface DetailsPanelProps {
  onClose: () => void;
  /** `null` while it loads. */
  environment: EnvironmentView | null;
  onOpenGit: (() => void) | null;
  context: { used: number; size: number } | null;
  /** `null` while they load. */
  connectors: DetailRow[] | null;
  onManageConnectors: (() => void) | null;
  outputs: DetailRow[];
  changes: DetailRow[];
  tasks: DetailRow[];
  /** "3 agents", opening the agent map; `null` when there are none. */
  agents: { label: string; onOpen: () => void } | null;
  /** Shown in place of the sections, with a way back. */
  detail?: ReactNode;
}

/** One agent of a workflow, in its phase. */
export interface TaskAgentRow {
  id: string;
  label: string;
  state: AgentState;
  /** "Opus 5.5 · 1m 20s", in words, or `null`. */
  meta: string | null;
  /** The start of what it answered. */
  result: string | null;
}

/** A workflow phase, with its agents under it. */
export interface TaskPhaseRow {
  title: string;
  detail: string | null;
  /** `done`, `running`, `failed`, `next` or `skipped`. */
  state: string;
  /** The state in words. */
  stateLabel: string;
  agents: TaskAgentRow[];
}

/** One background task, opened: its figures, then a workflow's phases. */
export interface TaskDetailProps {
  name: string;
  type: string;
  state: TaskState;
  stateLabel: string;
  /** "12m 4s · 225.8k tokens · 40 tool uses", in words. */
  figures: string | null;
  description: string | null;
  summary: string | null;
  lastTool: string | null;
  /** Phases that have started or finished. */
  phases: TaskPhaseRow[];
  /** Phases no agent has reached, while the workflow runs. */
  upNext: TaskPhaseRow[];
  /** Agents that name no declared phase, or all of them when there are no phases. */
  loose: TaskAgentRow[];
  looseTitle: string;
  onBack: () => void;
  onStop: (() => void) | null;
  stopping: boolean;
}

/** A node on the agent map: the session, a subagent or a task. */
export interface MapNode {
  id: string;
  label: string;
  /** "5m 18s · 225.8k tokens". */
  meta: string | null;
  state: "running" | "done" | "failed" | "idle";
  onOpen?: () => void;
}

/** The session, the subagents it started and its background tasks, as a map. */
export interface AgentMapProps {
  main: MapNode;
  agents: MapNode[];
  tasks: MapNode[];
  onClose: () => void;
}

/** The composer's "2 agents running" button, which opens the agent map. */
export interface AgentsButtonProps {
  label: string;
  running: boolean;
  onClick: () => void;
}
