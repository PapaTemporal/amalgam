/**
 * Traceability: turning "we finished the stories" into "here is the proof".
 *
 * A pile of merged stories is not a finished application, and the difference
 * is evidence. The planning layer writes acceptance criteria, the build layer
 * writes code, the test layer produces results — and nothing joins them, so
 * "are we done?" is answered by reading a status column that somebody set by
 * hand.
 *
 * This joins them, from artifacts that already exist rather than a format
 * invented for the purpose. A BMAD spec already declares three things this
 * needs: its acceptance criteria, the files it expects to touch (Code Map),
 * and the commands that confirm it (Verification). Sprint status already
 * carries the story ids and their state. Work items already tie a story to a
 * branch, and the code graph already knows what a file contains.
 *
 * What it will NOT do is claim an acceptance criterion is met. Nothing here
 * understands English well enough to say that a passing command proves "given
 * an expired token, when the user submits, then they are asked to sign in
 * again". What it reports is narrower and true: whether a story declares how
 * it can be checked, whether that check passes, whether the files it promised
 * to touch exist, and which stories are marked done while resting on no
 * evidence at all. The last of those is the number worth watching.
 */
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", "graphify-out", ".venv"]);

/** Walk for markdown, shallow enough to stay quick on a large repo. */
function markdownFiles(root, { maxDepth = 5 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        found.push(path.join(dir, e.name));
      }
    }
  };
  walk(root, 0);
  return found;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Enough YAML for frontmatter written by a template. Not a YAML parser. */
function frontmatter(text) {
  const m = FRONTMATTER.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, "").replace(/\s*#.*$/, "");
  }
  return out;
}

/**
 * The body of one `## Section`, up to the next heading of the same level.
 *
 * Scanned line by line rather than matched with a regex: the obvious pattern
 * needs an "or end of input" terminator, and JavaScript has no \Z — it matches
 * a literal Z, so the expression fails silently on the last section of a file
 * and returns nothing at all. Which is exactly where acceptance criteria live.
 */
function section(text, heading) {
  const want = new RegExp(`^##\\s+${heading}\\s*$`, "i");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => want.test(l));
  if (start < 0) return "";
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

