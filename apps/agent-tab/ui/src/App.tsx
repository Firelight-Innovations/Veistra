/**
 * The agent tab: one coding agent's conversation, run in this cluster's
 * worktree (handoff §2.1). Header, transcript, prompt box, top to bottom.
 *
 * The session lives in Rust, not here. On every mount the tab subscribes to
 * its envelopes, then attaches; `model.ts` stitches the two together by `seq`,
 * so a tab hidden and shown again (or dragged to another pane) redraws the
 * whole conversation without missing or doubling anything.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { invoke, reportPainted } from "@veistra/bridge";
import type {
  Attachment,
  ConfigOption,
  Envelope,
  Harness,
  HarnessInfo,
  Hint,
  PlanEntry,
  QuestionOutcome,
  SessionStatus,
  SettingTrouble,
} from "./protocol.generated";
import { completion, isLogin, matching, offered, skillCommands, commandSupport } from "./commands";
import { FIRST_HARNESS, harnessChoices, type RunningModel } from "./harnesses";
import { useSetup } from "./useSetup";
import { latestUsage } from "./meters";
import { latestValidation } from "./validation";
import {
  attached,
  busy,
  initialState,
  nextMode,
  place,
  unanswered,
  promptBefore,
  pickers,
  received,
  settable,
  type Choice,
  type Pending,
  type Setting,
  type TabState,
} from "./model";
import { answerOpenCard } from "./questions";
import * as rpc from "./rpc";
import { toTurns, type Turn } from "./thread";
import { Turns, TurnsProvider } from "./Turns";
import { useSlots } from "./components/registry";
import type { PickerProps, MenuItem } from "./components/types";
import { hintText, infoOf } from "./harness";
import { strings, type HarnessWords } from "./strings";
import {
  chipEndingAt,
  chipSegments,
  insertChipToken,
  keptChips,
  referenceKind,
  rememberKind,
  withChips,
  type ContextChip,
  type MentionHit,
} from "./mentions";
import {
  EDITOR_HIT,
  editorChip,
  editorHits,
  matchingHits,
  opensInEditor,
  revealChip,
  useEditorReports,
} from "./editorMentions";
import { ChipOpen, type ChipOpener } from "./chipOpen";
import { useMentions } from "./useMentions";
import { useSideChat } from "./useSideChat";
import { workingLine } from "./working";
import { useDetails } from "./useDetails";
import { NestedItems } from "./Items";
import { EFFORT_LEVELS } from "./preferences";
import { loadPrefs, savePrefs } from "./prefs";

/** A prompt waiting for the running turn to end. */
interface QueuedPrompt {
  id: string;
  text: string;
  chips: ContextChip[];
  images: rpc.PastedImage[];
}

/** What a reference chip is made from: a search hit, a copied cluster, an issue link. */
interface ChipHit {
  uri: string;
  title: string;
  kind: string;
}

const chipOf = (hit: ChipHit): ContextChip => {
  // So the sent message's chip keeps the colour its URI alone would not give it.
  rememberKind(hit.uri, hit.kind);
  return { id: hit.uri, label: hit.title, kind: hit.kind, uri: hit.uri };
};

/** A search scope's glyph in the @ menu, where it differs from the scope's own name. */
const SCOPE_GLYPH: Record<string, string> = { file: "folder", "canvas-comment": "comment" };

type Action =
  { type: "attached"; attachment: Attachment } | { type: "envelope"; envelope: Envelope };

function reduce(state: TabState, action: Action): TabState {
  return action.type === "attached"
    ? attached(state, action.attachment)
    : received(state, action.envelope);
}

/** A refusal or failure to show above the prompt box, in the tab's words. */
interface Notice {
  text: string;
  hint: string | null;
}

/** `words` is the harness the call went to, which a refusal's sentences name. */
function noticeOf(err: unknown, fallback: string, words: HarnessWords | undefined): Notice {
  const refusal = rpc.refusalOf(err);
  if (!refusal) return { text: fallback, hint: null };
  const text =
    refusal.code === "harness" && words
      ? strings.notReady(words.name)
      : (strings.refusal[refusal.code] ?? fallback);
  return { text, hint: refusal.hint && hintText(refusal.hint as Hint, words) };
}

