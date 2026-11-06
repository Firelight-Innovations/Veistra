# Agent tab components

Every visual piece of the agent tab is a **slot**: a name in `registry.tsx` mapped to a component.
`App.tsx` and `Items.tsx` hold the state and the logic. They render only through `useSlots()` and
emit no DOM of their own.

## Swap a component

Change one line in `defaultSlots` in `registry.tsx`:

```ts
ToolCall: MyToolCall,
```

To swap a component for one subtree only, without editing the default, wrap it:

```tsx
<SlotsProvider slots={{ ToolCall: MyToolCall }}>…</SlotsProvider>
```

The replacement takes the props interface in `types.ts`. The test in `registry.test.tsx` swaps
every slot for a stub and fails if any DOM is left outside a slot. It renders only the slots the tab
uses today, so the reserved slots below are not covered until something renders them.

## Restyle

Colour, type, spacing, radius, size and motion are `--k-*` custom properties in
`src/agent-tokens.css`. Its values point at the
shell's tokens in `src/tokens.css`, so light and dark follow the shell. Components read only `--k-*`.
Change a value there to restyle the tab. For one piece, change the stylesheet that holds it. There are four, each
shared by a group of components:

- `frame.css`: Layout, Header, StatusBadge, Transcript and EmptyState.
- `items.css`: UserMessage, AssistantText, Thinking, ToolCall, Diff, PathList, Approval, TodoList,
  Usage, ErrorItem, Note and Hint.
- `composer.css`: Composer, Notice, SendButton, StopButton, ContextMeter and Picker.
- `menu.css`: Menu and SessionList.

Some components keep a stylesheet of their own beside them, such as `question.css` for
QuestionCard, the agent's multiple-choice question.

## Rules for a component

- Plain data and callbacks in. Keep only UI-local state, such as open or closed.
- Reach another piece through `useSlots()`, never by importing a sibling file. `seam.test.ts`
  enforces this, and it checks that no component imports the bridge, `rpc` or `model`.
- User-facing text comes from `strings.ts`.
- A new component file needs an entry in `Slots` and `defaultSlots`. `seam.test.ts` fails if the file
  is not imported by `registry.tsx` or no slot maps to it, and the type check fails if `Slots` and
  `defaultSlots` disagree.

## Reserved slots

These slots are defined but not rendered yet. Their features are still being built:
`ModePicker`, `ModelPicker`, `EffortPicker`, `HarnessPicker`, `OptionPicker`, `SlashMenu`,
`MentionMenu` and `SessionList`. Every picker defaults to `Picker`, and both menus default to `Menu`.

## The thread and assistant-ui

The tab runs on `@assistant-ui/react` (pinned in `package.json`) with its external-store runtime.
Our own state stays the source of truth, and assistant-ui draws the thread around it:

- `thread.ts` groups the items into turns. Each prompt is a user turn. Everything the agent does
  until the next prompt is one agent turn, with one part per item. Work the agent starts on its own
  between prompts, such as answering a finished background task, carries a turn id of its own and
  is a turn of its own.
- A subagent's items name the call that started it as their `parent`. They are left out of the
  turn and drawn inside that call's `ToolCall` row instead, through its `children`
  (`NestedItems` in `Items.tsx`).
- `Turns.tsx` draws each turn through the `UserTurn` or `AssistantTurn` slot. It draws each part by
  looking its item up and handing it to the item's own slot, so `ToolCall`, `Diff` and the rest are
  unchanged.
- The default `Transcript`, `UserTurn`, `AssistantTurn` and `TurnActions` use assistant-ui's
  primitives for scrolling, turns and the copy action. A replacement may use them too. Everything is
  rendered inside `AssistantRuntimeProvider`. A replacement that draws plain DOM also works.
- `Working` shows while the turn runs and has not ended on text: before anything arrives, and after
  a tool call or a thought. It does not show while the agent waits on an approval.
- Two or more tool calls in a row fold into one `ActionGroup`: a line such as "Ran 2 commands, read
  a file", with the calls in a card below it. `actions.ts` writes the line. Anything else in
  between, such as text or an approval, breaks the run. A lone call goes through `ActionGroup` too,
  with `grouped` false, and is drawn as a plain `ToolCall` row. Keeping one wrapper means a row the
  user opened stays open when a second call joins it.
- `Thinking`, `ToolCall` and `ActionGroup` fold behind a caret (`.at-disclosure`). Their label and
  `Working` shimmer (`.at-shimmer[data-live]`) while the agent is still at it, between
  `--k-shimmer-base` and `--k-shimmer-glint`. Under reduced motion the label holds still.

assistant-ui ships no CSS, so the look is ours: the tokens above and each component's `.css`.

## The composer's footer

The footer reads like a coding agent's: one settings button on the left, the meters and Send on the
right.

- `ModelMenu` is the settings button. It reads the current settings as one line ("Claude · Opus 5.5
  · High") and opens a menu.
  - First come the harnesses, one group each, with its models under it: Claude, Codex, then Veistra.
    Picking a model picks its harness too (`onChoose(harness, model)`). A harness whose models are
    not known lists "Default model", and one that cannot run yet lists why, locked.
  - Then one section per other setting, such as effort and mode. Each takes a picker's props. A
    section without `onChange` is shown but cannot be changed. A section with no choices and no
    value is left out; a value the agent reports but does not offer is listed first, checked.
  - `harnesses.ts` builds the harness list. The one in use takes its models from the running
    session. The rest take what the host scanned, read from optional fields until the host sends
    them. A harness the host does not report reads "Coming soon", and one it cannot start reads
    "Not set up". The harness in use is never locked.
- `ContextMeter` is a short bar and a percentage. On hover or focus it opens a card with the
  window's size, a stacked bar, and a row per category plus the free space. Without `categories`
  the card has one "Used" row.
- `UsageRing` is a ring as full as the tightest usage limit. On hover or focus it opens a card with
  a bar per limit and when it resets. With no limits it draws nothing, which is the case until the
  agent host reports them.
- Both meters open their cards through the `HoverCard` slot and draw rings through `Ring`, so one
  replacement changes both. `meters.ts` holds the thresholds: a meter turns `high` at 80% and
  `full` at 95%, read from `--k-meter-*`. The context categories take `--k-context-1` to `-6`.

## Background tasks, the Details panel and the agent map

- `TaskCard` is a background task in the transcript: a workflow, a shell command or a monitor. It
  shows the task's state and running time, and a workflow's phase and agents. Details opens the
  panel on it, and Stop asks the agent to stop it. The task's item is updated in place long after
  its turn ends.
- `NoticeItem` is an advisory from the agent. `CompactionItem` is a divider where the agent
  compacted the conversation, with what it kept folded under it.
- `DetailsPanel` opens from the header. It has the sections Claude's own app has: Environment,
  Context, Connectors, Outputs, Changes and Background tasks. Rows open in the rest of Veistra: a
  file in the viewer, changes in the Git sidebar, connectors in Settings. With a task open,
  `TaskDetail` takes the panel's place: the task's phases with their agents, then what is up next.
  `Layout` puts the panel beside the conversation, and over it in a tab narrower than 720px. This
  is a container query, so a narrow pane in a wide window gets the overlay too.
- `AgentMap` is the session, its subagents and its background tasks, opened from `AgentsButton` in
  the composer's footer. A subagent opens its call in the transcript, and a task opens the panel.
- `details.ts` works out what all of these show, and `useDetails.tsx` turns it into props. The
  protocol carries no clock, so running times are timed by the tab from when it first saw an item.
  An item that had already finished when the tab first saw it has no time.

