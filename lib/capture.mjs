/**
 * Capturing what a session learned, without relying on anyone remembering to.
 *
 * Memory only pays for itself if things actually get written to it, and the
 * current design asks the agent to do that at the end of a session — which is
 * exactly when its context is most exhausted and its attention is on finishing.
 * Predictably, the raw layer stayed empty for weeks while facts were saved by
 * hand or not at all.
 *
 * So the session end writes its own record. Two tiers, because one of them
 * must work on a machine that took no model download:
 *
 *   always — the conversation's own turns are logged to L0, which costs
 *            nothing and gives recall something real to search;
 *   with a local model — that transcript is distilled into candidate facts.
 *
 * Candidates are PROPOSALS, never memories. Writing unattended model output
 * straight into long-term memory would poison the store that everything else
 * here depends on: a wrong fact recalled with confidence is the single most
 * expensive failure this project has. They wait in a pending table until a
 * person or an agent accepts them, and the next session is told they exist.
 */
import fs from "node:fs";
import { open } from "./db.mjs";
import { modelInstalled } from "./services.mjs";
import { llama } from "./llm.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_pending (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'fact',
  content    TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'session-end',
  state      TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function d() {
  const db = open();
  db.exec(SCHEMA);
  return db;
}

/**
 * Read a Claude Code transcript into plain turns.
 *
 * Tolerant on purpose: the file is somebody else's format and may change, so
 * anything unrecognised is skipped rather than throwing. Tool calls and their
 * results are dropped — they are the bulkiest part of a session and the least
 * durable, since what matters later is what was decided, not which files were
 * opened on the way.
 */
export function readTranscript(file, { maxChars = 60000 } = {}) {
  if (!file || !fs.existsSync(file)) return [];
  const turns = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const msg = row.message ?? row;
    const role = msg.role ?? row.type;
    if (role !== "user" && role !== "assistant") continue;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
    }
    text = text.trim();
    if (!text || text.startsWith("<")) continue;
    turns.push({ role, text });
  }
  // Keep the end of a long session: the conclusions live there, and the
  // opening is usually orientation that leads to them.
  let total = 0;
  const kept = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turns[i].text.length;
    if (total > maxChars) break;
    kept.unshift(turns[i]);
  }
  return kept;
}

/** Write the conversation to the raw layer. No model, no judgement, no cost. */
export function logTurns(turns, sessionId) {
  if (!turns.length) return 0;
  const db = d();
  const stmt = db.prepare(`INSERT INTO l0_log (session_id, role, content) VALUES (?, ?, ?)`);
  for (const t of turns) stmt.run(sessionId, t.role, t.text.slice(0, 4000));
  return turns.length;
}

const DISTIL_SYS =
  "You read a transcript of a working session between a developer and a coding agent, and extract only " +
  "DURABLE facts: decisions taken and why, constraints, conventions, gotchas discovered, and where things live. " +
  "Ignore anything that stops being true when the session ends — progress updates, what is being worked on right now, " +
  "pleasantries, and restatements of the task. Write each on its own line, dense and telegraphic, dropping articles " +
  "and filler while keeping every name, path, command and number exact. " +
  "At most 4 lines, and no two lines may say the same thing in different words — one line per distinct thing learned. " +
  "Prefer fewer, denser lines over more. " +
  "Prefix each with one of: fact:, decision:, constraint:, preference:. If the session established nothing durable, reply with NONE.";

/**
 * Distil a session into candidate facts.
 *
 * The prompt asks for what stays true, because the failure mode of automatic
 * capture is a store full of "currently refactoring the parser" — sentences
 * that were accurate for an hour and misleading thereafter.
 */
export async function proposeFacts(turns, { context = "" } = {}) {
  if (!modelInstalled() || !turns.length) return [];
  const text = turns.map((t) => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n").slice(-24000);
  let out;
  try { out = await llama(DISTIL_SYS, text, 700); } catch { return []; }
  if (/^\s*NONE\b/i.test(out)) return [];
  const kinds = ["fact", "decision", "constraint", "preference"];
  return out.split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*\d.\s]+/, ""))
    .filter((l) => l.length > 15)
    .map((l) => {
      const m = /^(fact|decision|constraint|preference)\s*:\s*(.+)$/i.exec(l);
      return m ? { kind: m[1].toLowerCase(), content: m[2].trim(), context }
        : { kind: "fact", content: l, context };
    })
    .filter((p) => kinds.includes(p.kind) && p.content.length > 15)
    .slice(0, 4);
}

export function savePending(proposals, sessionId) {
  if (!proposals.length) return 0;
  const db = d();
  const stmt = db.prepare(
    `INSERT INTO memory_pending (session_id, kind, content, context) VALUES (?, ?, ?, ?)`);
  for (const p of proposals) stmt.run(sessionId, p.kind, p.content, p.context ?? "");
  return proposals.length;
}

export function listPending(limit = 20) {
  return d().prepare(
    `SELECT id, kind, content, context, created_at FROM memory_pending
      WHERE state = 'pending' ORDER BY id LIMIT ?`).all(limit);
}

export function countPending() {
  return d().prepare(`SELECT count(*) AS n FROM memory_pending WHERE state = 'pending'`).get().n;
}

export function rejectPending(ids) {
  const stmt = d().prepare(`UPDATE memory_pending SET state = 'rejected' WHERE id = ? AND state = 'pending'`);
  let n = 0;
  for (const id of ids) n += Number(stmt.run(Number(id)).changes);
  return n;
}

/**
 * Accept proposals into long-term memory.
 *
 * They go in through the same door as anything else — verified as they are
 * written, so a proposal that names a path which does not exist is flagged
 * from its first day rather than believed.
 */
export function acceptPending(ids, { verifyFact }) {
  const db = d();
  const get = db.prepare(`SELECT * FROM memory_pending WHERE id = ? AND state = 'pending'`);
  const insert = db.prepare(
    `INSERT INTO l1_facts (kind, content, context, priority, verify_state, verify_note, verified_at)
     VALUES (?, ?, ?, 50, ?, ?, datetime('now'))`);
  const mark = db.prepare(`UPDATE memory_pending SET state = 'accepted' WHERE id = ?`);
  const saved = [];
  for (const id of ids) {
    const row = get.get(Number(id));
    if (!row) continue;
    const v = verifyFact(row.content);
    const info = insert.run(row.kind, row.content, row.context, v.state, v.note);
    mark.run(row.id);
    saved.push({ pending: row.id, fact: Number(info.lastInsertRowid), state: v.state });
  }
  return saved;
}