export default function App() {
  const S = useSlots();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  // The harness the next session starts in, as `agent-tab/harnesses` last said.
  const [chosen, setChosen] = useState<Harness | null>(null);
  const [attachFailed, setAttachFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [harnessesFailed, setHarnessesFailed] = useState(false);
  // The slash-command list: the row the keys are on, and the draft Esc closed it for.
  const [menuRow, setMenuRow] = useState(0);
  const [menuPath, setMenuPath] = useState<string[]>([]);
  const [menuClosedFor, setMenuClosedFor] = useState<string | null>(null);
  // Esc closes a menu until the draft changes, not for that text forever: once it
  // differs, it is forgotten, so "@", Esc, Backspace, "@" opens the @ menu again.
  if (menuClosedFor !== null && menuClosedFor !== draft) setMenuClosedFor(null);
  // What `/login` last said, shown under the transcript until the next prompt.
  const [loginNote, setLoginNote] = useState<string | null>(null);
  /** Cluster transcripts still being copied into chips; Send waits for them. */
  const [capturing, setCapturing] = useState(0);
  // A new tab starts with what the user last picked in any tab.
  const [effort, setEffortState] = useState<string | null>(() => loadPrefs().effort ?? "medium");
  const setEffort = useCallback((value: string | null) => {
    setEffortState(value);
    savePrefs({ effort: value });
  }, []);
  const [ultracode, setUltracodeState] = useState(() => loadPrefs().ultracode ?? false);
  const setUltracode = useCallback((on: boolean) => {
    setUltracodeState(on);
    savePrefs({ ultracode: on });
  }, []);
  // The mode each harness's next session starts in, picked before it exists.
  const [startModes, setStartModes] = useState<StartModes>(() => loadPrefs().modes ?? {});
  const pickStartMode = useCallback((harness: Harness, mode: string) => {
    setStartModes((now) => ({ ...now, [harness]: mode }));
    savePrefs({ modes: { [harness]: mode } });
  }, []);
  // Once a session of that harness has entered its mode, the agent's mode is
  // the one to follow, and a later session starts in the last mode the user
  // picked, in this tab or another. Heard from each status as it comes, since
  // a render may fold Ready and Stopped into one.
  const heardStatus = useCallback((envelope: Envelope) => {
    if (envelope.event.type !== "status") return;
    const { harness, state } = envelope.event.status;
    if (state === "starting" || state === "stopped" || state === "failed") return;
    const kept = loadPrefs().modes?.[harness];
    setStartModes((now) => (now[harness] === kept ? now : { ...now, [harness]: kept }));
  }, []);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [caret, setCaret] = useState(0);
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [images, setImages] = useState<rpc.PastedImage[]>([]);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof rpc.contextSources>>>({
    clusters: [],
    issues: [],
  });
  const [contextScope, setContextScope] = useState<string | null>(null);
  const mentions = useMentions(draft, caret, contextScope);
  /** The issue tracker whose link form is open, `jira` or `linear`, or none. */
  const [issuePicker, setIssuePicker] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedSessions, setSavedSessions] = useState<rpc.SavedSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const side = useSideChat(state.items);
  const askSide = side.ask;
  // Counts the choices this tab has heard of. A `harnesses` reply asked for
  // before one is older than it, so it must not put back the harness it
  // replaced.
  const choices = useRef(0);
  const prompt = useRef<HTMLTextAreaElement | null>(null);
  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    setHistoryError(null);
    void rpc
      .history()
      .then(
        (answer) => setSavedSessions(answer.sessions ?? []),
        () => setHistoryError(strings.history.failed),
      )
      .finally(() => setHistoryLoading(false));
  }, []);
  /**
   * Puts a chip that arrives later, after the draft may have moved on, at `at`
   * (clamped to the draft as it is then). Reads only through updaters, so it
   * is safe from a listener installed once.
   */
  const latest = useRef({ draft, caret });
  latest.current = { draft, caret };
  const setChipLater = useCallback((hit: ChipHit, at: number) => {
    const chip = chipOf(hit);
    const { draft: now, caret: was } = latest.current;
    setChips((held) => (held.some((c) => c.id === chip.id) ? held : [...held, chip]));
    if (chipSegments(now, [chip]).some((part) => part.chip)) return;
    const where = Math.min(at, now.length);
    const placed = insertChipToken(now, where, where, chip.label);
    setDraft(placed.text);
    // Text typed after the "@" moves along with the caret in it.
    const moved = was >= where ? was + placed.text.length - now.length : was;
    setCaret(moved);
    requestAnimationFrame(() => prompt.current?.setSelectionRange(moved, moved));
  }, []);
  // Something sent from another app, such as a canvas selection or a
  // playtest's feedback packet, joins the end of the next prompt as one chip
  // and nothing else: what the app asks of the agent is inside the item and
  // goes with it on send. Nothing is sent here: the person does that.
  useEffect(
    () =>
      rpc.onAttach(({ contextId, label, kind }) =>
        setChipLater(
          { uri: `veistra://context/${contextId}`, title: label, kind: kind ?? "context" },
          Infinity,
        ),
      ),
    [setChipLater],
  );

  // What the user called this session. It is kept in Rust beside the
  // conversation, so a saved session comes back as it was.
  const [chatName, setChatName] = useState<string | null>(null);
  const loadMeta = useCallback(() => {
    void rpc.sessionMeta().then(
      (meta) => setChatName(meta.name ?? null),
      () => {},
    );
  }, []);
  const saveMeta = useCallback((meta: Partial<rpc.SessionMeta>) => {
    void rpc
      .setSessionMeta(meta)
      .then(() => rpc.saveHistory())
      .catch(() => {});
  }, []);
  const renameSession = useCallback(
    (name: string) => {
      const next = name.replace(/\s+/g, " ").trim().slice(0, 100);
      if (next === "") return;
      setChatName(next);
      saveMeta({ name: next });
    },
    [saveMeta],
  );

  // The tab is named for its session: the name it was given, else what was
  // first asked, shortened.
  const sessionName = useMemo(() => {
    if (chatName) return chatName;
    for (const item of state.items) {
      if (item.kind.kind !== "userMessage") continue;
      const flat = item.kind.text
        .replace(/\[(@[^\]]*)\]\(<[^>]*>\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      if (flat === "") continue;
      return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat;
    }
    return strings.agentTabName;
  }, [state.items, chatName]);
  useEffect(() => {
    void invoke("veistra/title", { title: sessionName, subject: null }).catch(() => {});
  }, [sessionName]);
  useEffect(() => {
    if (!state.attached || (!state.items.length && !state.status?.pendingPrompt)) return;
    const timer = setTimeout(() => {
      void rpc.saveHistory().catch(() => {});
    }, 750);
    return () => clearTimeout(timer);
  }, [state.attached, state.items, state.status?.pendingPrompt, chatName]);
  // The agent can name the conversation itself, as its own /rename does. Only a
  // title that arrives while the tab is open counts: the one a reattach finds
  // was heard before, and the user may have renamed it since.
  const heardTitle = useRef<string | undefined | null>(null);
  const agentTitle = state.status?.sessionTitle;
  useEffect(() => {
    if (!state.attached) return;
    if (heardTitle.current === null) {
      heardTitle.current = agentTitle;
      return;
    }
    if (agentTitle === undefined || agentTitle === heardTitle.current) return;
    heardTitle.current = agentTitle;
    renameSession(agentTitle);
  }, [state.attached, agentTitle, renameSession]);
  // The effect that hears a sign-in end runs once, so it reads the latest list from here.
  const harnessesRef = useRef<HarnessInfo[]>([]);
  harnessesRef.current = harnesses;

  // Envelopes are held until this answers, so a retry loses none of them.
  const attach = useCallback(
    () =>
      rpc.attach().then(
        (attachment) => {
          setAttachFailed(false);
          dispatch({ type: "attached", attachment });
          loadMeta();
        },
        () => setAttachFailed(true),
      ),
    [loadMeta],
  );

  const heardChoice = useCallback((harness: Harness) => {
    choices.current += 1;
    setChosen(harness);
  }, []);

  // Without this answer the tab has no harness to name or offer, so a failure
  // says so and can be retried.
  const listHarnesses = useCallback(() => {
    const asked = choices.current;
    return rpc.harnesses().then(
      (answer) => {
        setHarnessesFailed(false);
        setBlocked(answer.blocked);
        setHarnesses(answer.harnesses);
        if (choices.current === asked) setChosen(answer.current);
      },
      () => setHarnessesFailed(true),
    );
  }, []);

  useEffect(() => {
    const stop = rpc.onEnvelope((envelope) => {
      dispatch({ type: "envelope", envelope });
      heardStatus(envelope);
    });
    const stopChosen = rpc.onChosen(heardChoice);
    void attach().finally(() => reportPainted());
    void listHarnesses();
    void rpc.contextSources().then(
      (answer) => setSources({ clusters: answer?.clusters ?? [], issues: answer?.issues ?? [] }),
      () => {},
    );
    // The host asks each agent for its models after its first answer, and
    // says when they are in.
    const stopModels = rpc.onModels(() => void listHarnesses());
    const stopLogin = rpc.onLogin((harness, ok) => {
      const name = infoOf(harnessesRef.current, harness)?.name ?? "";
      setLoginNote(ok ? strings.login.done(name) : strings.login.failed(name));
      if (ok) void listHarnesses();
    });
    // The Agents page opened a saved session in this tab: show it.
    const stopRestored = rpc.onRestored(() => {
      setHistoryOpen(false);
      void attach();
      void listHarnesses();
    });
    return () => {
      stop();
      stopChosen();
      stopModels();
      stopLogin();
      stopRestored();
    };
  }, [attach, heardChoice, heardStatus, listHarnesses]);

  const status = state.status;
  const working = busy(status);
  const exited = status !== null && (status.state === "stopped" || status.state === "failed");
  // A tab runs its live agent's harness, and otherwise the one it chose; the
  // host resolves `agent-tab/send` the same way.
  const running = status && !exited ? status.harness : null;
  const current = infoOf(harnesses, running ?? chosen);
  // What the session's own hints are about, even once it has ended. An error
  // item names its own harness, which an earlier session may have run.
  const session = infoOf(harnesses, status?.harness ?? null);
  // The harness's own sign-in, as `/login` starts it.
  const signIn = useCallback(() => {
    setLoginNote(strings.login.started(current?.name ?? ""));
    rpc.login().catch((err: unknown) => {
      setLoginNote(null);
      setNotice(noticeOf(err, strings.login.notStarted, current));
    });
  }, [current]);
  const relist = useCallback(() => void listHarnesses(), [listHarnesses]);
  // A harness that is not installed: the card that installs it, then signs in.
  const setup = useSetup(running ? undefined : current, relist, signIn);
  const reportedCommands = useMemo(
    () =>
      status?.harness === (running ?? chosen) && status.commands.length
        ? status.commands
        : (current?.commands ?? []),
    [status?.harness, status?.commands, current?.commands, running, chosen],
  );
  const skillList = skillCommands(reportedCommands, running ?? chosen ?? FIRST_HARNESS);

  // A tab with no session yet takes the harness and model last picked; one
  // that reattaches to its own session keeps what that session chose.
  const restored = useRef(false);
  useEffect(() => {
    if (!state.attached || restored.current) return;
    restored.current = true;
    const { harness, model } = loadPrefs();
    if (state.status !== null || harness === undefined) return;
    rpc.choose(harness, model ?? null).then(
      () => {
        heardChoice(harness);
        void listHarnesses();
      },
      () => {},
    );
  }, [state.attached, state.status, heardChoice, listHarnesses]);

  // Pasted pictures are read to base64 here and travel with the next prompt.
  const addImages = useCallback(async (files: File[]) => {
    const read = await Promise.all(
      files.map(
        (file) =>
          new Promise<rpc.PastedImage | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const url = String(reader.result);
              resolve({
                id: crypto.randomUUID(),
                mime: file.type,
                data: url.slice(url.indexOf(",") + 1),
              });
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          }),
      ),
    );
    setImages((now) => [...now, ...read.filter((i): i is rpc.PastedImage => i !== null)]);
  }, []);

  // Prompts typed while the agent works, sent one by one as each turn ends.
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const queuedSent = useRef(false);

  const submit = useCallback(
    (text: string, retry = false, queued?: QueuedPrompt) => {
      const heldChips = queued?.chips ?? chips;
      const heldImages = queued?.images ?? images;
      if (text.trim() === "" && (retry || (heldChips.length === 0 && heldImages.length === 0)))
        return;
      setNotice(null);
      if (/^\/skills(?:\s|$)/.test(text.trim())) {
        setDraft("/skills ");
        setMenuClosedFor(null);
        return;
      }
      // Naming the chat is this tab's own, whatever the agent offers: the name
      // belongs to the tab, not to the agent's session.
      const own = /^\/rename(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (own) {
        setDraft("");
        const argument = (own[1] ?? "").trim();
        if (argument === "") setLoginNote(strings.rename.usage);
        else {
          renameSession(argument);
          setLoginNote(strings.rename.done(argument.replace(/\s+/g, " ").slice(0, 100)));
        }
        return;
      }
      if (
        commandSupport(text, reportedCommands, running ?? chosen ?? FIRST_HARNESS) === "terminal"
      ) {
        void rpc.cliCommand(text).then(
          () => {
            setDraft("");
            setLoginNote(strings.openedTerminal(current?.name ?? ""));
          },
          (err: unknown) => setNotice(noticeOf(err, strings.failed.send, current)),
        );
        return;
      }
      const [command, ...args] = text.trim().split(/\s+/);
      if (
        ["/model", "/effort", "/clear", "/new", "/reset", "/stop", "/help", "/btw"].includes(
          command,
        )
      ) {
        setDraft("");
        if (["/clear", "/new", "/reset"].includes(command)) {
          // A fresh conversation starts unnamed.
          setChatName(null);
          void rpc
            .reset()
            .catch((err: unknown) => setNotice(noticeOf(err, strings.failed.setting, current)));
        } else if (command === "/stop") void rpc.cancel().catch(() => {});
        else if (command === "/help") setLoginNote(strings.help);
        else if (command === "/btw") askSide(args.join(" "));
        else if (
          command === "/effort" &&
          args[0] === "ultracode" &&
          current?.harness === "claude"
        ) {
          if (running)
            void rpc
              .setConfig("ultra_effort", args[1] === "off" ? "off" : "on")
              .catch((err: unknown) => setNotice(noticeOf(err, strings.failed.setting, current)));
          else setUltracode(args[1] !== "off");
        } else if (command === "/effort" && args.length) {
          const option = status?.config.find((c) => c.category === "thought_level");
          const value = args[0].toLowerCase();
          if (option?.choices.some((c) => c.value === value))
            void rpc
              .setConfig(option.id, value)
              .catch((err: unknown) => setNotice(noticeOf(err, strings.failed.setting, current)));
          else if (!status && EFFORT_LEVELS.some((v) => v === value)) setEffort(value);
          else setLoginNote(strings.preferences.unsupported);
        } else setSettingsRequest((n) => n + 1);
        return;
      }
      // The sign-in is the host's, not a prompt: the agent never sees it.
      if (isLogin(text)) {
        setDraft("");
        signIn();
        return;
      }
      // A cluster's chip is still being copied: sending now would leave it out.
      if (!retry && !queued && capturing > 0) return;
      setLoginNote(null);
      const sentChips = retry ? [] : heldChips;
      const sentImages = retry ? [] : heldImages;
      const ultra = ultracode && current?.harness === "claude";
      // Only a session about to start takes a mode; ask-first is where it starts anyway.
      const picked = running ? null : startMode(current, startModes);
      const mode = picked !== null && picked !== current?.askFirst ? picked : undefined;
      rpc
        .send(
          withChips(text, sentChips),
          effort !== null || ultra || mode !== undefined
            ? { effort, ultracode: ultra, ...(mode === undefined ? {} : { mode }) }
            : undefined,
          sentImages,
        )
        .then(
          // Only if the box still holds what was sent: the user may have typed
          // on while it was in flight, and a Retry sends an older prompt.
          () => {
            if (queued) return;
            setDraft((now) => (now === text ? "" : now));
            setChips((now) => now.filter((c) => !sentChips.includes(c)));
            setImages((now) => now.filter((i) => !sentImages.includes(i)));
          },
          (err: unknown) => {
            // A queued prompt that fails goes back in the box to be edited.
            if (queued) setDraft((now) => (now === "" ? text : now));
            queuedSent.current = false;
            setNotice(noticeOf(err, strings.failed.send, current));
          },
        );
    },
    [
      current,
      effort,
      ultracode,
      status,
      askSide,
      chips,
      images,
      capturing,
      reportedCommands,
      running,
      chosen,
      startModes,
      setEffort,
      setUltracode,
      renameSession,
      signIn,
    ],
  );

  useEffect(() => {
    if (working) {
      queuedSent.current = false;
      return;
    }
    if (queuedSent.current || queue.length === 0) return;
    const [next, ...rest] = queue;
    queuedSent.current = true;
    setQueue(rest);
    submit(next.text, false, next);
  }, [working, queue, submit]);

  // A harness and one of its models, `null` for the agent's default. The host
  // keeps the model for that harness's next session, and the menu checks it
  // once the harnesses are listed again.
  const chooseHarness = (harness: string, model: string | null) => {
    setNotice(null);
    rpc.choose(harness as Harness, model).then(
      () => {
        savePrefs({ harness: harness as Harness, model });
        heardChoice(harness as Harness);
        void attach();
        void listHarnesses();
      },
      (err: unknown) => setNotice(noticeOf(err, strings.failed.choose, current)),
    );
  };

  const stopTurn = useCallback(() => {
    void rpc.cancel().catch(() => {});
  }, []);

  const live = unanswered(pending, status);

  // Shown at once and held until the status that answers it; a refusal from
  // the host takes back that choice and no other. A later choice for the
  // same setting replaces this one, which the answers to this one then leave
  // alone.
  const choose = (setting: Setting, value: string, change: () => Promise<number>) => {
    if (status === null || !settable(status)) return;
    setNotice(null);
    const sent: Choice = { value, ticket: null };
    const settle = (next: Choice | undefined) =>
      setPending((p) => place(p, setting, (c) => (c === sent ? next : c)));
    setPending((p) => place(unanswered(p, status), setting, () => sent));
    change().then(
      (ticket) => settle({ ...sent, ticket }),
      (err: unknown) => {
        settle(undefined);
        setNotice(noticeOf(err, strings.failed.setting, session));
      },
    );
  };
  // What is picked in a running session is also what the next one starts with.
  const onMode = (modeId: string) => {
    if (status) savePrefs({ modes: { [status.harness]: modeId } });
    choose("mode", modeId, () => rpc.setMode(modeId));
  };
  const onConfig = (configId: string, value: string) => {
    const category = status?.config.find((o) => o.id === configId)?.category;
    if (category === "thought_level") savePrefs({ effort: value });
    else if (category === "model" && status) savePrefs({ harness: status.harness, model: value });
    choose({ option: configId }, value, () => rpc.setConfig(configId, value));
  };

  // "/skills " opens the skill list as a search: what follows it narrows the
  // list by name or description, names first.
  const skillsOpen = /^\/skills(?:\s|$)/.test(draft);
  const skillSearch = draft.replace(/^\/skills\s*/, "");
  const skillQuery = skillSearch.trim().toLowerCase();
  const nameHit = (s: { name: string }) => s.name.toLowerCase().includes(skillQuery);
  const matches = skillsOpen
    ? skillList
        .filter((s) => nameHit(s) || s.description.toLowerCase().includes(skillQuery))
        .sort((a, b) => Number(nameHit(b)) - Number(nameHit(a)))
        .map((s) => ({ ...s, support: "agent" as const }))
    : matching(draft, offered(reportedCommands, running ?? chosen ?? FIRST_HARNESS));
  // The issue-link form covers both menus, so neither takes keys while it is open.
  const mentionOpen = issuePicker === null && mentions.query !== null && menuClosedFor !== draft;
  // What the Godot and Blender panes report they have open: the @ menu's
  // rows for them, and where a sent chip of theirs is shown when clicked.
  const editorReports = useEditorReports();
  const editorRows = editorHits(editorReports);
  const chipOpener: ChipOpener = {
    opens: (uri) => opensInEditor(uri, referenceKind(uri), editorReports),
    open: (uri) => void revealChip(uri, editorReports),
  };
  // The frames on every canvas, fetched when the @ menu opens, so a canvas can be opened up.
  const [canvasFrames, setCanvasFrames] = useState<MentionHit[]>([]);
  const framesAsked = useRef(false);
  useEffect(() => {
    if (!mentionOpen || framesAsked.current) return;
    framesAsked.current = true;
    rpc.searchContext("", ["frame"]).then(
      ({ items }) => setCanvasFrames(items),
      () => {
        framesAsked.current = false;
      },
    );
  }, [mentionOpen]);
  const menuOpen =
    issuePicker === null &&
    !mentionOpen &&
    (matches.length > 0 || skillsOpen) &&
    menuClosedFor !== draft;
  const openSkills = () => {
    setDraft("/skills ");
    setCaret(8);
    setMenuPath([]);
    setMenuRow(0);
    requestAnimationFrame(() => {
      prompt.current?.focus();
      prompt.current?.setSelectionRange(8, 8);
    });
  };
  const leaveSkills = () => {
    setDraft("/");
    setCaret(1);
    setMenuRow(0);
    requestAnimationFrame(() => prompt.current?.focus());
  };
  const pickCommand = (name: string) => {
    if (name.startsWith("skill:")) {
      const skill = skillList.find((s) => s.name === name.slice(6));
      if (skill) {
        setChips((now) =>
          now.some((c) => c.id === name)
            ? now
            : [
                ...now,
                {
                  id: name,
                  label: skill.name.replace(/^\$/, ""),
                  kind: "skill",
                  command: skill.name,
                },
              ],
        );
        setDraft("");
        prompt.current?.focus();
      }
      return;
    }
    if (skillsOpen) {
      pickCommand(`skill:${name}`);
      return;
    }
    const command = matches.find((c) => c.name === name);
    if (command) setDraft(completion(command));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Backspace") {
      // Right after a reference, Backspace takes the whole chip, not its last letter.
      const box = event.currentTarget;
      const token =
        box.selectionStart === box.selectionEnd
          ? chipEndingAt(draft, box.selectionStart, chips)
          : undefined;
      if (token?.chip) {
        event.preventDefault();
        const gone = token.chip;
        setDraft(draft.slice(0, token.start) + draft.slice(token.end));
        setChips((now) => now.filter((c) => c !== gone));
        setCaret(token.start);
        requestAnimationFrame(() => prompt.current?.setSelectionRange(token.start, token.start));
        return;
      }
      // In an empty box it takes the last skill, which sits ahead of the text.
      const skill = [...chips].reverse().find((c) => !c.uri);
      if (draft === "" && skill) {
        event.preventDefault();
        setChips((now) => now.filter((c) => c !== skill));
        return;
      }
    }
    if ((mentionOpen || menuOpen) && !event.nativeEvent.isComposing) {
      const count = navigable.length;
      const picked = navigable[Math.min(menuRow, count - 1)];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        if (count) setMenuRow((Math.min(menuRow, count - 1) + step + count) % count);
        return;
      }
      if (skillsOpen && event.key === "ArrowLeft" && skillSearch === "") {
        event.preventDefault();
        leaveSkills();
        return;
      }
      if (event.key === "Escape" || (event.key === "ArrowLeft" && menuPath.length)) {
        event.preventDefault();
        if (menuPath.length) {
          setMenuPath(menuPath.slice(0, -1));
          setMenuRow(0);
        } else if (mentionOpen && contextScope) {
          setContextScope(null);
          setMenuRow(0);
        } else setMenuClosedFor(draft);
        return;
      }
      // A command typed out in full, with no argument to give, sends as it is.
      const complete =
        menuOpen &&
        !skillsOpen &&
        !menuPath.length &&
        !picked?.children &&
        matches.some((c) => c.name === picked?.id && draft === `/${c.name}` && c.hint === null);
      if (
        picked &&
        ((event.key === "Tab" && !event.shiftKey) ||
          (event.key === "ArrowRight" && picked.children) ||
          (event.key === "Enter" && !event.shiftKey && !complete))
      ) {
        event.preventDefault();
        // A hit left over from an earlier query is not what was typed; wait for this one's.
        if (mentionOpen && mentions.pending && mentions.items.some((h) => h.uri === picked.id))
          return;
        if (menuOpen && picked.id === "skills") openSkills();
        else if (picked.children) {
          setMenuPath([...menuPath, picked.id]);
          setMenuRow(0);
        } else {
          if (mentionOpen) pickMention(picked.id);
          else pickCommand(picked.id);
          setMenuPath([]);
          setMenuRow(0);
        }
        return;
      }
      // An open @ picker with nothing to pick yet (searching, or no hits)
      // swallows Enter rather than sending the half-typed "@query".
      if (mentionOpen && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Escape" && working) {
      event.preventDefault();
      stopTurn();
    } else if (event.key === "Tab" && event.shiftKey && status !== null && settable(status)) {
      // Only while there is a mode to switch to; otherwise Shift+Tab moves
      // focus back as usual. A held key keeps focus here but switches once,
      // not through every mode on the way round.
      const current = live?.mode?.value ?? status.mode;
      const next = nextMode(status.modes, current);
      if (next === null) return;
      event.preventDefault();
      if (!event.repeat) onMode(next);
    } else if (event.key === "Tab" && event.shiftKey && !running && current?.modes?.length) {
      // Before the session, it switches the mode that session will start in.
      const next = nextMode(current.modes, startMode(current, startModes));
      if (next === null) return;
      event.preventDefault();
      if (!event.repeat) pickStartMode(current.harness, next);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // While the agent waits on a question, typed text is its "Other" answer.
      if (draft.trim() !== "" && !draft.startsWith("/") && answerOpenCard(draft.trim())) {
        setDraft("");
        return;
      }
      if (!working || /^\/(btw|model|effort|login|clear|new|reset|stop|help)(?:\s|$)/.test(draft))
        submit(draft);
      else if (draft.trim() !== "" || chips.length > 0 || images.length > 0) {
        setQueue((now) => [...now, { id: crypto.randomUUID(), text: draft, chips, images }]);
        setDraft("");
        setChips([]);
        setImages([]);
      }
    }
  };

  // The Details panel, the agent map and the clock on task cards.
  const shownModel = modelOption(status);
  const shownValue = shownModel ? (live?.config[shownModel.id]?.value ?? shownModel.value) : null;
  const onStopFailed = useCallback(
    (err: unknown) => setNotice(noticeOf(err, strings.task.stopFailed, session)),
    [session],
  );
  const details = useDetails({
    items: state.items,
    working,
    title: sessionName,
    model: shownModel?.choices.find((c) => c.value === shownValue)?.name ?? shownValue,
    onStopFailed,
  });
  const { elapsed, openTask, stopTask } = details;

  const actions = useMemo(
    () => ({
      onAnswer: (itemId: string, optionId: string) =>
        rpc.answer(itemId, optionId).then(
          () => undefined,
          (err: unknown) => {
            setNotice(noticeOf(err, strings.failed.send, session));
            throw err;
          },
        ),
      onQuestion: (itemId: string, outcome: QuestionOutcome) =>
        rpc.answerQuestion(itemId, outcome).then(
          () => undefined,
          (err: unknown) => {
            setNotice(noticeOf(err, strings.failed.send, session));
            throw err;
          },
        ),
      onRetry: (itemId: string) => {
        const text = promptBefore(state.items, itemId);
        if (text !== null) submit(text, true);
      },
      hintText: (hint: Hint, harness: Harness) => hintText(hint, infoOf(harnesses, harness)),
      onOpenTask: openTask,
      onStopTask: stopTask,
      elapsed,
    }),
    [state.items, submit, session, harnesses, openTask, stopTask, elapsed],
  );

  // The transcript as assistant-ui's thread. Turns whose items did not change
  // keep their identity, and `convertMessage` is one function for the tab's
  // life, so assistant-ui converts again only the turn the agent is writing.
  // The lookup changes only with the items, so typing a prompt redraws none.
  // A new envelope still redraws every item: only the conversion is spared.
  const [turns, setTurns] = useState<{ items: TabState["items"]; turns: Turn[] }>({
    items: [],
    turns: [],
  });
  if (turns.items !== state.items) {
    setTurns({ items: state.items, turns: toTurns(state.items, turns.turns) });
  }
  const waiting = state.status?.state === "needsInput";
  // The running line under a turn: the tool call still going, by its title,
  // and a clock from the turn's prompt that stops when the turn does.
  let lastPrompt: string | undefined;
  for (const item of state.items) if (item.kind.kind === "userMessage") lastPrompt = item.id;
  const [since, setSince] = useState<number | undefined>(undefined);
  useEffect(() => setSince(working ? Date.now() : undefined), [working, lastPrompt]);
  const { activity, phase } = useMemo(() => workingLine(state.items), [state.items]);
  const lookup = useMemo(
    () => ({
      byId: new Map(state.items.map((item) => [item.id, item])),
      actions,
      waiting,
      activity,
      phase,
      since,
    }),
    [state.items, actions, waiting, activity, phase, since],
  );
  // The agent's to-do list stays pinned over the composer while a step is left.
  let plan: PlanEntry[] | null = null;
  for (const item of state.items) if (item.kind.kind === "plan") plan = item.kind.entries;
  const openPlan = plan?.some((entry) => entry.status !== "completed") ? plan : null;
  const runtime = useExternalStoreRuntime({
    messages: turns.turns,
    convertMessage,
    isRunning: working,
    onNew: async (message: AppendMessage) => submit(textOf(message)),
    onCancel: async () => stopTurn(),
  });

  const hint = status?.hint ?? null;
  // A session that has ended has nothing left to answer.
  const trouble = status && settable(status) ? status.settingTrouble : null;
  const model = modelOption(status);
  // An ended session's model is not what the next prompt runs.
  const runningModel: RunningModel | null =
    running !== null && model
      ? { models: model.choices, model: live?.config[model.id]?.value ?? model.value }
      : null;
  // Only the harness in use can change model: picking another is not taken yet.
  const onModel =
    model && settable(status)
      ? (picked: string, value: string | null) => {
          if (picked === running && value !== null) onConfig(model.id, value);
        }
      : undefined;
  const pendingPrompt = typeof status?.pendingPrompt === "string" ? status.pendingPrompt : null;
  /** Takes the `@query` being typed out of the draft and puts the caret back where it began. */
  const dropMention = () => {
    const query = mentions.query;
    setMenuPath([]);
    setMenuRow(0);
    setContextScope(null);
    if (!query) return;
    setDraft(draft.slice(0, query.start) + draft.slice(query.end));
    setCaret(query.start);
    requestAnimationFrame(() => {
      prompt.current?.focus();
      prompt.current?.setSelectionRange(query.start, query.start);
    });
  };
  /** Puts a reference's chip in the draft over `start..end`: the "@query" it answers, or the caret. */
  const placeChip = (hit: ChipHit, start: number, end: number) => {
    setMenuPath([]);
    setMenuRow(0);
    setContextScope(null);
    if (chips.some((c) => c.id === hit.uri)) {
      dropMention();
      return;
    }
    const placed = insertChipToken(draft, start, end, hit.title);
    setChips((now) => [...now, chipOf(hit)]);
    setDraft(placed.text);
    setCaret(placed.caret);
    requestAnimationFrame(() => {
      prompt.current?.focus();
      prompt.current?.setSelectionRange(placed.caret, placed.caret);
    });
  };
  const pickMention = (uri: string) => {
    if (uri.startsWith("scope:")) {
      setContextScope(uri.slice(6));
      setMenuPath([]);
      setMenuRow(0);
      // What was typed named the scope, so its search starts empty.
      const query = mentions.query;
      if (query && query.end > query.start + 1) {
        setDraft(draft.slice(0, query.start + 1) + draft.slice(query.end));
        setCaret(query.start + 1);
        requestAnimationFrame(() => {
          prompt.current?.focus();
          prompt.current?.setSelectionRange(query.start + 1, query.start + 1);
        });
      }
      return;
    }
    if (uri.startsWith("issue:link:")) {
      setIssuePicker(uri.slice(11));
      setMenuClosedFor(draft);
      return;
    }
    if (uri.startsWith("cluster:")) {
      // The "@query" goes now, so nothing typed while the transcript is copied is lost;
      // the chip follows where the "@" was when the copy is ready.
      const at = mentions.query?.start ?? caret;
      dropMention();
      setCapturing((n) => n + 1);
      void rpc
        .clusterContext(uri.slice(8))
        .then(
          (hit) => setChipLater(hit, at),
          () => setLoginNote(strings.mentions.failed),
        )
        .finally(() => setCapturing((n) => n - 1));
      return;
    }
    if (uri.startsWith(EDITOR_HIT)) {
      // A node or object is stored first, so it can be selected again from the chip.
      const at = mentions.query?.start ?? caret;
      dropMention();
      void editorChip(uri, editorReports).then(
        (hit) => (hit ? setChipLater(hit, at) : setLoginNote(strings.mentions.editorGone)),
        () => setLoginNote(strings.mentions.editorGone),
      );
      return;
    }
    const hit = [...mentions.items, ...canvasFrames, ...sources.issues].find((h) => h.uri === uri);
    if (!hit || !mentions.query) return;
    setLoginNote(null);
    placeChip(hit, mentions.query.start, mentions.query.end);
  };
  // Before a session, the effort and, once discovery has listed them, the mode
  // are the tab's own, sent with the prompt that starts it.
  const start = running ? null : startSection(current, startModes, pickStartMode);
  const sections = start ? [start] : settingSections(status, live, onMode, onConfig);
  if (!running)
    sections.unshift({
      label: strings.preferences.effort,
      value: effort,
      choices: EFFORT_LEVELS.map((value, i) => ({ value, name: strings.preferences.levels[i] })),
      onChange: setEffort,
    });
  for (const section of sections)
    if (section.label === strings.preferences.effort)
      section.choices = section.choices.filter((c) => c.value !== "ultra");
  const workflow =
    live?.config.ultra_effort?.value ?? status?.config.find((o) => o.id === "ultra_effort")?.value;
  const ultraEnabled =
    (running ?? chosen) === "claude" && (running ? workflow === "on" : ultracode);
  const effortValue = ultraEnabled
    ? "ultra"
    : (sections.find((s) => s.label === strings.preferences.effort)?.value ?? "medium");
  const contextItem = (h: (typeof mentions.items)[number]): MenuItem => ({
    id: h.uri,
    label: h.title,
    detail: h.detail ?? undefined,
    kind: h.kind,
    fileName: h.kind === "file" || h.kind === "folder" ? h.title : undefined,
  });
  const empty = (label: string): MenuItem[] => [{ id: `empty:${label}`, label, disabled: true }];
  const byKind = (kinds: string[]) =>
    mentions.items.filter((h) => kinds.includes(h.kind)).map(contextItem);
  // A canvas opens onto what is on it: the whole canvas first, then its frames.
  const openable = (row: MenuItem): MenuItem => {
    if (row.kind !== "canvas") return row;
    const inside = canvasFrames.filter((f) => f.uri.startsWith(`${row.id}#`));
    if (inside.length === 0) return row;
    return {
      ...row,
      id: `canvas-group:${row.id}`,
      children: [{ ...row, label: strings.wholeCanvas }, ...inside.map(contextItem)],
    };
  };
  const canvasRows = byKind(["canvas"]).map(openable);
  const group = (id: string, label: string, kind: string, children: MenuItem[]): MenuItem => ({
    id,
    label,
    kind,
    children: children.length ? children : empty(strings.mentions.empty),
  });
  const scoped = (scope: string, label: string): MenuItem => ({
    id: `scope:${scope}`,
    label,
    kind: "search",
  });
  /**
   * One kind of context to browse: what the empty search already listed, then a
   * row that searches the rest. With nothing listed the row is the search
   * itself, so picking it does not open a level holding a single row.
   */
  const browse = (
    id: string,
    label: string,
    kind: string,
    listed: MenuItem[],
    scope: string,
    search: string,
  ): MenuItem =>
    listed.length
      ? { id, label, kind, children: [...listed, scoped(scope, search)] }
      : { ...scoped(scope, label), kind };
  const issueLink = (provider: string): MenuItem => ({
    id: `issue:link:${provider}`,
    label: strings.issueLink,
    kind: "issue",
  });
  // Typed at the top level, a kind's name offers its search above the hits: "@sav" finds Saved context.
  const typed = contextScope ? "" : (mentions.query?.query ?? "").trim().toLowerCase();
  const named = typed
    ? Object.entries(strings.scopeTitle)
        .filter(([, title]) =>
          title
            .toLowerCase()
            .split(/\s+/)
            .some((word) => word.startsWith(typed)),
        )
        .map(([scope, title]) => ({ ...scoped(scope, title), kind: SCOPE_GLYPH[scope] ?? scope }))
    : [];
  // A line above the first result, under the places to browse, as Cursor's menu draws it.
  const results = (rows: MenuItem[]): MenuItem[] =>
    rows.map((row, i) => (i === 0 ? { ...row, separated: true } : row));
  // A running editor's things: under its own name at the top level, among the hits once typed.
  const editorGroups = (["godot", "blender"] as const)
    .map((tool) => ({ tool, rows: editorRows.filter((h) => h.kind.startsWith(`${tool}-`)) }))
    .filter(({ tool }) => editorReports[tool])
    .map(({ tool, rows }) => group(tool, strings.contextGroups[tool], tool, rows.map(contextItem)));
  const editorFound = contextScope
    ? []
    : matchingHits(editorRows, mentions.query?.query ?? "").map(contextItem);
  const contextItems: MenuItem[] =
    mentions.query?.query || contextScope
      ? [...named, ...results([...mentions.items.map(contextItem).map(openable), ...editorFound])]
      : [
          ...editorGroups,
          group("design", strings.contextGroups.design, "design", [
            browse(
              "canvases",
              strings.contextGroups.canvases,
              "canvas",
              canvasRows,
              "canvas",
              strings.searchCanvases,
            ),
            browse(
              "frames",
              strings.contextGroups.frames,
              "frame",
              byKind(["frame"]),
              "frame",
              strings.searchFrames,
            ),
            // Comments left on canvases, and Design Mode's; the viewers' are under Comments below.
            browse(
              "design-comments",
              strings.contextGroups.comments,
              "comment",
              byKind(["canvas-comment", "design-comment"]),
              "canvas-comment",
              strings.searchComments,
            ),
          ]),
          group("pm", strings.contextGroups.pm, "pm", [
            group("jira", strings.issues.jira, "issue", [
              ...sources.issues
                .filter((h) => /jira/i.test(`${h.title} ${h.detail}`))
                .map(contextItem),
              issueLink("jira"),
            ]),
            group("linear", strings.issues.linear, "issue", [
              ...sources.issues
                .filter((h) => /linear/i.test(`${h.title} ${h.detail}`))
                .map(contextItem),
              issueLink("linear"),
            ]),
          ]),
          ...(sources.clusters.length
            ? [
                group(
                  "clusters",
                  strings.contextGroups.clusters,
                  "cluster",
                  sources.clusters.map((c) => ({
                    id: `cluster:${c.id}`,
                    label: c.title,
                    kind: "cluster",
                  })),
                ),
              ]
            : []),
          browse(
            "files",
            strings.contextGroups.files,
            "folder",
            byKind(["file", "folder"]),
            "file",
            strings.searchFiles,
          ),
          browse(
            "comments",
            strings.contextGroups.comments,
            "comment",
            byKind(["comment", "canvas-comment", "design-comment"]),
            "comment",
            strings.searchComments,
          ),
          browse(
            "context",
            strings.contextGroups.context,
            "context",
            byKind(["context"]),
            "context",
            strings.searchSaved,
          ),
          ...results(byKind(["selection"])),
        ];
  const scopeTitle = contextScope ? strings.scopeTitle[contextScope] : undefined;
  const slashItems: MenuItem[] = matches.map((c) => ({
    id: skillsOpen ? `skill:${c.name}` : c.name,
    label: skillsOpen ? c.name.replace(/^\$/, "") : c.name,
    kind: skillsOpen || c.name === "skills" ? "skill" : "command",
    detail: `${c.description}${c.support === "terminal" ? ` · ${strings.inTerminal}` : ""}`,
    // An empty list only for its arrow: opening it starts the skill search.
    children: !skillsOpen && c.name === "skills" ? [] : undefined,
  }));
  let visibleItems = mentionOpen ? contextItems : slashItems;
  for (const id of menuPath) {
    const children = visibleItems.find((i) => i.id === id)?.children;
    if (!children) break;
    visibleItems = children;
  }
  const navigable = visibleItems.filter((i) => !i.disabled);
  const menuActive = navigable[Math.min(menuRow, navigable.length - 1)]?.id ?? null;
  const changeMenuPath = (path: string[]) => {
    if (menuOpen && path[0] === "skills") return openSkills();
    setMenuPath(path);
    setMenuRow(0);
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TurnsProvider value={lookup}>
        <NestedItems.Provider value={details.nested}>
          <ChipOpen.Provider value={chipOpener}>
            <S.Layout
              details={details.panel}
              overlay={details.overlay}
              header={
                <S.Header
                  state={status?.state ?? null}
                  onDetails={details.toggleDetails}
                  detailsOpen={details.detailsOpen}
                  onSideChat={() => askSide("")}
                  // The shell's Alt+6, sent the way the bridge forwards any chord a
                  // frame swallows; the shell opens or closes its Agents window.
                  onAgents={() =>
                    void invoke("veistra/key", { key: "6", code: "Digit6", altKey: true }).catch(
                      () => {},
                    )
                  }
                  onHistory={() => {
                    setHistoryOpen((was) => !was);
                    if (!historyOpen) loadHistory();
                  }}
                  history={
                    historyOpen ? (
                      <S.HistoryPanel
                        sessions={savedSessions}
                        loading={historyLoading}
                        error={historyError}
                        onClose={() => {
                          setHistoryOpen(false);
                          prompt.current?.focus();
                        }}
                        onRetry={loadHistory}
                        onArchive={(id, archived) => {
                          void rpc
                            .archiveHistory(id, archived)
                            .then(loadHistory, () => setHistoryError(strings.history.failed));
                        }}
                        onOpen={(id, harness) => {
                          setHistoryLoading(true);
                          setPending(null);
                          void rpc
                            .openHistory(id, harness)
                            .then(
                              (attachment) => {
                                dispatch({ type: "attached", attachment });
                                loadMeta();
                                setHistoryOpen(false);
                                setNotice(null);
                                setDraft("");
                                setChips([]);
                                void listHarnesses();
                              },
                              () => setHistoryError(strings.history.openFailed),
                            )
                            .finally(() => setHistoryLoading(false));
                        }}
                      />
                    ) : undefined
                  }
                  onNewSession={() => {
                    setNotice(null);
                    setChatName(null);
                    void rpc.reset().catch(() => {});
                  }}
                />
              }
              transcript={
                <S.Transcript>
                  {state.items.length === 0 && pendingPrompt === null ? (
                    <S.EmptyState
                      blocked={blocked}
                      setupHint={current?.hint ? hintText(current.hint, current) : null}
                      setup={setup}
                    />
                  ) : (
                    <>
                      <Turns />
                      {/* Chosen mid-conversation: the card follows what was said. */}
                      {setup && <S.SetupCard {...setup} />}
                    </>
                  )}
                  {pendingPrompt !== null && <S.UserMessage text={pendingPrompt} pending />}
                  {hint && <S.Hint text={hintText(hint, session)} />}
                  {loginNote && <S.Note text={loginNote} />}
                  {exited && state.items.length > 0 && (
                    <S.Note text={strings.exited(status.exitCode)} />
                  )}
                </S.Transcript>
              }
              composer={
                <S.Composer
                  ref={prompt}
                  chips={chips}
                  effortLevel={effortValue}
                  auxiliary={
                    issuePicker ? (
                      <S.ContextLink
                        provider={issuePicker}
                        onCancel={() => {
                          setIssuePicker(null);
                          dropMention();
                        }}
                        onAdd={(link) => {
                          const at = mentions.query ?? { start: caret, end: caret };
                          setIssuePicker(null);
                          placeChip(
                            {
                              uri: link,
                              title: link.split("/").filter(Boolean).slice(-2).join("/"),
                              kind: "issue",
                            },
                            at.start,
                            at.end,
                          );
                        }}
                      />
                    ) : undefined
                  }
                  value={draft}
                  placeholder={working ? strings.promptBusy : strings.promptPlaceholder}
                  onChange={(text, at) => {
                    setDraft(text);
                    // A reference whose token was typed over or cut is gone with it.
                    setChips((now) => {
                      const kept = keptChips(text, now);
                      return kept.length === now.length ? now : kept;
                    });
                    if (!text.includes("@")) setContextScope(null);
                    setCaret(at ?? text.length);
                    setMenuRow(0);
                    setMenuPath([]);
                  }}
                  onSelect={setCaret}
                  images={images}
                  queued={queue.map((q) => ({ id: q.id, text: q.text }))}
                  onUnqueue={(id) => setQueue((now) => now.filter((q) => q.id !== id))}
                  onRemoveImage={(id) => setImages((now) => now.filter((i) => i.id !== id))}
                  onReplaceImage={(id, image) =>
                    setImages((now) => now.map((i) => (i.id === id ? { ...i, ...image } : i)))
                  }
                  onPasteImages={(files) => void addImages(files)}
                  onAttach={() => {
                    const at = prompt.current?.selectionStart ?? draft.length;
                    const prefix = at > 0 && !/\s/.test(draft[at - 1]) ? " @" : "@";
                    const next = draft.slice(0, at) + prefix + draft.slice(at);
                    setDraft(next);
                    setCaret(at + prefix.length);
                    setMenuRow(0);
                    setMenuPath([]);
                    setContextScope(null);
                    setMenuClosedFor(null);
                    requestAnimationFrame(() => {
                      prompt.current?.focus();
                      prompt.current?.setSelectionRange(at + prefix.length, at + prefix.length);
                    });
                  }}
                  onDictate={() => {}}
                  sideChat={side.open ? <S.SideChat {...side.props} /> : undefined}
                  plan={openPlan ? <S.TodoList entries={openPlan} live={working} /> : undefined}
                  onKeyDown={onKeyDown}
                  menu={
                    mentionOpen ? (
                      <S.MentionMenu
                        label={strings.mentions.label}
                        title={scopeTitle}
                        status={named.length && !mentions.items.length ? null : mentions.note}
                        onBack={
                          contextScope
                            ? () => {
                                setContextScope(null);
                                setMenuRow(0);
                              }
                            : undefined
                        }
                        items={contextItems}
                        activeId={menuActive}
                        path={menuPath}
                        onPathChange={changeMenuPath}
                        onPick={pickMention}
                      />
                    ) : (
                      menuOpen && (
                        <S.SlashMenu
                          label={strings.commands}
                          title={skillsOpen ? strings.skills.title : undefined}
                          search={
                            skillsOpen
                              ? { query: skillSearch, placeholder: strings.skills.search }
                              : undefined
                          }
                          status={
                            skillsOpen && !matches.length
                              ? skillList.length
                                ? strings.skills.noMatch
                                : strings.skills.empty
                              : null
                          }
                          onBack={skillsOpen ? leaveSkills : undefined}
                          items={slashItems}
                          activeId={menuActive}
                          path={menuPath}
                          onPathChange={changeMenuPath}
                          onPick={pickCommand}
                        />
                      )
                    )
                  }
                  menuActiveId={mentionOpen || menuOpen ? menuActive : null}
                  notices={
                    <>
                      {attachFailed && (
                        <S.Notice
                          text={strings.failed.attach}
                          hint={null}
                          action={{ label: strings.retry, onClick: () => void attach() }}
                        />
                      )}
                      {harnessesFailed && (
                        <S.Notice
                          text={strings.failed.harnesses}
                          hint={null}
                          action={{ label: strings.retry, onClick: () => void listHarnesses() }}
                        />
                      )}
                      {trouble && (
                        <S.Notice text={troubleText(trouble)} hint={null} action={null} />
                      )}
                      {notice && <S.Notice text={notice.text} hint={notice.hint} action={null} />}
                    </>
                  }
                  controls={
                    <S.ModelMenu
                      label={strings.settings}
                      openRequest={settingsRequest}
                      harnessLocked={false}
                      ultracode={{
                        enabled: ultraEnabled,
                        disabled: status?.state === "starting",
                        onChange: (enabled) => {
                          if (running) onConfig("ultra_effort", enabled ? "on" : "off");
                          else setUltracode(enabled);
                        },
                      }}
                      harness={running ?? chosen}
                      // The model is the running session's own option, so it is
                      // listed under the harness in use, with the agent's names.
                      harnesses={harnessChoices(harnesses, running ?? chosen, runningModel)}
                      // With no agent running, a pick chooses the next session's
                      // harness. While one runs, its prompts go to that agent until
                      // a new session starts, so only its model can change.
                      onChoose={(picked, value) => {
                        if (picked === running && onModel) onModel(picked, value);
                        else chooseHarness(picked, value);
                      }}
                      sections={sections}
                    />
                  }
                  meters={
                    <>
                      <S.ValidationBadge {...latestValidation(state.items)} />
                      {details.button}
                      <S.ContextMeter {...latestUsage(state.items)} />
                      <S.UsageRing limits={[]} />
                    </>
                  }
                  action={
                    working ? (
                      <S.StopButton onClick={stopTurn} />
                    ) : (
                      <S.SendButton
                        disabled={(draft.trim() === "" && chips.length === 0) || capturing > 0}
                        onClick={() => submit(draft)}
                      />
                    )
                  }
                />
              }
            />
          </ChipOpen.Provider>
        </NestedItems.Provider>
      </TurnsProvider>
    </AssistantRuntimeProvider>
  );
}

