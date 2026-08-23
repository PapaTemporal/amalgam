/**
 * Turning a button into a session.
 *
 * A button that says "New feature" has to become something an agent can act
 * on, and the honest version of that is a prompt — not a hidden instruction,
 * not a magic mode. So every flow here composes a prompt the user can read
 * before it runs, and can copy and paste if they would rather drive it
 * themselves. That is deliberately the same thing BMAD does today; what
 * changes is that the context is already gathered.
 *
 * Three ways to start it, in descending order of how much the machine can do
 * for you:
 *
 *   headless   an agent CLI is on PATH, so run it and stream the result;
 *   terminal   open a session with the prompt already in place;
 *   clipboard  hand over the text.
 *
 * The last one always works, which is why it is the floor rather than the
 * failure case. A machine with no agent CLI is not a broken installation.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { open as openDb } from "./db.mjs";
import { listTasks } from "./tasks.mjs";
import { detectChecks } from "./gates.mjs";
import { findSpecs, parseSprintStatus, assess } from "./trace.mjs";
import { isIndexed } from "./graphdb.mjs";

/** The few facts most likely to matter, newest first. */
function recentFacts(limit = 6) {
  try {
    return openDb().prepare(
      `SELECT id, kind, context, content FROM l1_facts
        WHERE superseded_by IS NULL AND verify_state IS NOT 'stale'
        ORDER BY priority DESC, id DESC LIMIT ?`).all(limit);
  } catch { return []; }
}

/**
 * What every flow should know before it starts.
 *
 * Assembled here rather than left to the agent because it is the same six
 * lookups every time, and paying a frontier model to rediscover them at the
 * start of each task is precisely the waste this project exists to remove.
 */
function projectContext(repo) {
  const checks = detectChecks(repo);
  const specs = findSpecs(repo).map((s) => assess(s, { repo, sprintStatus: parseSprintStatus(repo) }));
  const open = listTasks({ repo, state: "open", limit: 5 });
  const lines = [];

  lines.push(`Project: ${repo}`);
  if (isIndexed(repo)) lines.push(`A code graph is indexed — use code_context before reading files.`);
  else lines.push(`No code graph yet. Run 'amalgam graph' if you need to understand existing code.`);
  if (checks.length) lines.push(`Checks: ${checks.map((c) => c.command).join(" ; ")} — run them with run_gate, not by hand.`);
  else lines.push(`This project declares no checks. Say so before claiming anything works.`);

  if (open.length) {
    lines.push(`Open work items:`);
    for (const t of open) lines.push(`  - task ${t.id}: ${t.title}${t.story ? ` (story ${t.story})` : ""}`);
  }
  const ready = specs.filter((s) => /ready|progress|backlog/i.test(s.state));
  if (ready.length) {
    lines.push(`Stories not yet done:`);
    for (const s of ready.slice(0, 8)) lines.push(`  - ${s.id}: ${s.title} [${s.state}]`);
  }
  const facts = recentFacts();
  if (facts.length) {
    lines.push(`Known already (from memory — do not re-derive):`);
    for (const f of facts) lines.push(`  - ${f.content.slice(0, 180)}`);
  }
  return lines.join("\n");
}

const FLOWS = {
  feature: {
    title: "New feature",
    explain: "The full path: frame the problem, agree the shape, cut it into stories with a way to check each one, then build the first.",
    body: (ctx) => `I want to add a new feature to this project.

${ctx}

Work through it properly rather than jumping to code:
1. Ask me what the feature is and what problem it solves. Push back if the answer is vague.
2. Use the BMAD planning workflow to produce a spec — run the /bmad-spec skill.
3. Make sure every story you write declares a verification command, so 'amalgam trace' can
   prove it later. A story with no way to check it cannot be shown to work.
4. Then build the first story with /bmad-build, in a work stream if it is build-heavy.
5. Run run_gate before you ask me to review anything.

Start by asking me about the feature.`,
  },

  story: {
    title: "Continue a story",
    explain: "For work that is already specified: pick up an existing story and implement it.",
    body: (ctx) => `I want to implement an existing story in this project.

${ctx}

1. Show me the stories that are ready and let me pick one — or take the one I name.
2. Open a work item with task_start so the decisions are recorded against it.
3. Read the spec, then use code_context to find the code it touches. Do not read whole files.
4. Implement it, then run_gate. Fix what the gate finds before showing me anything.
5. Tell me what you changed and what the checks said.`,
  },

  fix: {
    title: "Fix a bug",
    explain: "Reproduce first, understand the blast radius, then change as little as possible.",
    body: (ctx) => `There is a bug in this project.

${ctx}

1. Ask me for the symptom and how to reproduce it.
2. Write a failing check first if you can — run_check will show only what failed.
3. Use code_context to find the code involved, and graph_impact once you have a change,
   so we both know what else depends on it.
4. Make the smallest change that fixes it, then run_gate.
5. Save what you learned with memory_save_fact — the cause, not the symptom.`,
  },

  explore: {
    title: "Understand this code",
    explain: "For a codebase nobody here wrote: what it does, what is risky, and where to start.",
    body: (ctx) => `I need to understand this codebase before changing anything.

${ctx}

1. Run survey_repo and tell me what it says: the riskiest files, which of them no test
   reaches, and any files that keep changing together despite living apart.
2. Use code_context to explain the two or three most important entry points. Do not read
   the whole tree.
3. Tell me the safest place to make a first change, and why.
4. Save the durable parts with memory_save_fact so the next session starts from here.

Do not propose changes yet.`,
  },
};

export function compose(repo, kind) {
  const flow = FLOWS[kind];
  if (!flow) return null;
  return {
    id: kind,
    title: flow.title,
    explain: flow.explain,
    prompt: flow.body(projectContext(repo)),
  };
}

/**
 * Start a session with the prompt in place.
 *
 * Opening a terminal is preferred over running headless even when a CLI
 * exists: these flows are conversations — the feature flow's first instruction
 * is to ask the user a question — and a headless run would answer it on their
 * behalf.
 */
export function launch(repo, prompt, { agent = null } = {}) {
  const promptFile = path.join(repo, ".amalgam-prompt.txt");
  fs.writeFileSync(promptFile, prompt);

  if (!agent) return { started: false, promptFile, reason: "no agent CLI found on PATH" };

  const quoted = JSON.stringify(prompt);
  const cmd = process.platform === "win32"
    ? `start "amalgam" cmd /k ${agent.id} ${quoted}`
    : process.platform === "darwin"
      ? `osascript -e 'tell app "Terminal" to do script "cd ${repo} && ${agent.id} ${quoted}"'`
      : `x-terminal-emulator -e ${agent.id} ${quoted}`;

  try {
    spawn(cmd, { cwd: repo, shell: true, detached: true, stdio: "ignore" }).unref();
    return { started: true, promptFile, agent: agent.label };
  } catch (e) {
    return { started: false, promptFile, reason: e.message };
  }
}
