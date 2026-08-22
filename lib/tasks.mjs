/**
 * Work items: the thread that ties everything else together.
 *
 * The pieces of this stack each know one thing and none of them know each
 * other. BMAD holds the story, git holds the branch, a work stream holds the
 * worktree, memory holds the facts, the test run holds the verdict. Resuming
 * yesterday's work therefore means rediscovering all five, which is a research
 * task performed at frontier-model prices, every single time.
 *
 * A task is deliberately thin: it does not plan, schedule, or replace a story.
 * It only records which story, which branch, which stream, and what happened,
 * so that "where was I" is a lookup instead of an investigation. Everything it
 * points at remains owned by whatever owned it before.
 *
 * Events are append-only. A task's history is usually more useful than its
 * current state, because the question being asked is almost always "what did I
 * already try".
 */
import { open } from "./db.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  repo       TEXT NOT NULL DEFAULT '',
  branch     TEXT NOT NULL DEFAULT '',
  stream     TEXT NOT NULL DEFAULT '',
  story      TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_events (
  id      INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  kind    TEXT NOT NULL DEFAULT 'note',
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, at);
`;

export const KINDS = ["note", "decision", "blocker", "test", "commit", "state"];

function d() {
  const db = open();
  db.exec(SCHEMA);
  return db;
}

export function createTask({ title, repo = "", branch = "", stream = "", story = "" }) {
  const db = d();
  const info = db.prepare(
    `INSERT INTO tasks (title, repo, branch, stream, story) VALUES (?, ?, ?, ?, ?)`
  ).run(title, repo, branch, stream, story);
  const id = Number(info.lastInsertRowid);
  addEvent(id, "state", "opened");
  return id;
}

export function addEvent(taskId, kind, detail) {
  const db = d();
  db.prepare(`INSERT INTO task_events (task_id, kind, detail) VALUES (?, ?, ?)`)
    .run(Number(taskId), KINDS.includes(kind) ? kind : "note", String(detail ?? ""));
  db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(Number(taskId));
}

export function setState(taskId, state) {
  d().prepare(`UPDATE tasks SET state = ?, updated_at = datetime('now') WHERE id = ?`).run(state, Number(taskId));
  addEvent(taskId, "state", state);
}

export function listTasks({ repo = "", state = "open", limit = 20 } = {}) {
  const db = d();
  const where = [];
  const params = [];
  if (state && state !== "all") { where.push("state = ?"); params.push(state); }
  if (repo) { where.push("repo = ?"); params.push(repo); }
  return db.prepare(
    `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
}

export function getTask(id) {
  return d().prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(id)) ?? null;
}

export function events(taskId, limit = 20) {
  return d().prepare(
    `SELECT kind, at, detail FROM task_events WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
    .all(Number(taskId), limit).reverse();
}

/** Facts saved while this task was the one in hand. */
export function taskFacts(taskId, limit = 10) {
  return d().prepare(
    `SELECT id, kind, content FROM l1_facts
      WHERE task_id = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT ?`)
    .all(Number(taskId), limit).reverse();
}

/**
 * Everything needed to pick a task back up, in one read.
 *
 * Ordered oldest-first because it is meant to be read as a narrative: what was
 * decided, what broke, what was tried. The most recent line is the cursor.
 */
export function resume(id) {
  const t = getTask(id);
  if (!t) return null;
  return { task: t, events: events(id), facts: taskFacts(id) };
}

export function renderResume(r) {
  if (!r) return "No such task.";
  const t = r.task;
  const head = [`task ${t.id} [${t.state}] ${t.title}`];
  const where = [t.repo && `repo ${t.repo}`, t.branch && `branch ${t.branch}`,
    t.stream && `stream ${t.stream}`, t.story && `story ${t.story}`].filter(Boolean);
  if (where.length) head.push(`  ${where.join(" | ")}`);
  for (const e of r.events) head.push(`  ${e.at}  ${e.kind.padEnd(8)} ${e.detail}`);
  for (const f of r.facts) head.push(`  learned: [L1:${f.id}] ${f.content}`);
  return head.join("\n");
}