/** The session's model option, if the agent lists one. */
function modelOption(status: SessionStatus | null): ConfigOption | null {
  return (status && pickers(status).find((o) => o.category === "model")) ?? null;
}

/** The mode each harness's next session is to start in, as the user picked it. */
type StartModes = Partial<Record<Harness, string>>;

/**
 * The mode `info`'s next session starts in: the pick, if its agent still
 * offers it, else its ask-first mode. `null` until discovery has listed the
 * modes.
 */
function startMode(info: HarnessInfo | undefined, picks: StartModes): string | null {
  const modes = info?.modes ?? [];
  if (info === undefined || modes.length === 0) return null;
  const pick = picks[info.harness];
  if (pick !== undefined && modes.some((m) => m.value === pick)) return pick;
  return info.askFirst ?? modes[0].value;
}

/**
 * The mode section before a session exists (owner decision D2 starts one on
 * the first send): the modes discovery found for the harness it will run, so
 * switching harness switches the list. The pick goes with the first prompt,
 * and the host enters it once the session has confirmed ask-first. `null`
 * until the host has asked that agent; `settingSections` speaks for it then.
 */
function startSection(
  info: HarnessInfo | undefined,
  picks: StartModes,
  onPick: (harness: Harness, mode: string) => void,
): PickerProps | null {
  const value = startMode(info, picks);
  if (info === undefined || value === null) return null;
  return {
    label: strings.mode,
    title: strings.modeSettings.modeHint,
    value,
    choices: info.modes ?? [],
    onChange: (mode: string) => onPick(info.harness, mode),
  };
}

