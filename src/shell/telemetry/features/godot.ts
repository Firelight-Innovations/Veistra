/**
 * Godot in Veistra: the game in the pane, takes, and play notes through the
 * fix loop (`docs/design/VEISTRA-PLAY-REVIEW.md` §13's launch events).
 *
 * Declared whole, once, so each issue that fires one adds a call rather than
 * an edit to this list. Where each fires:
 *
 * - `play_embedded`, `play_embed_failed`: Rust, where the embed outcome is
 *   decided, once per attach (`telemetry::track`).
 * - `take_recorded`: Rust, when `take.json` is written.
 * - `mark_dropped`, `note_created`, `notes_sent`: the page, through
 *   `apps/shared/telemetry.ts`.
 * - `note_fixed`, `note_resolved`: Rust, from the comment store's write
 *   (`comment_events.rs`), so an agent's fix and a verdict from any surface
 *   count once.
 *
 * Both app ids report here: `play` opens the Godot app in Play mode.
 * Properties are counts, flags and short codes, never paths, node names or a
 * note's words.
 */
import { defineFeature } from "../define";

export const godot = defineFeature({
  id: "godot",
  name: "Godot",
  apps: ["godot-viewer", "play"],
  events: [
    "play_embedded",
    "play_embed_failed",
    "take_recorded",
    "mark_dropped",
    "note_created",
    "notes_sent",
    "note_fixed",
    "note_resolved",
  ],
});
