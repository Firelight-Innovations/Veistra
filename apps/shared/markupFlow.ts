/**
 * What happens to a markup once the person presses Done: whether it goes to the
 * agent at once or waits for a click, and the one-time offer to make it
 * automatic. The two settings are the host's shared Markup section
 * (`markup.autoSend`, `markup.tip`), one choice for every viewer with markup;
 * this reads them over `settings/all` and flips them over `settings/set`, which
 * the host allows for exactly these two keys.
 *
 * It also holds how a markup reaches the agent, shared by the Godot and Blender
 * viewers: the picture and the JSON as two context items and one chip on the
 * agent's prompt, the picture's, whose prompt names the JSON's file. What
 * differs between viewers is only the {@link MarkupTarget}: the key prefix
 * and the label the items carry.
 */
import { invoke } from "@veistra/bridge";
import type { MarkupJson } from "@veistra/markup";
import { chipAllToAgent, contextKey, putWithAttached, type ContextRef } from "./context";

/** Which viewer a markup came from: names its context keys and labels. */
export interface MarkupTarget {
  /** The first part of every context key, e.g. `godot`. */
  app: string;
  /** What a strip entry calls the viewer, e.g. `Godot`. */
  label: string;
}

export const GODOT_TARGET: MarkupTarget = { app: "godot", label: "Godot" };
export const BLENDER_TARGET: MarkupTarget = { app: "blender", label: "Blender" };

export const AUTO_SEND_KEY = "markup.autoSend";
export const TIP_KEY = "markup.tip";

export interface MarkupPrefs {
  /** Done sends the markup to the agent straight away. */
  auto: boolean;
  /** Offer to make sending automatic after a manual send. */
  tip: boolean;
}

interface Snapshot {
  groups: Array<{ settings: Array<{ key: string; control: { default: unknown } }> }>;
  values: Record<string, unknown>;
}

/**
 * The two toggles from one `settings/all` answer. `values` is sparse: a key
 * still at its default is absent, so a miss means the shipped default (off for
 * auto-send, on for the tip), never "false".
 */
export function prefsFrom(snapshot: Snapshot): MarkupPrefs {
  const defaults = new Map<string, unknown>();
  for (const group of snapshot.groups) {
    for (const setting of group.settings) defaults.set(setting.key, setting.control.default);
  }
  const toggle = (key: string, fallback: boolean): boolean => {
    const value = snapshot.values[key] ?? defaults.get(key);
    return typeof value === "boolean" ? value : fallback;
  };
  return { auto: toggle(AUTO_SEND_KEY, false), tip: toggle(TIP_KEY, true) };
}

/**
 * Read fresh every time: the person can flip the setting on the settings screen
 * while this pane stays open, and nothing pushes the change into the frame. When
 * the host cannot answer, markup stays manual and the offer stays quiet.
 */
export async function readPrefs(): Promise<MarkupPrefs> {
  try {
    return prefsFrom(await invoke<Snapshot>("settings/all"));
  } catch {
    return { auto: false, tip: false };
  }
}

export const setPref = (key: typeof AUTO_SEND_KEY | typeof TIP_KEY, value: boolean) =>
  invoke("settings/set", { key, value });

/** Done: send now, or keep the markup and wait for the Send button. */
export function afterDone(prefs: MarkupPrefs): "send" | "keep" {
  return prefs.auto ? "send" : "keep";
}

/**
 * Whether a manual send should offer to make sending automatic: only while the
 * setting is off, the person has not said "don't show again", and not twice in
 * one session (`shownThisSession`), so closing it once is enough for now.
 */
export function offerAutomatic(prefs: MarkupPrefs, shownThisSession: boolean): boolean {
  return !prefs.auto && prefs.tip && !shownThisSession;
}

