/**
 * An agent session, driven from the interface.
 *
 * The point of the interface was never to be a second place to read numbers.
 * It was to run the work — planning workflows, stories, reviews — without
 * anybody having to keep a terminal open beside it. Until now it composed a
 * prompt and handed it over, which is half a tool: the agent's questions, its
 * tool calls and its answers all happened somewhere else.
 *
 * This runs the agent as a long-lived child process and puts the whole
 * conversation on screen. It is not a terminal emulator and deliberately not:
 * driving an interactive CLI properly needs a pseudo-terminal, and every
 * pseudo-terminal for Node is a native module — which would end the promise
 * that amalgam installs by copying files. The agent already speaks a
 * structured protocol for exactly this case, so that is what is spoken:
 * newline-delimited JSON in, newline-delimited JSON out, no TTY involved.
 *
 * What arrives is not a log. It is a list of turns — what the agent said,
 * which tools it ran and what they returned — which is the thing worth
 * showing. The raw lines are kept too, because when something goes wrong the
 * only honest answer is the output itself.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const WIN = process.platform === "win32";

/** Where the agent CLI is, or null. Asked once: PATH does not move. */
let agentPath;
export function agentCli() {
  if (agentPath !== undefined) return agentPath;
  const r = spawnSync(WIN ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true });
  const found = r.status === 0
    ? (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];
  // npm installs two entries under the same name: an extensionless shell
  // script for POSIX shells, and a .cmd shim for Windows. `where` lists the
  // shell script first, and CreateProcess cannot run it — so on Windows the
  // shim is what to launch, not simply whatever came back first.
  agentPath = WIN ? (realExecutable(found) ?? found[0] ?? null) : (found[0] ?? null);
  return agentPath;
}

/**
 * A path Windows can actually start.
 *
 * `where claude` lists an extensionless shell script first — for POSIX shells
 * — which CreateProcess cannot run at all, and a .cmd shim second, which it
 * can only run through a shell. Going through a shell means arguments are
 * concatenated rather than passed, which Node deprecates for good reason.
 *
 * The package ships a real executable, so the shim's own directory is worth
 * looking in before settling for either. No shell, no quoting, no argument
 * ever reassembled from a string.
 */
function realExecutable(found) {
  const exe = found.find((f) => /[.]exe$/i.test(f));
  if (exe) return exe;

  for (const shim of found) {
    const bundled = path.join(
      path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  return found.find((f) => /[.](cmd|bat)$/i.test(f)) ?? null;
}

/** Forget the cached lookup, for after an install. */
export const rescanAgent = () => { agentPath = undefined; };

/**
 * How much the agent may do without being asked.
 *
 * Named here rather than passed through as a string, because this is the one
 * setting in the interface with real consequences and it should be described
 * in the words of what it permits.
 */
export const PERMISSION_MODES = [
  {
    id: "read",
    label: "Read only",
    note: "Reads, searches and explains. Cannot write, edit or run a command — not by policy, by not having the tools.",
    // Taking the tools away rather than asking it not to use them.
    //
    // The agent's own plan mode looked like the answer and is a trap without a
    // terminal: exiting plan mode needs an approval there is no way to give,
    // so the agent reaches for a tool that is not there, flails, and — having
    // been told it may not change the project — writes its plan into its own
    // config directory instead. "Changes nothing on disk" was simply false.
    // A tool it does not have is a promise that holds.
    mode: "acceptEdits",
    // Monitor is on the list because the agent reached for it as a shell
    // substitute the moment Bash was gone. A read-only promise is only worth
    // what its last exit is worth.
    deny: ["Write", "Edit", "NotebookEdit", "Bash", "Monitor", "KillShell", "BashOutput"],
  },
  {
    id: "acceptEdits",
    label: "Edit files",
    note: "Writes and edits without asking each time. Shell commands still need permission.",
    mode: "acceptEdits",
    deny: [],
  },
  {
    id: "bypassPermissions",
    label: "Anything",
    note: "No prompts at all, including shell commands. Only for work you would let run unattended.",
    mode: "bypassPermissions",
    deny: [],
  },
];

export const permissionMode = (id) => PERMISSION_MODES.find((m) => m.id === id) ?? null;

const sessions = new Map();
let nextId = 1;

export const getSession = (id) => sessions.get(id);
export const listSessions = () => [...sessions.values()].map(summary);

/**
 * The agent refusing for want of a login, rather than failing at the work.
 *
 * It comes back as an ordinary assistant message, which would leave somebody
 * reading "OAuth session expired" in the middle of a conversation and no idea
 * that the fix is one command in a terminal. Worth telling apart.
 */
const NEEDS_SIGN_IN = /failed to authenticate|oauth (?:token|session)|not logged in|please run .?claude login|invalid api key|authentication_error/i;

const summary = (s) => ({
  id: s.id, cwd: s.cwd, title: s.title, state: s.state, needsSignIn: !!s.needsSignIn,
  model: s.model, permissionMode: s.permissionMode,
  agentSessionId: s.agentSessionId,
  startedAt: s.startedAt, turns: s.turns.length,
  cost: s.cost, error: s.error ?? null,
});

/** Everything a page needs to draw the conversation. */
export const view = (s) => ({
  ...summary(s),
  turns: s.turns,
  raw: s.raw.slice(-400),
  busy: s.busy,
});

function emit(s) {
  const payload = JSON.stringify(view(s));
  for (const res of s.listeners) {
    try { res.write(`data: ${payload}\n\n`); } catch { s.listeners.delete(res); }
  }
}

/** One user message, in the shape the agent reads on stdin. */
const userMessage = (text) => JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
}) + "\n";

