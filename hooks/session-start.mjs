#!/usr/bin/env node
/**
 * SessionStart hook — makes the offload stack automatic.
 *
 * Three jobs, all silent-failing so a session can never be blocked:
 *   1. Report anything worth reclaiming. Nothing needs starting: memory is a
 *      SQLite file, and the optional model loads on first use.
 *   2. Reconcile with reality. A session ends by writing down what it learned
 *      and rebuilding what fell behind, which covers everything that session
 *      did and nothing that happened between sessions — a pull, a branch
 *      switch, another machine. So the opening of a session asks whether the
 *      graph is still at the commit it was built from and whether memory
 *      still names paths that exist. See lib/reconcile.mjs; it reports rather
 *      than repairs, because repair belongs where nobody is waiting.
 *   3. Emit the offload directives on stdout, which Claude Code injects as
 *      session context. This is deterministic, unlike skill description
 *      matching, and it reaches every workflow — including BMAD's — without
 *      modifying any of their skill files.
 *
 * Output is deliberately terse: it is spent on every single session, and a
 * verbose reminder to save tokens would be self-defeating.
 *
 * Order is load-bearing, not cosmetic. Everything injected here sits at the
 * front of the conversation, where prompt caching works on exact prefixes: as
 * long as the opening bytes are identical from session to session, they stay
 * cached, and only what changes is paid for. So the directives — which are the
 * same every time — come first and are never interpolated with anything, and
 * every varying part (pending proposals, reclaimable streams) is appended
 * afterwards. Moving a single session-dependent character into the block above
 * would invalidate the prefix for every session on the machine, which is why
 * tests/hook-eval.mjs asserts the static half is byte-identical under
 * different state.
 */
import fs from "node:fs";
import path from "node:path";

let HOME, modelInstalled;
try {
  ({ HOME, modelInstalled } = await import("../lib/services.mjs"));
} catch {
  process.exit(0); // runtime not installed here — stay quiet
}

try {
  if (!fs.existsSync(path.join(HOME, "mcp", "server.mjs"))) process.exit(0);
  // Nothing to start: memory is a SQLite file opened on demand, and the
  // optional model starts itself only when a tool actually needs it.

  // Facts the last session proposed and nobody has looked at yet. Surfaced
  // here because a proposal nobody sees is the same as no capture at all.
  let pendingHint = "";
  try {
    const { countPending } = await import("../lib/capture.mjs");
    const n = countPending();
    if (n > 0) pendingHint = `
- ${n} fact(s) proposed by an earlier session are waiting: review with \`amalgam memory pending\`, then accept or reject.`;
  } catch {}

  // Cheap reclaim check: registry only, no disk scanning.
  let reclaimHint = "";
  try {
    const db = JSON.parse(fs.readFileSync(path.join(HOME, "streams.json"), "utf8"));
    const n = Object.values(db.streams ?? {}).filter((s) => s.evaluated || !fs.existsSync(s.path)).length;
    if (n > 0) reclaimHint = `\n- ${n} finished work stream(s) can be reclaimed: run \`amalgam stream gc\` (plan) then \`--yes\`.`;
  } catch {}

  // What changed while nobody was looking. Costs two commit ids compared when
  // everything is current, which is nearly always, and only pays for the file
  // list when there is actually something to name.
  let driftHint = "";
  try {
    const { codeChanged, memoryDrifted, describe } = await import("../lib/reconcile.mjs");
    const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const said = describe({ code: codeChanged(cwd), memory: await memoryDrifted() });
    if (said.length) driftHint = "\n" + said.join("\n");
  } catch {}

  const lines = [
    "[amalgam] Local offload stack is wired into this session via the MCP server \"amalgam\".",
    "Spend local compute, not context tokens. Services start themselves on first use; never substitute cloud services.",
    "- Task start: `memory_persona_read`, then `memory_recall` with a few keywords. Stored text is caveman-dense — read it as-is, do not expand unless showing the user.",
    "- Before changing existing code, call `code_context` with the task: it returns the symbols that bear on it, their callers, and their current source — instead of whole files. `graph_impact` gives a diff's blast radius; `graph_query` answers structural questions.",
    "- Running a build, test suite, linter or type check: use `run_check` instead of running it yourself — it returns the exit code and the failures verbatim, and the output never enters your context.",
    "- Task end: `memory_save_fact` for each durable fact/decision (dense wording; keep names, paths, commands exact) and `memory_context_write` for project state. If a save reports it may replace an older fact, confirm with `memory_supersede` so recall stops returning both.",
    "- Independent build-heavy work: isolate it with `amalgam stream new <name> --repo <repo>`; when the result has been judged, `amalgam stream done <name>` so its disk can be reclaimed.",
    "- This applies to all workflows in this session, BMAD skills included.",
    "- If the user opens without a specific task (\"what should I work on\", \"where did we leave off\"), run the `start` skill: it loads state and offers concrete choices instead of a blank prompt.",
  ];
  if (modelInstalled()) {
    lines.push("- Before reading a long file or verbose command output in full, use `digest` — the local model reduces it and only the digest enters your context.");
  }
  // Static directives first, then everything that varies by session — see the
  // note at the top of this file about why the order is load-bearing.
  process.stdout.write(lines.join("\n") + pendingHint + reclaimHint + driftHint + "\n");
} catch {
  // never block session start
}
process.exit(0);
