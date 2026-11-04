# Asset previews in the Files viewer

Issue #342. The Files viewer (`apps/viewer/`) answers one question about a file: *what is
in it?* It does not edit art. Editing belongs to each application's own app — the Godot
Viewer, the Blender Viewer — and to the application itself. A preview is therefore allowed
to be partial (a `.blend`'s thumbnail rather than its scene) as long as it says so and
offers the handoff.

Every viewer is chosen by extension in `apps/viewer/ui/src/viewer/registry.ts`; the
extension sets for the asset viewers live in `assetFormats.ts` so the registry can match
on them without importing three.js.

## The constraints every preview works within

- **No application installed is assumed.** A preview that needs Blender, Godot or
  Photoshop is not a preview. Everything below decodes in the webview, from bytes.
- **Bytes come through `files/read-bytes`**, which refuses files over 32 MiB rather than
  truncate them. A larger model or video gets the read's own message. `files/read-head`
  (added for `.blend`) returns a bounded prefix, for formats whose answer is at the front.
- **WebView2 is Chromium.** What `<img>`, `<audio>` and `<video>` decode is what Chrome
  decodes, without the proprietary codec pack.
- **Read-only.** No viewer here registers a save.

## The list

Legend: **Shown** — previewed today. **Planned** — a known way to preview it, not built.
**Handoff** — no faithful preview without the owning application; the unsupported page's
Reveal / Open with the default app is the answer.

### 3D models — `ModelViewer`, in `@veistra/scene-view`

The orbitable view the Godot and Blender viewers already use. Non-glTF formats are parsed
by three.js's loaders in `packages/scene-view/src/formats.ts`, each dynamically imported,
and handed to the engine as a scene. The strip under the view gives the triangle count.

| Format | Status | How |
|---|---|---|
| `.glb` | Shown | `GLTFLoader`, cameras and lights included |
| `.gltf` | Shown | `GLTFLoader`; relative `.bin` and texture URIs are read and inlined as data URIs first (`gltfInline.ts`), since the iframe has no URL they resolve against |
| `.obj` | Shown | `OBJLoader`. Geometry only — the `.mtl` is not resolved (Planned: `MTLLoader` with sibling reads, as `.gltf` does) |
| `.fbx` | Shown | `FBXLoader`, binary and ASCII. Embedded textures show; external ones do not |
| `.dae` | Shown | `ColladaLoader` |
| `.stl` | Shown | `STLLoader`, given a neutral lit material |
| `.ply` | Shown | `PLYLoader`; a PLY with no faces is a point cloud and drawn as points |
| `.3ds` | Shown | `TDSLoader` |
| `.3mf` | Shown | `3MFLoader` |
| `.blend` | Shown (thumbnail) | `BlendViewer` reads the head of the file and decodes the thumbnail Blender embeds (the `TEST` block), plus the saving version. Plain and gzip files; zstd only where the webview's `DecompressionStream` supports it. The scene itself needs Blender — Planned: show the Blender Viewer's existing glTF export (`blender-viewer/glb`) here when one exists |
| `.vox` | Planned | three's `VOXLoader` (MagicaVoxel); one more case in `formats.ts` |
| `.usdz`, `.usda` | Planned | three's `USDZLoader` covers USDA and USDZ-with-USDA; binary `.usdc` is not read by it, so `.usd` would be hit and miss |
| Draco / meshopt-compressed glTF | Planned | `GLTFLoader` needs `DRACOLoader` and the meshopt decoder set on it; today such a file shows the loader's error |
| `.max`, `.ma`/`.mb`, `.c4d`, `.skp`, `.ztl`, `.spp` | Handoff | Proprietary. (`.ma` is text and opens in the editor) |
| `.scn`, `.res` (Godot binary) | Handoff | The Godot Viewer; the text forms `.tscn`/`.tres` open highlighted in the editor (#341) |

Not attempted for any model: animation playback (the bind pose is shown) and editing.

### Raster images — `ImageViewer`

| Format | Status | How |
|---|---|---|
| `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`, `.avif` | Shown | `<img>`, as before |
| `.svg` | Shown | `SvgViewer`, as before |
| `.tga` | Shown | `tga.ts` decodes it (true-colour, greyscale and colour-mapped, raw or RLE, either origin) and `raster.ts` re-encodes PNG for the same `<img>` |
| `.psd` | Planned | The flattened composite at the end of the file: 8-bit RGB/greyscale, raw or PackBits — about 100 lines. Caveat: with "Maximize Compatibility" off, Photoshop writes no real composite |
| `.kra` (Krita), `.ora` (OpenRaster) | Planned | Both are zips with a `mergedimage.png`; a zip's local headers plus `DecompressionStream("deflate-raw")` read it with no new dependency |
| `.aseprite`/`.ase` | Planned | Chunked format, zlib cel data (`DecompressionStream("deflate")`); composite frame 0's visible layers |
| `.exr`, `.hdr` | Planned | three's `EXRLoader` / `RGBELoader` to float pixels, tone-mapped to 8-bit for `<img>` |
| `.dds`, `.ktx2`, `.basis` | Planned | GPU-compressed. Cheapest honest preview is the header — size, pixel format, mip count; the image itself needs a WebGL draw and readback |
| `.tif`/`.tiff` | Planned (low) | Chromium does not decode TIFF; needs a decoder dependency |
| `.xcf`, `.clip`, `.procreate`, `.afphoto`, `.heic` | Handoff | Proprietary or undecodable in Chromium |

### Audio and video — `MediaViewer`

| Format | Status | How |
|---|---|---|
| `.wav`, `.mp3`, `.ogg`/`.oga`/`.opus`, `.flac`, `.m4a` | Shown | `<audio controls>` |
| `.mp4`/`.m4v`, `.webm`, `.ogv` | Shown | `<video controls>` |
| `.aiff` | Planned | Chromium does not play it; PCM is simple to rewrap as WAV |
| `.mid`/`.midi` | Handoff | Needs a synthesiser |
| `.mov`, `.avi`, `.mkv` | Handoff | Container and codec vary; Chromium plays some and not others, so none is claimed |
| FMOD `.bank`, Wwise `.bnk` | Handoff | Middleware banks |

A whole-file read means a long video over 32 MiB does not play. Planned: serve media
through a URL the backend streams with range requests.

### Fonts — `FontViewer`

| Format | Status | How |
|---|---|---|
| `.ttf`, `.otf`, `.woff`, `.woff2` | Shown | `FontFace` under a private family name; name, alphabet and a size ladder |
| `.fnt` (BMFont) | Handoff | Text descriptor plus a page image; opens as text |

### Text formats used by game art

`.gd`, `.tscn`, `.tres`, `project.godot` and `.import` open in the editor with real
grammars (#341, `docs/design-notes/monaco-languages.md`). `.gdshader` opens as plain text;
a shading-language grammar is Planned.
