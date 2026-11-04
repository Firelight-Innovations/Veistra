/**
 * Which extensions each asset viewer claims (issue #342). Kept apart from the
 * viewers so `registry.ts` can match on them without importing a viewer — the
 * import would pull three.js into every bundle that touches the explorer. The
 * full list of art formats, previewed or not and why, is
 * `docs/design-notes/asset-previews.md`.
 */

/** Must match `MODEL_FORMATS` in `@veistra/scene-view`; a test holds the two together. */
export const MODEL_EXTENSIONS = new Set([
  "glb",
  "gltf",
  "obj",
  "fbx",
  "dae",
  "stl",
  "ply",
  "3ds",
  "3mf",
]);

export const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "ogg", "oga", "opus", "flac", "m4a"]);
export const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv"]);

export const FONT_EXTENSIONS = new Set(["ttf", "otf", "woff", "woff2"]);
