/**
 * Which slot draws each transcript item kind (handoff §2.2), and the logic
 * behind it: markdown, diffs, the copy button, an approval in flight. Nothing
 * here draws; every piece of DOM comes from `components/` through `useSlots()`.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type {
  FileDiff,
  Harness,
  Hint,
  Item,
  ItemKind,
  QuestionOutcome,
  QuestionReply,
} from "./protocol.generated";
import { agentCounts, currentPhase, isLive } from "./details";
import { counts, lineDiff } from "./diff";
import { renderMarkdown } from "./markdown";
import {
  complete,
  current,
  emptyReplies,
  numberKey,
  oneClick,
  openCard,
  pick,
  registerOpen,
  typeOther,
  type OpenCard,
} from "./questions";
import { strings } from "./strings";
import { useSlots } from "./components/registry";
import type { DiffProps } from "./components/types";

type Kind<K extends ItemKind["kind"]> = Extract<ItemKind, { kind: K }>;

export interface ItemActions {
  /** Rejects if the answer did not land, so the card can be answered again. */
  onAnswer: (itemId: string, optionId: string) => Promise<void>;
  /** Answers a question card. Rejects if the answer did not land, as `onAnswer` does. */
  onQuestion: (itemId: string, outcome: QuestionOutcome) => Promise<void>;
  /** Send again what the user asked before the error `itemId`. */
  onRetry: (itemId: string) => void;
  /** A hint as a sentence about `harness`, the one that raised it. */
  hintText: (hint: Hint, harness: Harness) => string;
  /** Opens the Details panel on the background task `itemId`. */
  onOpenTask: (itemId: string) => void;
  /** Asks the agent to stop a background task. Rejects if the request did not land. */
  onStopTask: (taskId: string) => Promise<void>;
  /** How long the item `itemId` has run, in ms, or `null` when not known. */
  elapsed: (itemId: string) => number | null;
}

/**
 * The items nested under each call, by the call's item id: a subagent's own
 * work, drawn inside the call that started it rather than in the turn.
 */
export const NestedItems = createContext<ReadonlyMap<string, readonly Item[]>>(new Map());

/** `live`: the item is the part still streaming in a running turn. */
export function ItemView({
  item,
  actions,
  live = false,
}: {
  item: Item;
  actions: ItemActions;
  live?: boolean;
}) {
  const S = useSlots();
  const kind = item.kind;
  switch (kind.kind) {
    case "userMessage":
      return <S.UserMessage text={kind.text} />;
    case "assistantText":
      return <AssistantItem text={kind.text} streaming={live} />;
    case "reasoning":
      return <S.Thinking text={kind.text} live={live} />;
    case "toolCall":
      return <ToolItem id={item.id} tool={kind} actions={actions} />;
    case "approval":
      return <ApprovalItem id={item.id} approval={kind} onAnswer={actions.onAnswer} />;
    case "question":
      return <QuestionItem id={item.id} question={kind} onQuestion={actions.onQuestion} />;
    // The plan is pinned over the composer and the usage is the composer's
    // context ring, so neither repeats in the transcript.
    case "plan":
    case "usage":
      return null;
    case "error":
      return (
        <S.ErrorItem
          message={kind.message}
          hint={kind.hint && actions.hintText(kind.hint, kind.harness)}
          onRetry={() => actions.onRetry(item.id)}
        />
      );
    case "task":
      return <TaskItem id={item.id} task={kind} actions={actions} />;
    case "notice":
      return (
        <S.NoticeItem severity={kind.severity} title={kind.title} description={kind.description} />
      );
    case "compaction":
      return <S.CompactionItem status={kind.status} summary={kind.summary} error={kind.error} />;
  }
}

/**
 * A background task's card. Its clock and a workflow's progress come from
 * the item; Stop stays pressed until the task says it has stopped, or the
 * request fails.
 */
function TaskItem({ id, task, actions }: { id: string; task: Kind<"task">; actions: ItemActions }) {
  const S = useSlots();
  const [stopping, setStopping] = useState(false);
  const live = isLive(task.state);
  const run = task.run;
  const at = run ? currentPhase(run) : null;
  const tally = run && run.agents.length > 0 ? agentCounts(run) : null;
  const ms = actions.elapsed(id);
  return (
    <S.TaskCard
      anchor={id}
      name={task.name || task.description}
      type={strings.task.type(task.taskType)}
      taskType={task.taskType}
      state={task.state}
      description={task.description || null}
      summary={task.summary}
      elapsed={ms === null ? null : strings.activity.elapsed(ms)}
      phase={at && run ? strings.task.phase(at.index, run.phases.length, at.title) : null}
      progress={
        tally
          ? strings.task.agents(tally.running, tally.done, tally.failed)
          : task.usage && task.usage.totalTokens > 0
            ? strings.task.tokens(task.usage.totalTokens)
            : null
      }
      onDetails={() => actions.onOpenTask(id)}
      onStop={
        live && task.canStop
          ? () => {
              setStopping(true);
              actions.onStopTask(task.taskId).catch(() => setStopping(false));
            }
          : null
      }
      stopping={stopping && live}
    />
  );
}

function AssistantItem({ text, streaming }: { text: string; streaming: boolean }) {
  const S = useSlots();
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // A link would navigate this frame away from the tab; nothing opens yet.
    if (target.closest("a")) event.preventDefault();
    const copy = target.closest<HTMLButtonElement>("[data-copy]");
    const code = copy?.parentElement?.querySelector("pre")?.textContent;
    if (!copy || code === undefined || code === null) return;
    void navigator.clipboard?.writeText(code).then(
      () => {
        copy.textContent = strings.copied;
      },
      () => {},
    );
  };
  // A middle click would open the link in a window of its own.
  const onAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("a")) event.preventDefault();
  };
  return (
    <S.AssistantText html={html} onClick={onClick} onAuxClick={onAuxClick} streaming={streaming} />
  );
}