/** Bullets under a `**Label:**` line, to the next such label or a heading. */
function labelled(block, label) {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*\\*\\*${label}`, "i").test(l));
  if (start < 0) return "";
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\*\*\w/.test(lines[i]) || /^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

const bullets = (block) => block.split(/\r?\n/)
  .map((l) => /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(l)?.[1]?.trim())
  .filter(Boolean);

/**
 * Read one spec.
 *
 * Templates carry instructional placeholders (`COMMAND`, `FILE`) until a human
 * fills them in; a spec still wearing them has declared nothing, and counting
 * it as declared evidence would be the exact self-deception this is meant to
 * prevent.
 */
const PLACEHOLDER = /^[A-Z][A-Z_ /]*$|FILE|COMMAND|ACTION|RATIONALE|PRECONDITION|EXPECTED_RESULT|INPUT|OUTCOME/;

export function parseSpec(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  if (!/##\s+Tasks\s*&\s*Acceptance/i.test(text) && !/\*\*Acceptance Criteria:\*\*/i.test(text)) return null;

  const fm = frontmatter(text);
  const acceptance = section(text, "Tasks\\s*&\\s*Acceptance");

  const criteria = bullets(labelled(acceptance, "Acceptance Criteria")).filter((b) => !PLACEHOLDER.test(b));
  const commands = bullets(labelled(section(text, "Verification"), "Commands"))
    .map((b) => /`([^`]+)`/.exec(b)?.[1])
    .filter((c) => c && !PLACEHOLDER.test(c));
  const codeMap = bullets(section(text, "Code Map"))
    .map((b) => /`([^`]+)`/.exec(b)?.[1])
    .filter((f) => f && !PLACEHOLDER.test(f));

  return {
    file,
    id: path.basename(file).replace(/\.md$/, ""),
    title: fm.title ?? path.basename(file, ".md"),
    status: fm.status ?? "unknown",
    type: fm.type ?? "",
    criteria,
    commands,
    codeMap,
  };
}

/** Sprint status, for the story ids and states the planning layer tracks. */
export function parseSprintStatus(root) {
  for (const file of [...findFiles(root, "sprint-status.yaml"), ...findFiles(root, "sprint-status.yml")]) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    // Line-scanned for the same reason as section(): the block usually runs to
    // the end of the file, and a regex that has to express "or end of input"
    // is where the \Z trap lives.
    const stories = {};
    const lines = text.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      if (/^development_status:\s*$/.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      if (/^\S/.test(line)) break;                      // next top-level key
      const kv = /^\s+([\w.-]+)\s*:\s*([\w-]+)\s*$/.exec(line);
      if (kv) stories[kv[1]] = kv[2];
    }
    if (Object.keys(stories).length) return { file, stories };
  }
  return null;
}

function findFiles(root, name, maxDepth = 5) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.name === name) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

export function findSpecs(root) {
  return markdownFiles(root).map(parseSpec).filter(Boolean);
}

/**
 * Judge one story on the evidence available, and say which kind it is.
 *
 * The distinction that matters is between a story that cannot be checked and
 * one that has not been checked. The first is a planning failure and the
 * second is a scheduling one, and a report that blurs them lets both hide.
 */
export function assess(spec, { repo, sprintStatus = null, taskFor = null } = {}) {
  const declared = spec.commands.length > 0;
  const missingFiles = spec.codeMap.filter((f) => !fs.existsSync(path.join(repo, f)));
  const state = sprintStatus?.stories?.[spec.id] ?? spec.status;

  return {
    ...spec,
    state,
    declared,
    missingFiles,
    task: taskFor?.(spec) ?? null,
    // Set later by verify(); kept here so the shape is stable either way.
    verified: null,
  };
}

/**
 * Run each story's own verification commands.
 *
 * Only the commands the story itself declared: inventing a check for a story
 * that never specified one would manufacture exactly the false confidence this
 * exists to remove.
 */
export async function verify(assessed, { repo, check, timeoutMs }) {
  for (const story of assessed) {
    if (!story.declared) continue;
    const runs = [];
    for (const command of story.commands) {
      const r = await check(command, { cwd: repo, timeoutMs });
      runs.push({ command, code: r.code, failures: r.failures, lines: r.lines.slice(0, 8) });
    }
    story.verified = runs.every((r) => r.code === 0);
    story.runs = runs;
  }
  return assessed;
}

/**
 * The project-level answer.
 *
 * `unproven` leads because it is the number that decides whether a release is
 * real: stories called done, resting on nothing a machine can re-check.
 */
export function summarise(assessed) {
  const done = assessed.filter((s) => /done|review/i.test(s.state));
  return {
    stories: assessed.length,
    criteria: assessed.reduce((n, s) => n + s.criteria.length, 0),
    declared: assessed.filter((s) => s.declared).length,
    undeclared: assessed.filter((s) => !s.declared).map((s) => s.id),
    unproven: done.filter((s) => !s.declared).map((s) => s.id),
    failing: assessed.filter((s) => s.verified === false).map((s) => s.id),
    passing: assessed.filter((s) => s.verified === true).map((s) => s.id),
    drifted: assessed.filter((s) => s.missingFiles.length).map((s) => ({ id: s.id, missing: s.missingFiles })),
  };
}

export function render(assessed, summary, { verified = false } = {}) {
  if (!assessed.length) {
    return "No specs found. trace reads BMAD spec/story files — the ones with a `## Tasks & Acceptance` section.";
  }
  const lines = [`${summary.stories} stor(y/ies), ${summary.criteria} acceptance criteria`];

  for (const s of assessed) {
    const mark = s.verified === true ? "proven" : s.verified === false ? "FAILING"
      : s.declared ? "declared" : "no check";
    lines.push(`  ${mark.padEnd(9)} ${s.id}  [${s.state}]  ${s.criteria.length} AC`
      + `${s.commands.length ? `, ${s.commands.length} command(s)` : ""}`
      + `${s.missingFiles.length ? `, ${s.missingFiles.length} code-map file(s) missing` : ""}`);
    if (s.verified === false) {
      for (const r of (s.runs ?? []).filter((x) => x.code !== 0)) {
        lines.push(`            $ ${r.command} -> exit ${r.code}`);
        for (const l of r.lines) lines.push(`              ${l}`);
      }
    }
  }

  lines.push("");
  if (summary.unproven.length) {
    lines.push(`${summary.unproven.length} stor(y/ies) marked done or in review declare no way to check them: ${summary.unproven.join(", ")}`);
  }
  if (summary.drifted.length) {
    lines.push(`${summary.drifted.length} stor(y/ies) name files that no longer exist — the plan and the tree have diverged.`);
  }
  if (!verified && summary.declared) {
    lines.push(`${summary.declared} stor(y/ies) declare commands; run with --verify to execute them.`);
  }
  lines.push("Note: a passing command means the story's own check passed. It is not a proof that the acceptance criteria are met — no machine here reads English that well.");
  return lines.join("\n");
}