/**
 * Start a session and send it a first message.
 *
 * The child stays alive between turns, which is the whole reason for the
 * streaming protocol: context, permissions and any half-finished plan survive
 * from one message to the next.
 */
export function startSession({ cwd, prompt, title = "Session", model = null, permissionMode: modeId = "acceptEdits" }) {
  const cli = agentCli();
  if (!cli) return { error: "no agent CLI on this machine" };
  const mode = permissionMode(modeId);
  if (!mode) return { error: `unknown permission mode: ${modeId}` };

  const id = String(nextId++);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    // Without this the stream carries only the final result, which would make
    // this a slower way of doing what the old copy-a-prompt flow already did.
    "--verbose",
    "--permission-mode", mode.mode,
    "--session-id", randomUUID(),
  ];
  if (mode.deny.length) args.push("--disallowedTools", ...mode.deny);
  if (model) args.push("--model", model);

  // A shell is only involved if all that could be found was a batch shim,
  // because passing arguments through a shell concatenates them instead of
  // passing them — and one of these arguments is a permission mode.
  const needsShell = WIN && /[.](cmd|bat)$/i.test(cli);
  const child = spawn(cli, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    shell: needsShell,
  });

  const s = {
    id, cwd, title, model, permissionMode: modeId,
    child,
    state: "running",
    busy: true,
    turns: [],
    raw: [],
    listeners: new Set(),
    startedAt: Date.now(),
    cost: null,
    agentSessionId: null,
    error: null,
    needsSignIn: false,
    buffer: "",
  };
  sessions.set(id, s);

  child.stdout.on("data", (chunk) => ingest(s, chunk));
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (NEEDS_SIGN_IN.test(line)) s.needsSignIn = true;
      s.raw.push(line);
    }
    emit(s);
  });
  child.on("error", (e) => {
    s.state = "failed";
    s.error = e.message;
    s.busy = false;
    emit(s);
  });
  child.on("close", (code) => {
    s.state = s.state === "failed" ? "failed" : code === 0 ? "ended" : "failed";
    if (code !== 0 && !s.error) s.error = `the agent exited with code ${code}`;
    s.busy = false;
    emit(s);
  });

  send(s, prompt);
  return { id, session: view(s) };
}

/** Send another message into a running session. */
export function send(s, text) {
  if (!s || s.state !== "running") return false;
  s.turns.push({ role: "user", text, at: Date.now() });
  s.busy = true;
  emit(s);
  try { s.child.stdin.write(userMessage(text)); } catch { return false; }
  return true;
}

