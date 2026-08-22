#!/usr/bin/env node
/**
 * Session-start injection evaluation.
 *
 * What this hook prints is prepended to every session on the machine, which
 * makes it the one piece of text here that prompt caching can actually work
 * on. Caching matches exact prefixes, so the value of this block depends
 * entirely on its opening bytes being identical from session to session — one
 * interpolated count in the wrong place and every session on the machine pays
 * to re-read it.
 *
 * So: the static half must be byte-identical regardless of state, and anything
 * that varies must come after it. Cheap to assert, easy to break by accident,
 * and invisible when broken — which is the case for pinning it.
 *
 * Usage: node tests/hook-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(PKG, "hooks", "session-start.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-hook-"));

let failed = 0;
const ok = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

const runHook = (db) => spawnSync(process.execPath, [HOOK], {
  encoding: "utf8", input: "{}", env: { ...process.env, AMALGAM_DB: db },
}).stdout ?? "";

console.log("session-start injection eval\n");

// A store with nothing pending, and the same store with proposals waiting.
const quietDb = path.join(TMP, "quiet.db");
const busyDb = path.join(TMP, "busy.db");
const quiet = runHook(quietDb);

process.env.AMALGAM_DB = busyDb;
const { savePending } = await import("../lib/capture.mjs");
const { close } = await import("../lib/db.mjs");
savePending([
  { kind: "fact", content: "A proposal left over from an earlier session.", context: "eval" },
  { kind: "decision", content: "Another one, so the count is not one.", context: "eval" },
], "prior-session");
close();
const busy = runHook(busyDb);

ok("the hook prints something", quiet.length > 100 && busy.length > 100,
  `${quiet.length} and ${busy.length} characters`);

// The static half is everything up to the first varying line.
const sharedPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
};
const prefix = sharedPrefix(quiet, busy);

ok("differing state does not change the opening bytes",
  prefix.length > 500, `${prefix.length} identical leading characters`);
ok("the whole directive block is inside that prefix",
  prefix.includes("memory_recall") && prefix.includes("run_check") && prefix.includes("memory_save_fact"),
  "every instruction is cacheable");
ok("state appears only after the static block",
  /proposed by an earlier session/.test(busy.slice(prefix.length))
  && !/proposed by an earlier session/.test(prefix),
  busy.slice(prefix.length).trim().split("\n")[0]?.slice(0, 80));
ok("and the quiet session simply omits it",
  !/proposed by an earlier session/.test(quiet),
  "nothing is said when there is nothing to say");

// Running twice with identical state must be byte-identical, or nothing caches.
ok("two sessions with the same state get identical text",
  runHook(quietDb) === quiet, "no timestamps, no ordering wobble");

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
