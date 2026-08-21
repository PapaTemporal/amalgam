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
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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
  return db;
}

/**
 * FTS5 has its own query grammar and throws on stray punctuation, so build a
 * safe OR-of-terms query. OR keeps recall broad; `rank` still orders by BM25.
 */
export function ftsQuery(text) {
  const terms = String(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export function logUsage(tool, inChars, outChars) {
  try {
    open().prepare("INSERT INTO usage_log (tool, in_chars, out_chars) VALUES (?, ?, ?)")
      .run(tool, inChars | 0, outChars | 0);
  } catch {}
}
