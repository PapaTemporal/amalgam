#!/usr/bin/env node
/**
 * Work-item evaluation.
 *
 * What is being tested is the claim that resuming work is a lookup rather than
 * an investigation: that one call returns where the work lives, what was
 * decided, what broke, and what was learned — and that closing a task hides it
 * from the open list without destroying any of that history.
 *
 * Runs against a temporary database through AMALGAM_DB; real memory is never
 * opened.
 *
 * Usage: node tests/task-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-task-"));
process.env.AMALGAM_DB = path.join(TMP, "memory.db");

const { createTask, addEvent, setState, listTasks, resume, renderResume } = await import("../lib/tasks.mjs");
const { open, close } = await import("../lib/db.mjs");

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("work item eval  (temp db)\n");

const id = createTask({ title: "Rework session token validation", repo: "/srv/api-server", branch: "fix/token", story: "API-42" });
check("task opens with its coordinates", id === 1, `id=${id}`);

addEvent(id, "decision", "reject empty tokens at the edge rather than in each handler");
addEvent(id, "blocker", "integration suite needs a fixture user");
addEvent(id, "test", "unit 41/41, integration skipped");

// A fact learned while this task was in hand.
open().prepare(
  `INSERT INTO l1_facts (kind, content, context, task_id) VALUES ('fact', ?, 'api-server', ?)`
).run("Token validation lives in session.js; the edge check must run before routing.", id);

const r = resume(id);
check("resume returns the coordinates", r.task.branch === "fix/token" && r.task.story === "API-42",
  `${r.task.branch} / story ${r.task.story}`);
check("resume returns the history in order",
  r.events.map((e) => e.kind).join(",") === "state,decision,blocker,test",
  r.events.map((e) => e.kind).join(","));
check("resume returns what was learned",
  r.facts.length === 1 && r.facts[0].content.includes("session.js"),
  r.facts[0]?.content?.slice(0, 60));

const rendered = renderResume(r);
check("the rendering is readable in one block",
  rendered.includes("fix/token") && rendered.includes("blocker") && rendered.includes("learned:"),
  rendered.split("\n")[0]);

// A second, untouched task must not crowd the first one's answer.
createTask({ title: "Unrelated chore", repo: "/srv/web-client" });
check("listing can be scoped to one repo", listTasks({ repo: "/srv/api-server" }).length === 1,
  `${listTasks({ repo: "/srv/api-server" }).length} for api-server, ${listTasks({}).length} in total`);

setState(id, "done");
check("closing removes it from the open list", !listTasks({ state: "open" }).some((t) => t.id === id));
check("closing keeps its history", resume(id).events.length === 5,
  `${resume(id).events.length} events, last is "${resume(id).events.at(-1).detail}"`);

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
close(); // Windows will not delete a database that is still open
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
