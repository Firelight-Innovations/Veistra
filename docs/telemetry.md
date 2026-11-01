# Usage data and feedback

What Veistra may send about how it is used, when it may ask for feedback, and
what a new feature costs to add to either. The implementation is
`src-tauri/src/telemetry.rs` (whether a build can send, and the local ledger)
and `src/shell/telemetry/` (everything that sends). The drawn parts are in the
`src/shell/dialogs/` region: `ConsentDialog`, `FeedbackDialog`, `PromptCard`,
and `FeedbackHost`, which mounts them. This document is the contract all of it
is written to.

PostHog is the destination: product analytics, session replay, and a
`feedback:submitted` event that holds whatever a person typed.

---

## 1. What is sent, and what never is

**Nothing is sent until the person says yes.** `telemetry.usageData` starts at
`ask`, and in every state but `on` the PostHog SDK is not even downloaded — it
is a dynamic import, so somebody who declines never has it in memory and no
request reaches PostHog, not even the remote-config fetch `init` makes.

Once it is `on`:

| What | Where it comes from | Example |
|---|---|---|
| Feature events | a feature's `track()` (§4), or an app through `veistra/track` (§5) | `agent-tab:prompt_sent {effort:"medium", images:0}` |
| Clicks | PostHog autocapture, with `mask_all_text` and `mask_all_element_attributes` | a click on `button.titlebar__menu-item`, never its label or tooltip |
| Rage and dead clicks | PostHog, from the same clicks | three fast clicks on a button that did nothing |
| Session recordings | rrweb, if `telemetry.sessionReplay` is on | the shell window's layout and pointer, every character masked |
| Super properties | `telemetry::config` | `app_version`, `os`, `arch`, `build` |
| Feedback | the dialog and the corner card (§6) | `feedback:submitted {kind:"idea", message:"…"}` |

What is never sent, and how that is enforced rather than hoped for:

- **Text on screen.** Recordings mask every text node (`maskTextSelector: "*"`)
  and every attribute a person reads — `title`, `aria-label`, `alt`,
  `placeholder` — except inside an element marked `data-telemetry-unmask`.
  Autocapture sends an element's tag and classes, never its text or
  attributes. §7.
- **Anything typed.** `maskAllInputs` is on and is not a setting.
- **App panes.** They are iframes on another origin, and the recorder is not
  inside them, so a recording shows them as blank boxes.
- **Long strings in event properties.** `sanitize.ts` cuts any string over 200
  characters and drops anything that is not flat — a path or a code snippet
  passed by mistake arrives as a stub.
- **Names and emails.** The distinct id is a random UUID minted on the machine
  (`telemetry.json`). The one exception is an email the person types into the
  feedback dialog's "reply to" field, which goes with that message and nowhere
  else.
- **Console output, network traffic, canvas pixels and exceptions.** All off
  in `analytics.ts`, each by name.

## 2. Consent

Three settings, in the **Usage data & feedback** section
(`settings/schema.rs`), all `Applies::Now`:

| Key | Control | Default | Read by |
|---|---|---|---|
| `telemetry.usageData` | Select `ask` / `on` / `off` | `ask` | `consent.ts` → `analytics.ts` |
| `telemetry.sessionReplay` | Toggle | on | the same; only matters while `usageData` is `on` |
| `telemetry.feedbackPrompts` | Toggle | on | `pipeline.ts`; only matters while `usageData` is `on` |

`usageData` is a select rather than a toggle because "nobody has been asked"
is a state of its own, and the one every machine starts in. A toggle that
defaulted to off could not tell "asked and declined" from "never asked".

**The first-run question** (`ConsentDialog.tsx`) is shown four seconds after a
window opens, in the window that has focus, when `usageData` is `ask` and this
build can send. Its two buttons store an answer; Escape or a click outside
stores nothing and asks again next launch. The recording checkbox starts ticked
and sits beside the button it qualifies, so what "Share" means is on screen at
the moment it is pressed.

Changing any of the three takes effect at once in every window: on → off opts
PostHog out and stops the recording, off → on opts back in *without* sending an
`$opt_in` event about the change.

## 3. Whether a build can send at all

A person's consent is necessary, never sufficient. `telemetry::decide` answers
first, from the build:

| Condition | Result |
|---|---|
| `VEISTRA_TELEMETRY=0` | off, whatever else is true |
| no project key | off, and `VEISTRA_TELEMETRY=1` cannot override it |
| a debug build (`pnpm app`) | off unless `VEISTRA_TELEMETRY=1` |
| an identifier other than the product's (`pnpm ui launch`'s `.agent`) | off unless `VEISTRA_TELEMETRY=1` |
| `VEISTRA_POSTHOG_HOST` that is not `https://` | off |
| otherwise | ready, to `VEISTRA_POSTHOG_HOST` or `https://us.i.posthog.com` |

