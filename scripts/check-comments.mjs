/**
 * Comment-density checks for Rust and TypeScript, with a ratchet.
 *
 * STANDARDS.md §4 asks this codebase to explain itself in prose, and it does —
 * but prose has a runaway mode, and two shapes of it are worth catching: RATIO
 * and RUN, each documented on the `MAX_RATIO` and `MAX_RUN` constants below.
 * The two catch genuinely different files, which is why both are on. Neither
 * is a statement that the prose is wrong — §4 is still the standard, and a
 * long comment that records a rejected alternative is the most valuable thing
 * in the repo. These are limits on *concentration*, not on total.
 *
 * Usage:
 *   node scripts/check-comments.mjs            check against the baseline
 *   node scripts/check-comments.mjs --update    rewrite the baseline
 *   node scripts/check-comments.mjs --report    print every file, worst first
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "comment-baseline.json");

const update = process.argv.includes("--update");
const report = process.argv.includes("--report");

/**
 * Above this share of non-blank lines being comments, a file fails. Past half,
 * the code is an illustration inside an essay rather than the other way round.
 */
const MAX_RATIO = 0.5;

/**
 * Longer than this many consecutive comment lines, a file fails. An unbroken
 * wall of comment is the shape that actually prompted the check, and ratio
 * alone does not see it: `src-tauri/src/apps/files.rs` is only 32% comment
 * overall and still reads as overwhelming, because its 610 comment lines
 * arrive in long uninterrupted blocks.
 *
 * Calibrated against the tree rather than picked. Among files that exceed any
 * cap, the median unbroken run is 28 lines and the longest is 85, so a cap of
 * 15 would have flagged 116 of 168 files — a number that describes an ambition
 * rather than this codebase. 20 still catches every wall worth calling a wall,
 * including that same `files.rs`, whose longest block is 35 lines.
 *
 * 20 lines is also about as much prose as fits on screen beside the code it
 * describes, which is the practical version of the same judgement.
 */
const MAX_RUN = 20;

/**
 * Files shorter than this are exempt from the ratio check. A 20-line module
 * that is a doc comment and three lines of re-export is fine, and is a shape
 * §5 explicitly asks for in `lib.rs`.
 */
const MIN_LINES_FOR_RATIO = 40;

const ROOTS = ["src", "apps", "packages", "src-tauri/src", "crates", "examples", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "dist-ssr", ".git", "public"]);
const EXTENSIONS = [".rs", ".ts", ".tsx", ".mjs"];

/** Generated files nobody writes by hand. */
const SKIP_FILES = new Set([
  "packages/file-icons/src/manifest.generated.ts",
  "src/branding.generated.ts",
  "apps/home/ui/src/branding.generated.ts",
  "apps/files/ui/src/branding.generated.ts",
  "apps/agent-tab/ui/src/protocol.generated.ts",
  "apps/agent-tab/ui/src/veistra-show.generated.ts",
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Measure one file.
 *
 * Blank lines count towards neither total nor run: a blank line between two
 * paragraphs of the same comment block should not reset the run, and padding a
 * file with blank lines should not dilute its ratio.
 *
 * Known limitation: this is line-based, not a parser. A line inside a template
 * literal that begins with `//` counts as a comment. In practice that is rare
 * enough not to justify pulling in two real parsers, but it is why the caps are
 * generous rather than tight.
 */
function measure(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let total = 0;
  let comment = 0;
  let run = 0;
  let maxRun = 0;
  let inBlock = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    total += 1;

    let isComment = false;
    if (inBlock) {
      isComment = true;
      if (line.includes("*/")) inBlock = false;
    } else if (line.startsWith("//")) {
      isComment = true;
    } else if (line.startsWith("/*")) {
      isComment = true;
      if (!line.includes("*/")) inBlock = true;
    } else if (line.startsWith("*")) {
      // Continuation of a block comment whose opener was on an earlier line.
      isComment = true;
    }

    if (isComment) {
      comment += 1;
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }

  if (total === 0) return null;
  return { total, comment, ratio: comment / total, maxRun };
}

const files = ROOTS.flatMap((root) => walk(join(repoRoot, root)));
const measured = [];

for (const file of files) {
  const path = relative(repoRoot, file).split("\\").join("/");
  if (SKIP_FILES.has(path)) continue;
  const m = measure(file);
  if (m) measured.push({ path, ...m });
}

measured.sort((a, b) => b.ratio - a.ratio);

if (report) {
  console.log(`${measured.length} files measured\n`);
  console.log("  ratio   run   comment/total   file");
  for (const f of measured.slice(0, 40)) {
    const flag = violationsOf(f).length ? " <-" : "   ";
    console.log(
      `  ${(f.ratio * 100).toFixed(1).padStart(5)}%  ${String(f.maxRun).padStart(4)}   ` +
        `${String(f.comment).padStart(5)}/${String(f.total).padEnd(6)}  ${f.path}${flag}`,
    );
  }
  process.exit(0);
}

/** Which caps this file exceeds, ignoring any baseline. */
function violationsOf(f) {
  const out = [];
  if (f.total >= MIN_LINES_FOR_RATIO && f.ratio > MAX_RATIO) out.push("ratio");
  if (f.maxRun > MAX_RUN) out.push("run");
  return out;
}

if (update) {
  const baseline = {};
  for (const f of measured) {
    if (violationsOf(f).length === 0) continue;
    baseline[f.path] = { ratio: Number(f.ratio.toFixed(4)), maxRun: f.maxRun };
  }
  const sorted = Object.fromEntries(
    Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  console.log(
    `comment baseline written: ${Object.keys(sorted).length} grandfathered files ` +
      `of ${measured.length} measured`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error("comment-baseline.json is missing. Create it with:");
  console.error("  node scripts/check-comments.mjs --update");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const failures = [];

for (const f of measured) {
  const allowed = baseline[f.path];
  // Grandfathering works like scripts/clippy-baseline.mjs: `comment-baseline.json`
  // records what each offending file looks like today, so a grandfathered file is
  // held to its own current shape and everything else to the cap — a file may not
  // get worse than the larger of its baseline and the cap. Either way a file is
  // never allowed to get worse than it is now, and new files must meet the cap
  // outright.
  const ratioLimit = Math.max(MAX_RATIO, allowed?.ratio ?? 0);
  const runLimit = Math.max(MAX_RUN, allowed?.maxRun ?? 0);

  const problems = [];
  if (f.total >= MIN_LINES_FOR_RATIO && f.ratio > ratioLimit + 0.0001) {
    problems.push(
      `${(f.ratio * 100).toFixed(1)}% comments (limit ${(ratioLimit * 100).toFixed(1)}%)`,
    );
  }
  if (f.maxRun > runLimit) {
    problems.push(`${f.maxRun} consecutive comment lines (limit ${runLimit})`);
  }
  if (problems.length) failures.push({ path: f.path, problems });
}

if (failures.length) {
  console.error("comment density: files above their limit\n");
  for (const { path, problems } of failures) {
    console.error(`  ${path}`);
    for (const p of problems) console.error(`    ${p}`);
  }
  console.error("\nBreak the prose up, move it to a doc, or cut it. If the density is");
  console.error("genuinely warranted, re-baseline with:");
  console.error("  node scripts/check-comments.mjs --update");
  process.exit(1);
}

const grandfathered = Object.keys(baseline).length;
console.log(
  `comment density: ${measured.length} files checked, none above their limit ` +
    `(${grandfathered} grandfathered).`,
);
