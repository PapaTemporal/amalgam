#!/usr/bin/env node
/**
 * Agent session evaluation.
 *
 * The claim: the interface can run the work rather than describing what you
 * could type, and what it shows you is the conversation — what the agent said,
 * what it ran, what came back — not a wall of protocol.
 *
 * The protocol parsing is what this holds down, because it is the part most
 * likely to be wrong and the part a live test would exercise least reliably: a
 * real agent decides for itself which tools to call, so a test against one
 * cannot assert on tool pairing, or on a result arriving three events after
 * the call it belongs to, or on a line arriving split down the middle of a
 * JSON object. Recorded events can.
 *
 * Usage: node tests/session-eval.mjs
 */
const { feed, detachedSession, view, PERMISSION_MODES } = await import("../lib/session.mjs");

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("agent session eval  (recorded protocol, no agent)\n");

const line = (o) => `${JSON.stringify(o)}\n`;

const s = detachedSession({ cwd: "/tmp/project" });
s.turns.push({ role: "user", text: "Add a health endpoint", at: Date.now() });

// --- what the agent sends back ----------------------------------------------
feed(s, line({ type: "system", subtype: "init", session_id: "abc-123", tools: ["Read", "Edit", "Bash"] }));
check("the agent's own session id is captured", s.agentSessionId === "abc-123",
  `session ${s.agentSessionId}`);

feed(s, line({
  type: "assistant",
  message: { content: [
    { type: "text", text: "I'll look at how routes are declared first." },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/server.js" } },
  ] },
}));

check("prose and a tool call become separate turns",
  s.turns.length === 3 && s.turns[1].role === "assistant" && s.turns[2].role === "tool",
  s.turns.map((t) => t.role).join(" -> "));

check("a tool call is shown as what it is doing, not as JSON",
  s.turns[2].name === "Read" && s.turns[2].input === "src/server.js",
  `${s.turns[2].name} ${s.turns[2].input}`);

check("and starts out marked as running", s.turns[2].state === "running");

// A tool result comes back as a user message, and belongs to the call that
// asked rather than to a new turn of conversation.
feed(s, line({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export function createServer() {}" }] },
}));

check("a tool result attaches to its call rather than opening a turn",
  s.turns.length === 3 && s.turns[2].state === "done"
  && s.turns[2].result.includes("createServer"),
  `${s.turns.length} turns, call is ${s.turns[2].state}`);

// --- out-of-order and interleaved calls -------------------------------------
feed(s, line({
  type: "assistant",
  message: { content: [
    { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
    { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "health", path: "src" } },
  ] },
}));
// The second one answers first, which a naive "most recent call" pairing gets
// wrong and blames the wrong command for the failure.
feed(s, line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "no matches" }] } }));
feed(s, line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "1 failing", is_error: true }] } }));

const bash = s.turns.find((t) => t.id === "t2");
const grep = s.turns.find((t) => t.id === "t3");
check("results pair by id, not by arrival order",
  bash.result === "1 failing" && grep.result === "no matches",
  `Bash -> ${bash.result} | Grep -> ${grep.result}`);
check("a failed tool is marked failed and a successful one is not",
  bash.state === "failed" && grep.state === "done",
  `${bash.name}:${bash.state} ${grep.name}:${grep.state}`);
check("a shell call shows the command",
  bash.input === "npm test", bash.input);

// --- a line split across two chunks ------------------------------------------
// stdout arrives in whatever sizes the pipe feels like, which is regularly
// mid-object. Losing those events would drop turns silently.
const whole = line({ type: "assistant", message: { content: [{ type: "text", text: "Splitting is fine." }] } });
const cut = Math.floor(whole.length / 2);
feed(s, whole.slice(0, cut));
const midway = s.turns.length;
feed(s, whole.slice(cut));
check("an event split across two chunks is not lost",
  s.turns.length === midway + 1 && s.turns.at(-1).text === "Splitting is fine.",
  `held ${midway} turns until the rest arrived, then ${s.turns.length}`);

// --- garbage on the wire ------------------------------------------------------
const before = s.turns.length;
feed(s, "not json at all\n\n");
check("a line that is not protocol does not throw or invent a turn",
  s.turns.length === before, "kept in the raw log, where unparseable output belongs");
check("but it is kept, because that is the only honest answer when this misreads",
  s.raw.some((l) => l === "not json at all"));

// --- the end of a turn ---------------------------------------------------------
check("the session is busy while the agent is working", s.busy === true);
feed(s, line({ type: "result", subtype: "success", total_cost_usd: 0.0123 }));
check("a result hands control back to the user", s.busy === false, "busy -> false");
check("and reports what the turn cost", s.cost === 0.0123, `$${s.cost}`);

feed(s, line({ type: "result", subtype: "error_max_turns" }));
check("a turn that ended badly says so in the conversation",
  s.turns.at(-1).role === "notice" && /error_max_turns/.test(s.turns.at(-1).text),
  s.turns.at(-1).text);

// --- what a page receives -------------------------------------------------------
const v = view(s);
check("the view carries the conversation and a bounded raw log",
  Array.isArray(v.turns) && v.turns.length === s.turns.length && v.raw.length <= 400,
  `${v.turns.length} turns, ${v.raw.length} raw line(s)`);

check("permission modes are offered with what they permit, not as bare ids",
  PERMISSION_MODES.length === 3 && PERMISSION_MODES.every((m) => m.id && m.label && m.note.length > 20),
  PERMISSION_MODES.map((m) => m.id).join(", "));

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
process.exitCode = failed ? 1 : 0;