The key and host are read from the environment at run time first, then from
what was baked in at build time with `option_env!`. **The release workflow bakes
them in** from the repository variables `VEISTRA_POSTHOG_KEY` and
`VEISTRA_POSTHOG_HOST` (`.github/workflows/release.yml`). A project key is
write-only and is printed into every web page that uses one, so it is not a
secret — but it is not committed either, so a fork built by somebody else does
not report into Firelight's project.

When a build cannot send, Settings shows the reason in place of a switch that
would do nothing, and the feedback dialog offers the issue tracker instead.

To try it from a development build:

```sh
VEISTRA_POSTHOG_KEY=phc_… VEISTRA_TELEMETRY=1 pnpm app
```

## 4. Adding a feature

This is the modular part, and it is two edits.

**1. Declare it** in `src/shell/telemetry/features/<name>.ts`:

```ts
import { defineFeature } from "../define";

export const timeline = defineFeature({
  id: "timeline",
  name: "Timeline",
  events: ["opened", "clip_added", "exported"],
  // Optional: app ids whose frames may report these events (§5).
  apps: ["timeline"],
  // Optional: questions for the corner card (§6).
  prompts: [
    {
      id: "timeline/first-impressions",
      question: "How is the timeline working for you?",
      after: { event: "exported", count: 3 },
      minDaysInstalled: 2,
    },
  ],
});
```

**2. List it** in `src/shell/telemetry/features/index.ts`, in `FEATURES`.

Then report from wherever the thing happens:

```ts
import { timeline } from "../telemetry/features";

timeline.track("clip_added", { kind: "audio", tracks: 3 });
```

`track` is typed against `events`, so a misspelt event does not compile. The
event arrives in PostHog as `timeline:clip_added` with a `feature` property,
and the feedback dialog lists the feature under "About" at once.

`registry.test.ts` holds the list to a few rules and fails the build when one
breaks: feature ids are kebab-case and unique; events are snake_case; prompt ids
are unique, start with `<feature id>/`, and are names the Rust ledger accepts;
a prompt waits on an event its own feature declares; and no app reports for two
features.

**Choosing events.** Past-tense verbs for things a person did: `opened`,
`clip_added`, `exported`. Properties are categories and counts — which kind,
how many, which mode — never content. Report from the chokepoint every path
goes through rather than from each button, as `shell:app_loaded` is reported
from `ToolWindow`'s handshake.

## 5. Reporting from an app

An app's frontend cannot import `src/shell/`, so it goes through the bridge
with `apps/shared/telemetry.ts`:

```ts
import { openFeedback, track } from "../../../shared/telemetry";

track("clip_added", { kind: "audio" }); // "timeline:clip_added", if timeline lists this app
openFeedback(); // the feedback dialog, about this app's feature
```

These send `veistra/track` and `veistra/feedback`, which the shell answers
itself (`docs/tool-protocol.md` §3). The app names only the event. Which feature
it belongs to is decided in the shell from `event.source` — the app is whatever
the feature registry's `apps` says it is — and an event that feature does not
declare is refused with a message listing the ones it does. Tools are refused
outright: a person who shares usage data agreed to report on Veistra, not on
somebody else's code.

Both calls are fire and forget. Nothing an app does waits on, or fails because
of, a usage event.

## 6. Feedback

### The dialog

Help ▸ Send Feedback…, the agent menu's Give Feedback, the button in Settings,
and `veistra/feedback` from an app all open `FeedbackDialog.tsx`: a kind
(problem, idea, praise), what it is about (the feature list), the message, and
an optional email for a reply. It says how the message will travel before Send
is pressed:

| Delivery | When | What goes |
|---|---|---|
| `with-session` | usage data is on | the message, through the SDK, linked to this session and its recording |
| `alone` | usage data is off, the build can send | one request to `/i/v0/e/` with the message, version and OS — no SDK, no session, `$process_person_profile: false` |
| `nowhere` | the build cannot send | nothing; the dialog offers a GitHub issue instead |

Pressing Send with usage data off is consent to send *that message*, which is
why the second row exists.

### The corner card

A feature's `prompts` are questions put in `PromptCard.tsx`, a small card above
the status bar that takes no focus and traps nothing. A `rating` prompt asks
1–5 and then offers a comment; a `text` prompt is the comment alone. Its close
button dismisses; "Don't ask me again" switches `telemetry.feedbackPrompts`
off.

When one is due is `prompts.ts`, which is pure and tested:

- `after: { event, count }` — once the feature's event has happened `count`
  times across launches. Only events some prompt waits on are counted, in the
  Rust ledger, and only while usage data is on.
- `after: { launches }` — once the app has been launched that often. Checked
  ninety seconds after a window opens.
