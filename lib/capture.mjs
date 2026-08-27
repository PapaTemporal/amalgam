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

/**
 * How alike two proposals have to be before the second one is not worth
 * anybody's attention.
 *
 * Chosen from this repository's own queue rather than picked out of the air.
 * Two sessions a day apart proposed the same four facts in different words;
 * every one of those had to be rejected by hand, which is the review effort
 * this exists to save. Measured on the pairs that were actually duplicates and
 * the pairs that merely discussed the same file, the separation is real but
 * thin — duplicates landed at 0.88 and above, related-but-distinct facts at
 * 0.875 and below. So the bar sits at the bottom of the first group, and it is
 * tunable, because one repository's margin is not a law.
 */
const DUPLICATE = Number(process.env.AMALGAM_DUPLICATE_AT ?? 0.88);

/** Same words, ignoring the things that are not words. */
const flatten = (text) =>
  String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Record proposals, minus the ones already said.
 *
 * A proposal repeated from a previous session is not new information, and a
 * proposal restating a fact already accepted is worse than nothing: it invites
 * somebody to store the same claim twice, after which recall returns both and
 * neither can be corrected without finding the other.
 *
 * Compared by meaning where an embedding model is installed, since the repeats
 * observed here were rewordings rather than copies, and by flattened text
 * otherwise — which catches less but needs nothing and cannot be wrong about
 * what it does catch.
 */
export async function savePending(proposals, sessionId, { embed = null, similarity = null } = {}) {
  if (!proposals.length) return { saved: 0, skipped: 0 };
  const db = d();

  const priorPending = db.prepare(
    `SELECT content FROM memory_pending WHERE state = 'pending'`).all().map((r) => r.content);
  const priorFacts = db.prepare(
    `SELECT content FROM l1_facts WHERE superseded_by IS NULL`).all().map((r) => r.content);
  const prior = [...priorPending, ...priorFacts];

  const seen = new Set(prior.map(flatten));
  let vectors = null;
  if (embed && similarity && prior.length) {
    try {
      // One call for everything being compared, so a large queue costs one
      // round trip rather than one per proposal.
      const all = await embed([...prior, ...proposals.map((p) => p.content)]);
      if (all) vectors = { prior: all.slice(0, prior.length), fresh: all.slice(prior.length) };
    } catch { /* fall back to text */ }
  }

  const stmt = db.prepare(
    `INSERT INTO memory_pending (session_id, kind, content, context) VALUES (?, ?, ?, ?)`);

  let saved = 0, skipped = 0;
  const keptVectors = [];
  proposals.forEach((p, i) => {
    const flat = flatten(p.content);
    if (seen.has(flat)) { skipped++; return; }

    if (vectors) {
      const v = vectors.fresh[i];
      const against = [...vectors.prior, ...keptVectors];
      if (against.some((o) => similarity(v, o) >= DUPLICATE)) { skipped++; return; }
      keptVectors.push(v);
    }

    stmt.run(sessionId, p.kind, p.content, p.context ?? "");
    seen.add(flat);
    saved++;
  });

  return { saved, skipped };
}

/**
 * Whether a session did enough to have learned anything worth keeping.
 *
 * Capture runs after every session, including the two-turn ones where somebody
 * asked what a function returns. Those produce confident little facts about
 * whatever file was open — five of them, in one observed case, all about a demo
 * fixture — and each one costs a human decision to reject. A session that asked
 * one question and got one answer did not make a durable decision, and the
 * cheapest way to keep the queue reviewable is to not put it there.
 */
export function worthCapturing(turns) {
  const MIN = Number(process.env.AMALGAM_CAPTURE_MIN_TURNS ?? 6);
  return Array.isArray(turns) && turns.length >= MIN;
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
export async function acceptPending(ids, { verifyFact, embed = null, toBlob = null, similarity = null, fromBlob = null } = {}) {
  const db = d();
  const get = db.prepare(`SELECT * FROM memory_pending WHERE id = ? AND state = 'pending'`);
  const insert = db.prepare(
    `INSERT INTO l1_facts (kind, content, context, priority, verify_state, verify_note, verified_at)
     VALUES (?, ?, ?, 50, ?, ?, datetime('now'))`);
  const setVec = db.prepare(`UPDATE l1_facts SET embedding = ? WHERE id = ?`);
  const mark = db.prepare(`UPDATE memory_pending SET state = 'accepted' WHERE id = ?`);
  const saved = [];

  for (const id of ids) {
    const row = get.get(Number(id));
    if (!row) continue;
    const v = verifyFact(row.content);
    const info = insert.run(row.kind, row.content, row.context, v.state, v.note);
    const factId = Number(info.lastInsertRowid);
    mark.run(row.id);

    // The same door as any other write. A proposal is likelier than most to
    // restate something already stored — it was distilled from a session that
    // was probably discussing what is already known — so accepting one without
    // this check is the fastest way to fill the store with four phrasings of
    // one fact. Reported rather than acted on, exactly as memory_save_fact
    // does: the store never decides on its own what replaces what.
    let near = [];
    if (embed && toBlob && similarity && fromBlob) {
      try {
        const [vec] = (await embed(`${row.content} ${row.context ?? ""}`)) ?? [];
        if (vec) {
          setVec.run(toBlob(vec), factId);
          for (const other of db.prepare(
            `SELECT id, content, embedding FROM l1_facts
              WHERE embedding IS NOT NULL AND superseded_by IS NULL AND id != ?`).all(factId)) {
            const score = similarity(vec, fromBlob(other.embedding));
            if (score >= 0.86) near.push({ id: other.id, score, content: other.content });
          }
          near.sort((a, b) => b.score - a.score);
          near = near.slice(0, 3);
        }
      } catch { /* an unembeddable fact is still a fact */ }
    }

    saved.push({ pending: row.id, fact: factId, state: v.state, near });
  }
  return saved;
}

/** Mark older facts as replaced. The CLI counterpart of memory_supersede. */
export function supersede(newId, oldIds) {
  const db = d();
  if (!db.prepare(`SELECT 1 FROM l1_facts WHERE id = ?`).get(Number(newId))) return -1;
  const stmt = db.prepare(
    `UPDATE l1_facts SET superseded_by = ?, superseded_at = datetime('now')
      WHERE id = ? AND id != ? AND superseded_by IS NULL`);
  let n = 0;
  for (const id of oldIds) n += Number(stmt.run(Number(newId), Number(id), Number(newId)).changes);
  return n;
}
