/** Side sessions have their own transcript and cancellation; polling stops when the panel closes. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Item } from "./protocol.generated";
import { busy } from "./model";
import { ItemView, type ItemActions } from "./Items";
import * as rpc from "./rpc";
import { strings } from "./strings";
import { friendlyError } from "./errors";

export function useSideChat(main: readonly Item[]) {
  const [open, setOpen] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const ask = useCallback(
    (text: string) => {
      setOpen(true);
      if (!text.trim()) return;
      const context = main
        .filter((i) => i.kind.kind === "userMessage" || i.kind.kind === "assistantText")
        .map((i) => ("text" in i.kind ? `${i.kind.kind}: ${i.kind.text}` : ""))
        .join("\n")
        .slice(-16000);
      setSending(true);
      setError(null);
      const sent = generation.current;
      void rpc.btwSend(text, context).then(
        () => {
          if (generation.current !== sent) return;
          setSending(false);
          setRevision((n) => n + 1);
        },
        () => {
          if (generation.current === sent) {
            setError(strings.btw.failed);
            setSending(false);
          }
        },
      );
    },
    [main],
  );
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      void rpc.btwAttach().then(
        (next) => {
          if (!live) return;
          setAttachment(next);
          setLoadError(null);
          timer = setTimeout(poll, busy(next.status) ? 450 : 1500);
        },
        () => {
          if (live) {
            setLoadError(strings.btw.failed);
            timer = setTimeout(poll, 3000);
          }
        },
      );
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, revision]);
  const actions = useMemo<ItemActions>(
    () => ({
      onAnswer: (itemId, optionId) => rpc.btwAnswer(itemId, optionId).then(() => undefined),
      onQuestion: (itemId, outcome) => rpc.btwAnswerQuestion(itemId, outcome).then(() => undefined),
      onRetry: (id) => {
        const items = attachment?.items ?? [];
        const at = items.findIndex((item) => item.id === id);
        const prompt = items
          .slice(0, at)
          .reverse()
          .find((item) => item.kind.kind === "userMessage");
        if (prompt?.kind.kind === "userMessage")
          ask(prompt.kind.text.split("\n\nSide question: ").pop() ?? prompt.kind.text);
      },
      hintText: () => strings.hintUnknown,
      // A side question runs no background tasks of its own.
      onOpenTask: () => {},
      onStopTask: () => Promise.resolve(),
      elapsed: () => null,
    }),
    [attachment, ask],
  );
  return {
    open,
    ask,
    props: {
      children: attachment?.items.map((original) => {
        const item =
          original.kind.kind === "userMessage" && original.kind.text.includes("\n\nSide question: ")
            ? {
                ...original,
                kind: {
                  ...original.kind,
                  text: original.kind.text
                    .split("\n\nSide question: ")
                    .slice(1)
                    .join("\n\nSide question: "),
                },
              }
            : original;
        return <ItemView key={item.id} item={item} actions={actions} />;
      }),
      working: sending || busy(attachment?.status ?? null),
      error: error || loadError ? friendlyError(error ?? loadError ?? "").detail : null,
      onSend: ask,
      onClose: () => {
        setOpen(false);
      },
      onClear: () => {
        generation.current++;
        setSending(false);
        void rpc.btwReset().then(
          () => {
            setAttachment(null);
            setRevision((n) => n + 1);
          },
          () => setError(strings.btw.failed),
        );
      },
      onStop: () => {
        void rpc.btwCancel().catch(() => setError(strings.btw.failed));
      },
    },
  };
}