- `minDaysInstalled` holds either back until the install is that old.
- **One card per window per launch; none within three days of any other.**
- **An answer ends a question for good.** A dismissal waits three weeks, and
  after two showings without an answer the question is retired.
- Only in the focused window, and never while a dialog or another card is up.

To ask an answered question again — a quarterly "how is it going" — give it a
new id.

Every card reports `feedback:prompt_shown` and either `feedback:submitted`
(with `prompt` and `rating`) or `feedback:prompt_dismissed`, so a response rate
is a funnel in PostHog rather than a guess.

Every event carries `feature`, the feature that *sent* it, so a breakdown by
`feature` is never split by a property that happened to share the name. The
feedback events say which feature they are *about* in `about` — `general` for
the product as a whole.

## 7. Session recordings and masking

Recordings are of the shell's own window. Every text node is masked by
`maskText` in `analytics.ts` unless it is inside an element carrying
`data-telemetry-unmask` (`UNMASK_ATTRIBUTE`), and every input is masked
regardless.

Attributes need the same treatment, because a recording keeps them all and a
tab's tooltip names its file. `maskAttribute` masks the ones that are prose
(`title`, `aria-label`, `alt`, `placeholder`, `data-path`, …) by name, and
anything that looks like a path — a drive letter, a home directory, the
`asset:` protocol — by content, emptying a `src` or `href` rather than letting
the replay load the file. `class`, `style` and the `data-*` values the
stylesheets match on (`[data-dir="row"]`) are kept, so a replay still looks like
the window it was.

Masking is the default and unmasking the exception because the shell shows the
person's work almost everywhere: file names in tabs, paths in the tree, code in
search results, branch names, commit messages, the project's name in the title
bar. A list of places to mask would leak the next one somebody adds; a list of
places to leave readable can only ever be too short.

So mark an element `data-telemetry-unmask` only when **everything** inside it is
the product's own words and always will be. The feedback dialogs and the corner
card are marked. A menu is not: the Run menu's "Re-run" row carries the last
command typed.

## 8. Setting up the PostHog project

Configured in PostHog, not here:

1. **Session replay** must be switched on for the project, or the SDK records
   nothing whatever the setting says. Set a minimum duration so a launch that
   closes at once does not make an empty recording.
2. **Discard client IP data** (project settings), so a person's address is not
   stored alongside an anonymous id.
3. **Data retention** to whatever the privacy policy promises.
4. **Feedback**: an insight on `feedback:submitted`, broken down by `about`
   and `kind`, with `message` shown. `feedback:prompt_shown` against
   `feedback:submitted` filtered on `prompt` is each question's response rate.

Then set `VEISTRA_POSTHOG_KEY` (and `VEISTRA_POSTHOG_HOST` for the EU cloud) as
repository variables, and the next release carries them.

## 9. Why the capture is in the webview

Rust owns everything that touches the machine (STANDARDS.md §1), and this is
the one subsystem that sends from the frontend instead. That was decided, not
drifted into:

- **A recording is of the DOM.** Only the webview has one.
- **Events from Rust would arrive as strangers.** PostHog links an event to a
  recording by the session id the browser SDK mints. Events sent from Rust
  would need that id handed down on every call, and would still miss the
  SDK's own (autocapture, rage clicks).
- **The SDK already batches, retries and queues offline.** Doing it again in
  Rust is an HTTP client written to send fewer things worse.

What stays in Rust is everything that is not a person's choice: whether this
build may send (§3), the install id, and the ledger — which is in Rust rather
than `localStorage` because two windows count into it at once, and a
read-modify-write in two webviews loses increments that one mutex does not.

The SDK is `posthog-js/full/no-external`, the build with the recorder inlined
and no script loader. The default build fetches `recorder.js` from PostHog's CDN
at run time, and this webview runs with `withGlobalTauri`, so a fetched script
would hold every `#[tauri::command]` through `window.__TAURI__`. It is pinned
to an exact version in `package.json` for the same reason.

## 10. What this does not do yet

- **No recording inside app panes.** Doing so needs the recorder loaded in
  each app and `recordCrossOriginIframes` on in both halves.
- **No Rust-side events.** A feature whose only moment happens in Rust would
  need a Tauri event the pipeline forwards. Nothing needs it yet.
- **No PostHog Surveys.** The questions are in code, so changing one needs a
  release; in exchange they are typed, tested and drawn in Veistra's own UI.
  Mapping a prompt onto a PostHog survey id, so its answers land in the Surveys
  tab, is the obvious next step.
- **No feature flags in use.** The SDK fetches them, and nothing reads one.
- **No identify.** A person signed in to Veistra Cloud is still anonymous here.
- **No error tracking.** `capture_exceptions` is off because an error message
  can carry a path; `pnpm probe recent_errors` is still the place to look.
- **The ledger is local.** Reinstalling Windows asks every question again.
