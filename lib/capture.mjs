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

/**
 * Whether sessions record themselves at all.
 *
 * Automatic capture changes what this store is: it stops being the things
 * somebody chose to keep and becomes everything that was said. That is a
 * reasonable default for a local, single-user tool and an unreasonable one to
 * impose, so it is one environment variable away from off.
 */
export const captureEnabled = () => !/^(0|off|false|no)$/i.test(process.env.AMALGAM_CAPTURE ?? "on");

/** How long raw turns are kept, and how many at most. Both may be set to 0. */
export const RAW_DAYS = Number(process.env.AMALGAM_L0_DAYS ?? 30);
export const RAW_MAX_ROWS = Number(process.env.AMALGAM_L0_MAX_ROWS ?? 5000);

// Secrets have recognisable shapes. This catches the well-known ones and any
// assignment whose NAME announces a secret; it does not pretend to catch
// everything, because a redactor that claims completeness invites people to
// stop being careful. Deliberately no general high-entropy rule: it would eat
// commit hashes and file digests, and a store full of [redacted] is its own
// kind of useless.
const SECRET_PATTERNS = [
  [/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(sk-[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9-]{16,})\b/g, "[redacted api key]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted github token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted aws key id]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted slack token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted jwt]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "[redacted authorization]"],
  // The lookahead keeps this from re-redacting a value an earlier rule already
  // replaced, which produced output like `TOKEN=[redacted] github token]`.
  [/\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|CREDENTIAL|PRIVATE_KEY)[A-Za-z0-9_]*)\s*[:=]\s*["']?(?!\[redacted)([^\s"'`,;]{6,})/gi,
    (_m, name) => `${name}=[redacted]`],
  [/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted credentials]@"],
];

/** Strip well-known secret shapes out of text before it is stored. */
export function redact(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Apply retention to the raw layer.
 *
 * Raw turns are the one table here that grows without anybody deciding to add
 * anything, so it is the one that needs a limit. Older than the window, or
 * beyond the row cap, and the oldest go. Distilled facts are unaffected: the
 * point of distilling was to keep the part worth keeping.
 */
export function pruneRaw({ days = RAW_DAYS, maxRows = RAW_MAX_ROWS } = {}) {
  const db = d();
  let removed = 0;
  if (days > 0) {
    removed += Number(db.prepare(
      `DELETE FROM l0_log WHERE created_at < datetime('now', ?)`).run(`-${Math.floor(days)} days`).changes);
  }
  if (maxRows > 0) {
    removed += Number(db.prepare(
      `DELETE FROM l0_log WHERE id NOT IN (SELECT id FROM l0_log ORDER BY id DESC LIMIT ?)`).run(maxRows).changes);
  }
  return removed;
}

/**
 * Write the conversation to the raw layer: redacted on the way in, pruned on
 * the way out. No model, no judgement, no network.
 */
export function logTurns(turns, sessionId) {
  if (!turns.length || !captureEnabled()) return 0;
  const db = d();
  const stmt = db.prepare(`INSERT INTO l0_log (session_id, role, content) VALUES (?, ?, ?)`);
  for (const t of turns) stmt.run(sessionId, t.role, redact(t.text).slice(0, 4000));
  pruneRaw();
  return turns.length;
}

/** Forget raw turns: one session's, or all of them. Distilled facts stay. */
export function forgetRaw({ session = null } = {}) {
  const db = d();
  return Number(session
    ? db.prepare(`DELETE FROM l0_log WHERE session_id = ?`).run(session).changes
    : db.prepare(`DELETE FROM l0_log`).run().changes);
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
  if (!modelInstalled() || !turns.length || !captureEnabled()) return [];
  // Redacted here as well as at storage: the model is local, but a secret it
  // reads can come back out inside a proposal, and proposals are meant to be
  // promoted into memory.
  const text = turns.map((t) => `${t.role.toUpperCase()}: ${redact(t.text)}`).join("\n\n").slice(-24000);
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