/** Each file's line diff, worked out once per change rather than per draw. */
function useDiffs(diffs: FileDiff[]): DiffProps[] {
  return useMemo(
    () =>
      diffs.map((diff) => {
        const lines = diff.tooLarge ? null : lineDiff(diff.oldText, diff.newText);
        const tally = lines ? counts(lines) : { added: 0, removed: 0 };
        return {
          path: diff.path,
          isNew: diff.oldText === null && !diff.tooLarge,
          lines,
          ...tally,
        };
      }),
    [diffs],
  );
}

function ToolItem({
  id,
  tool,
  actions,
}: {
  id: string;
  tool: Kind<"toolCall">;
  actions: ItemActions;
}) {
  const S = useSlots();
  const diffs = useDiffs(tool.diffs);
  const nested = useContext(NestedItems).get(id);
  return (
    <S.ToolCall
      title={tool.title}
      toolKind={tool.toolKind}
      status={tool.status}
      output={tool.output}
      truncated={tool.truncated}
      paths={tool.paths}
      diffs={diffs}
      anchor={id}
    >
      {nested?.map((child) => (
        <ItemView key={child.id} item={child} actions={actions} />
      ))}
    </S.ToolCall>
  );
}

function ApprovalItem({
  id,
  approval,
  onAnswer,
}: {
  id: string;
  approval: Kind<"approval">;
  onAnswer: ItemActions["onAnswer"];
}) {
  const S = useSlots();
  const [sent, setSent] = useState<string | null>(null);
  const diffs = useDiffs(approval.diffs);
  return (
    <S.Approval
      title={approval.title}
      detail={approval.detail}
      detailTruncated={approval.detailTruncated}
      paths={approval.paths}
      diffs={diffs}
      options={approval.options}
      answer={approval.answer === null ? null : answerText(approval)}
      sending={sent}
      onChoose={(optionId) => {
        setSent(optionId);
        onAnswer(id, optionId).catch(() => setSent(null));
      }}
    />
  );
}

function answerText(approval: Kind<"approval">): string {
  if (approval.answer === "cancelled") return strings.approval.cancelled;
  if (approval.answer === "outside") return strings.approval.outside;
  const option = approval.options.find((o) => o.optionId === approval.answer);
  return strings.approval.answered(option?.name ?? approval.answer ?? "");
}

/**
 * A question card. While open it is the card the number keys and the
 * composer answer, if it is the newest open one (`questions.ts`). A single
 * question with one pick is sent on the click; anything else waits for Submit.
 */
function QuestionItem({
  id,
  question,
  onQuestion,
}: {
  id: string;
  question: Kind<"question">;
  onQuestion: ItemActions["onQuestion"];
}) {
  const S = useSlots();
  const { questions, outcome } = question;
  const [replies, setReplies] = useState<QuestionReply[]>(() => emptyReplies(questions));
  const [sending, setSending] = useState(false);
  const open = outcome === null;
  const submit = !oneClick(questions);

  const send = (sent: QuestionOutcome) => {
    setSending(true);
    onQuestion(id, sent).catch(() => setSending(false));
  };
  const answer = (next: QuestionReply[]) => send({ kind: "answered", replies: next });
  const choose = (index: number, value: string) => {
    const next = pick(questions, replies, index, value);
    setReplies(next);
    if (!submit) answer(next);
  };

  // The registered card reads the latest replies without registering again.
  const latest = useRef({ replies, choose, answer });
  latest.current = { replies, choose, answer };
  const listening = open && !sending;
  useEffect(() => {
    if (!listening) return;
    const card: OpenCard = {
      pickNumber: (n) => {
        const { replies: now, choose: pickIt } = latest.current;
        const at = current(questions, now);
        const choice = questions[at]?.choices[n];
        if (!choice) return false;
        pickIt(at, choice.value);
        return true;
      },
      answerText: (text) => {
        const now = latest.current.replies;
        const next = typeOther(questions, now, current(questions, now), text);
        if (next === null) return false;
        setReplies(next);
        if (!submit) latest.current.answer(next);
        return true;
      },
    };
    const unregister = registerOpen(card);
    const onKey = (event: KeyboardEvent) => {
      if (openCard() !== card) return;
      const n = numberKey(event);
      if (n !== null && card.pickNumber(n)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKey);
    };
  }, [listening, questions, submit]);

  // Closed, the card shows what the host says was sent, not what was clicked.
  const shown = outcome?.kind === "answered" ? outcome.replies : open ? replies : [];
  return (
    <S.QuestionCard
      message={question.message}
      questions={questions.map((q, i) => ({
        header: q.header,
        text: q.text,
        choices: q.choices,
        multi: q.multi,
        other: q.other,
        picks: shown[i]?.picks ?? [],
        typed: shown[i]?.other?.trim() || null,
      }))}
      open={open}
      ended={
        outcome?.kind === "skipped"
          ? strings.question.skipped
          : outcome?.kind === "cancelled"
            ? strings.question.cancelled
            : null
      }
      current={current(questions, replies)}
      submit={submit}
      ready={complete(questions, replies)}
      sending={sending}
      onPick={choose}
      onSubmit={() => answer(replies)}
      onSkip={() => send({ kind: "skipped" })}
    />
  );
}