/** What the card and the previous-markup view say the drawing holds. */
export function markupSummary(json: Pick<MarkupJson, "pins" | "annotations">): string {
  const { pins, annotations } = json;
  const parts = [
    pins.length > 0 && `${pins.length} ${pins.length === 1 ? "pin" : "pins"}`,
    annotations.length > 0 &&
      `${annotations.length} ${annotations.length === 1 ? "mark" : "marks"}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

/** Text the store keeps whole; over this it cuts at a line, which would break the JSON. */
const MAX_JSON_BYTES = 240 * 1024;

/**
 * The markup JSON as text an agent reads. The raw Excalidraw elements are for
 * reopening the drawing in Canvas and can be large (a freehand stroke is
 * hundreds of points), so when the whole document would not fit they are left
 * out and `excalidrawOmitted` says so; pins, annotations and the camera, which
 * are what an agent acts on, are always kept.
 */
export function markupJsonText(json: MarkupJson): string {
  const whole = JSON.stringify(json, null, 2);
  if (new TextEncoder().encode(whole).length <= MAX_JSON_BYTES) return whole;
  return JSON.stringify(
    {
      ...json,
      excalidraw: { elements: [], appState: json.excalidraw.appState },
      excalidrawOmitted: true,
    },
    null,
    2,
  );
}

export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // In slices: spreading a whole PNG into one call overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A base64 PNG as a Blob, for sending a markup that was kept on disk. */
export function base64Blob(base64: string, type = "image/png"): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Sends a markup export: the picture under `<app>/<subject>/markup` and the
 * JSON beside it, as a JSON item, under `<app>/<subject>/markup-json`. Both
 * keys are stable, so marking up the same scene again replaces these two items
 * rather than adding more. Resolves with both items; the picture is what a drag
 * onto a terminal carries.
 */
export async function putMarkupItems(
  target: MarkupTarget,
  png: Blob,
  json: MarkupJson,
  subject: string | null,
): Promise<{ image: ContextRef; notes: ContextRef }> {
  const name = subject ?? "scene";
  const notes = await invoke<ContextRef>("context/put", {
    key: contextKey(target.app, name, "markup-json"),
    kind: "json",
    title: `${name} - markup notes (JSON)`,
    label: `${target.label} - markup JSON`,
    text: markupJsonText(json),
    prompt: `The pins, marks and notes of my ${target.label} markup of ${name}, as JSON. Each pin points at a place in the markup picture.`,
  });
  const image = await putWithAttached(
    {
      key: contextKey(target.app, name, "markup"),
      kind: "image",
      title: `${name} - markup`,
      label: `${target.label} - markup`,
      bytesBase64: await blobBase64(png),
      prompt: `My markup of ${name} in ${target.label}: what I drew over the view. The pins and notes I wrote on it are in the markup JSON sent with it. Use them for what I ask.`,
    },
    [{ item: notes, what: "the markup JSON" }],
  );
  return { image, notes };
}

/** The picture's item, for a drag onto a terminal. */
export async function putMarkup(
  target: MarkupTarget,
  png: Blob,
  json: MarkupJson,
  subject: string | null,
): Promise<ContextRef> {
  return (await putMarkupItems(target, png, json, subject)).image;
}

/**
 * A markup as the one item a Send chips on the agent's prompt: the picture,
 * whose prompt names the JSON's file and which carries it for a terminal.
 * Both auto-send and the Send markup button come through here, so they
 * behave the same.
 */
export async function sendMarkup(
  target: MarkupTarget,
  png: Blob,
  json: MarkupJson,
  subject: string | null,
): Promise<ContextRef[]> {
  const { image } = await putMarkupItems(target, png, json, subject);
  return [image];
}

/**
 * {@link sendMarkup} and the chips, for a Done that sends without a Send
 * button's `useSendAction`. Says where the markup went, for the pane's notice.
 */
export async function markupToAgent(
  target: MarkupTarget,
  png: Blob,
  json: MarkupJson,
  subject: string | null,
): Promise<string> {
  const said = await chipAllToAgent(await sendMarkup(target, png, json, subject));
  return said.delivered
    ? "Markup sent to the agent."
    : `The markup is in the Context strip, but no agent took it: ${said.reason}.`;
}
