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
import path from "node:path";
import { randomUUID } from "node:crypto";

const WIN = process.platform === "win32";

/** Where the agent CLI is, or null. Asked once: PATH does not move. */
let agentPath;
export function agentCli() {
  if (agentPath !== undefined) return agentPath;
  const r = spawnSync(WIN ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true });
  agentPath = r.status === 0 ? (r.stdout ?? "").split(/\r?\n/)[0].trim() : null;
  return agentPath;
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
  { id: "plan", label: "Plan only",
    note: "Reads and thinks. Changes nothing on disk. The safe way to start on code you do not know." },
  { id: "acceptEdits", label: "Edit files",
    note: "Writes and edits without asking each time. Other tools still need permission." },
  { id: "bypassPermissions", label: "Anything",
    note: "No prompts at all, including shell commands. Only on work you would let run unattended." },
];

const sessions = new Map();
let nextId = 1;

export const getSession = (id) => sessions.get(id);
export const listSessions = () => [...sessions.values()].map(summary);

const summary = (s) => ({
  id: s.id, cwd: s.cwd, title: s.title, state: s.state,
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
export function startSession({ cwd, prompt, title = "Session", model = null, permissionMode = "acceptEdits" }) {
  const cli = agentCli();
  if (!cli) return { error: "no agent CLI on this machine" };

  const id = String(nextId++);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    // Without this the stream carries only the final result, which would make
    // this a slower way of doing what the old copy-a-prompt flow already did.
    "--verbose",
    "--permission-mode", permissionMode,
    "--session-id", randomUUID(),
  ];
  if (model) args.push("--model", model);

  const child = spawn(cli, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    // A .cmd shim on Windows is a batch file, which cannot be executed
    // directly by CreateProcess.
    shell: WIN && /\.(cmd|bat)$/i.test(cli),
  });

  const s = {
    id, cwd, title, model, permissionMode,
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
    buffer: "",
  };
  sessions.set(id, s);

  child.stdout.on("data", (chunk) => ingest(s, chunk));
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) s.raw.push(line);
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
    agentSessionId: null, error: null, buffer: "",
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