/** Stop it. The child owns real work, so it is asked before it is killed. */
export function stopSession(s) {
  if (!s) return false;
  try { s.child.stdin.end(); } catch { /* already gone */ }
  setTimeout(() => { try { s.child.kill(); } catch { /* already gone */ } }, 1500);
  s.state = "ended";
  s.busy = false;
  emit(s);
  return true;
}

/** Forget a finished session. */
export function forgetSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.state === "running") stopSession(s);
  sessions.delete(id);
  return true;
}

// ------------------------------------------------------------------ parsing

/**
 * Feed protocol lines into a session shell.
 *
 * Exported so the parsing can be tested against recorded events without an
 * agent, a network or a child process — which is the half of this most likely
 * to be wrong and the half a live test would exercise least reliably.
 */
export function feed(s, text) { ingest(s, text); }

/** A session with no child behind it, for tests and for replaying a transcript. */
export function detachedSession({ cwd = process.cwd(), title = "Replay" } = {}) {
  return {
    id: "detached", cwd, title, model: null, permissionMode: "plan",
    child: null, state: "running", busy: true, turns: [], raw: [],
    listeners: new Set(), startedAt: Date.now(), cost: null,
    agentSessionId: null, error: null, needsSignIn: false, buffer: "",
  };
}

function ingest(s, chunk) {
  s.buffer += String(chunk);
  const lines = s.buffer.split(/\r?\n/);
  // The last piece may be half a line; it waits for the rest.
  s.buffer = lines.pop() ?? "";
  let changed = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    s.raw.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    try { changed = absorb(s, JSON.parse(line)) || changed; }
    catch { /* not JSON: kept in raw, which is where unparseable output belongs */ }
  }
  if (changed || lines.length) emit(s);
}

/** Turn one protocol event into something a person would want to read. */
function absorb(s, ev) {
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") {
        s.agentSessionId = ev.session_id ?? s.agentSessionId;
        s.tools = ev.tools ?? [];
      }
      return true;

    case "assistant": {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          if (NEEDS_SIGN_IN.test(block.text)) s.needsSignIn = true;
          s.turns.push({ role: "assistant", text: block.text, at: Date.now() });
        } else if (block.type === "tool_use") {
          s.turns.push({
            role: "tool", id: block.id, name: block.name,
            input: summariseInput(block.name, block.input),
            state: "running", at: Date.now(),
          });
        }
      }
      return true;
    }

    case "user": {
      // Tool results come back as a user message; they belong to the tool call
      // that asked, not to a new turn of conversation.
      for (const block of ev.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const call = [...s.turns].reverse().find((t) => t.role === "tool" && t.id === block.tool_use_id);
        if (!call) continue;
        call.state = block.is_error ? "failed" : "done";
        call.result = trim(textOf(block.content));
      }
      return true;
    }

    case "result":
      s.busy = false;
      s.cost = ev.total_cost_usd ?? s.cost;
      if (ev.subtype && ev.subtype !== "success") {
        s.turns.push({ role: "notice", text: `The agent stopped: ${ev.subtype}`, at: Date.now() });
      }
      return true;

    default:
      return false;
  }
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("\n");
  return "";
};

const trim = (text, max = 1200) =>
  text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text;

/**
 * What a tool call is doing, in one line.
 *
 * A raw tool input is a JSON blob; what somebody watching wants is "reading
 * src/api.js" or the command about to run. Anything not recognised falls back
 * to its own JSON rather than being hidden.
 */
function summariseInput(name, input = {}) {
  if (!input || typeof input !== "object") return String(input ?? "");
  const rel = (p) => (p ? String(p).split(path.sep).join("/") : "");
  switch (name) {
    case "Bash": return input.command ?? "";
    case "Read": case "Write": return rel(input.file_path);
    case "Edit": return rel(input.file_path);
    case "Glob": return input.pattern ?? "";
    case "Grep": return `${input.pattern ?? ""}${input.path ? ` in ${rel(input.path)}` : ""}`;
    case "Task": return input.description ?? "";
    case "Skill": return input.skill ?? "";
    default: {
      const s = JSON.stringify(input);
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    }
  }
}
