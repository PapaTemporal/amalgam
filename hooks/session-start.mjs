#!/usr/bin/env node
/**
 * SessionStart hook — makes the offload stack automatic.
 *
 * Two jobs, both silent-failing so a session can never be blocked:
 *   1. Report anything worth reclaiming. Nothing needs starting: memory is a
 *      SQLite file, and the optional model loads on first use.
 *   2. Emit the offload directives on stdout, which Claude Code injects as
 *      session context. This is deterministic, unlike skill description
 *      matching, and it reaches every workflow — including BMAD's — without
 *      modifying any of their skill files.
 *
 * Output is deliberately terse: it is spent on every single session, and a
 * verbose reminder to save tokens would be self-defeating.
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

  // Cheap reclaim check: registry only, no disk scanning.
  let reclaimHint = "";
  try {
    const db = JSON.parse(fs.readFileSync(path.join(HOME, "streams.json"), "utf8"));
    const n = Object.values(db.streams ?? {}).filter((s) => s.evaluated || !fs.existsSync(s.path)).length;
    if (n > 0) reclaimHint = `\n- ${n} finished work stream(s) can be reclaimed: run \`amalgam stream gc\` (plan) then \`--yes\`.`;
  } catch {}

  const lines = [
    "[amalgam] Local offload stack is wired into this session via the MCP server \"amalgam\".",
    "Spend local compute, not context tokens. Services start themselves on first use; never substitute cloud services.",
    "- Task start: `memory_persona_read`, then `memory_recall` with a few keywords. Stored text is caveman-dense — read it as-is, do not expand unless showing the user.",
    "- In a repo with a built graph, prefer `graph_query` (explain/path/query) over reading many files.",
    "- Task end: `memory_save_fact` for each durable fact/decision (dense wording; keep names, paths, commands exact) and `memory_context_write` for project state.",
    "- Independent build-heavy work: isolate it with `amalgam stream new <name> --repo <repo>`; when the result has been judged, `amalgam stream done <name>` so its disk can be reclaimed.",
    "- This applies to all workflows in this session, BMAD skills included.",
    "- If the user opens without a specific task (\"what should I work on\", \"where did we leave off\"), run the `start` skill: it loads state and offers concrete choices instead of a blank prompt.",
  ];
  if (modelInstalled()) {
    lines.push("- Before reading a long file or verbose command output in full, use `digest` — the local model reduces it and only the digest enters your context.");
  }
  process.stdout.write(lines.join("\n") + reclaimHint + "\n");
} catch {
  // never block session start
}
process.exit(0);
