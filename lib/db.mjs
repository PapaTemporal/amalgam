/**
 * Memory store: SQLite with FTS5 ranked search, via Node's built-in
 * `node:sqlite`. No dependency, no download, no daemon, no port.
 *
 * This replaced a portable PostgreSQL server. Postgres is a client-server
 * RDBMS; this workload is one local user, one writer, and a few hundred rows,
 * so the server bought nothing and cost a 307 MB download, an initdb/pg_ctl
 * lifecycle, a TCP port, and a subprocess bridge.
 *
 * Layering follows TencentDB-Agent-Memory: L0 raw log, L1 distilled facts,
 * L2 scenario documents, L3 persona.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// node:sqlite emits an ExperimentalWarning as it loads, which would prefix the
// output of every command and every MCP response. Suppress that one warning —
// anything else Node wants to say still gets through. The filter has to be
// installed before the module loads, and static imports are hoisted above all
// module code, so node:sqlite is imported dynamically here on purpose.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.warn(w.stack ?? `${w.name}: ${w.message}`);
});
const { DatabaseSync } = await import("node:sqlite");

export const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
export const DB_PATH = process.env.AMALGAM_DB ?? path.join(HOME, "data", "memory.db");

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS l1_facts (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'fact',
  content    TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '',
  priority   INTEGER NOT NULL DEFAULT 50,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
  content, context, content='l1_facts', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS l1_ai AFTER INSERT ON l1_facts BEGIN
  INSERT INTO l1_fts(rowid, content, context) VALUES (new.id, new.content, new.context);
END;
CREATE TRIGGER IF NOT EXISTS l1_ad AFTER DELETE ON l1_facts BEGIN
  INSERT INTO l1_fts(l1_fts, rowid, content, context) VALUES('delete', old.id, old.content, old.context);
END;
CREATE TRIGGER IF NOT EXISTS l1_au AFTER UPDATE ON l1_facts BEGIN
  INSERT INTO l1_fts(l1_fts, rowid, content, context) VALUES('delete', old.id, old.content, old.context);
  INSERT INTO l1_fts(rowid, content, context) VALUES (new.id, new.content, new.context);
END;

CREATE TABLE IF NOT EXISTS l2_scenarios (
  path       TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS l2_fts USING fts5(path, summary, content);

CREATE TABLE IF NOT EXISTS l0_log (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'default',
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(content, content='l0_log', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS l0_ai AFTER INSERT ON l0_log BEGIN
  INSERT INTO l0_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS l3_persona (
  id         INTEGER PRIMARY KEY,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Usage log. Records what each tool actually returned so the premise of this
-- project ("spend local compute, not frontier context") can be checked against
-- data instead of asserted. Only measured quantities are stored: no estimate
-- of a counterfactual that was never run.
CREATE TABLE IF NOT EXISTS usage_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  tool      TEXT NOT NULL,
  in_chars  INTEGER NOT NULL DEFAULT 0,
  out_chars INTEGER NOT NULL DEFAULT 0
);
`;

let db;
export function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  // Columns added after the first release arrive by migration rather than in
  // SCHEMA, so an existing store picks them up without a rebuild.
  migrate(db, "l1_facts", {
    embedding: "BLOB",
    // Which fact replaced this one. A memory that is merely wrong is worse
    // than no memory: recall would pay context for the mistake AND for the
    // correction, and may rank the mistake first. Superseded rows are kept
    // (history is occasionally the answer) but excluded from recall.
    superseded_by: "INTEGER",
    superseded_at: "TEXT",
    // Result of the last machine check of the claims inside this fact.
    // 'ok' | 'stale' | 'unknown' — see lib/verify.mjs.
    verify_state: "TEXT",
    verify_note: "TEXT",
    verified_at: "TEXT",
    // Which work item was in hand when this was learned. Lets a resumed task
    // recover what it already figured out instead of re-deriving it.
    task_id: "INTEGER",
  });
  migrate(db, "l2_scenarios", { embedding: "BLOB" });
  // What the same answer would have cost by the obvious route — the files a
  // packet replaced, the raw output a digest replaced. Recorded only where it
  // is a real measurement, so savings never become an estimate.
  migrate(db, "usage_log", { baseline_chars: "INTEGER" });
  return db;
}

function migrate(d, table, columns) {
  const have = new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [col, type] of Object.entries(columns)) {
    if (!have.has(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

/**
 * Release the file handle. Long-running processes never need this — the store
 * is meant to stay open — but a test that deletes its temporary database does,
 * because Windows refuses to remove a file that is still open.
 */
export function close() {
  try { db?.close(); } catch {}
  db = undefined;
}

// Ordinary English words carry no retrieval signal, but OR-ing them makes the
// keyword leg match nearly every row — which then outvotes correct semantic
// hits during fusion. Dropping them keeps this leg precise, which is its job:
// exact identifiers, paths, and commands. Meaning is the other leg's problem.
const STOPWORDS = new Set(("a an and are as at be but by can do does for from get got how i if in into is it its me my "
  + "no not of on or our so than that the their them then there these they this to us was we what when where which who "
  + "why will with would you your about after all also any because been before being between both did each few had has "
  + "have having here him his more most other over same should some such only very want wants like need needs use used "
  + "using make makes made way ways thing things happen happens").split(" "));

/**
 * FTS5 has its own query grammar and throws on stray punctuation, so build a
 * safe OR-of-terms query from the informative tokens only.
 */
export function ftsQuery(text) {
  const terms = (String(text).match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export function logUsage(tool, inChars, outChars, baselineChars = 0) {
  try {
    open().prepare("INSERT INTO usage_log (tool, in_chars, out_chars, baseline_chars) VALUES (?, ?, ?, ?)")
      .run(tool, inChars | 0, outChars | 0, baselineChars | 0);
  } catch {}
}