/**
 * The settings menu's sections after the harnesses: the effort, then the
 * mode, with the agent's own names, in its order. The agent reports them once
 * its session exists, and owner decision D2 starts that on the first send, so
 * until then, unless discovery listed the modes (`startSection`), the menu
 * says when they will appear. A new model can bring other effort levels, or
 * none, so those come from each status as the agent lists them. A choice is
 * shown at once (`live`, see `unanswered` in model.ts) and stands until the
 * status that answers it.
 */
function settingSections(
  status: SessionStatus | null,
  live: Pending | null,
  onMode: (modeId: string) => void,
  onConfig: (configId: string, value: string) => void,
): PickerProps[] {
  const options = status ? pickers(status) : [];
  if (!status) {
    return [
      {
        label: strings.mode,
        value: null,
        choices: [{ value: "", name: strings.modeSettings.later }],
        disabled: true,
      },
    ];
  }
  if (status.modes.length === 0 && options.length === 0) return [];
  const disabled = !settable(status);
  const others: PickerProps[] = options
    .filter((option) => option.category !== "model" && option.id !== "ultra_effort")
    .map((option) => ({
      label:
        option.category === "thought_level" ? strings.preferences.effort : option.name || option.id,
      title: option.description,
      value: live?.config[option.id]?.value ?? option.value,
      choices: option.choices,
      disabled,
      onChange: (value: string) => onConfig(option.id, value),
    }));
  if (status.modes.length === 0) return others;
  return [
    ...others,
    {
      label: strings.mode,
      title: strings.modeSettings.modeHint,
      value: live?.mode?.value ?? status.mode,
      choices: status.modes,
      disabled,
      onChange: onMode,
    },
  ];
}

/**
 * A refused change, or one the agent is slow to answer, in words. It is said
 * above the prompt box rather than in the transcript, where an error would
 * offer to retry the last prompt.
 */
function troubleText(trouble: SettingTrouble): string {
  return trouble.kind === "refused"
    ? strings.modeSettings.refused(trouble.message)
    : strings.modeSettings.unanswered;
}

/** Module-level: a new function each render would make assistant-ui drop its
 *  cache and convert every turn again. */
function convertMessage(turn: Turn) {
  return turn.message;
}

/** The text of a message assistant-ui asks to send, such as a suggestion. */
function textOf(message: AppendMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
