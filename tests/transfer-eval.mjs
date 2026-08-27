#!/usr/bin/env node
/**
 * Carrying a machine's memory to another machine.
 *
 * `amalgam update` moves code and nothing else, so a second machine has always
 * started with no facts, no persona and no project list. The advice was to copy
 * a SQLite file across, which works — and hides two things worth being careful
 * about.
 *
 * The first is what is IN that file. The code index shares it: on the machine
 * this was written for, 97,918 symbols and 206,151 edges with their vectors,
 * which turned an 848 KB bundle into 349 MB of something entirely derived from
 * repositories that are not on the other machine anyway.
 *
 * The second is what happens when the other machine is not empty. Copying the
 * file over deletes whatever was already there, so a machine with facts of its
 * own gets a merge instead, and the things a merge cannot honestly carry — the
 * review queue, the raw log, the supersede chains whose ids do not exist on the
 * far side — are named rather than quietly dropped.
 *
 * Usage: node tests/transfer-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-transfer-"));
const A = path.join(TMP, "machine-a");
const B = path.join(TMP, "machine-b");
const BUNDLE = path.join(TMP, "bundle");
fs.mkdirSync(path.join(A, "data"), { recursive: true });
fs.mkdirSync(path.join(B, "data"), { recursive: true });

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("carrying a machine to another machine\n");

/** Run something with AMALGAM_HOME pointed at one of the fake machines. */
async function on(home, fn) {
  const saved = process.env.AMALGAM_HOME;
  const savedDb = process.env.AMALGAM_DB;
  process.env.AMALGAM_HOME = home;
  process.env.AMALGAM_DB = path.join(home, "data", "memory.db");
  try {
    // Re-imported per call so each picks up the redirected home.
    const stamp = Date.now() + Math.random();
    return await fn({
      transfer: await import(`../lib/transfer.mjs?t=${stamp}`),
      db: await import(`../lib/db.mjs?t=${stamp}`),
    });
  } finally {
    if (saved === undefined) delete process.env.AMALGAM_HOME; else process.env.AMALGAM_HOME = saved;
    if (savedDb === undefined) delete process.env.AMALGAM_DB; else process.env.AMALGAM_DB = savedDb;
  }
}

// --- machine A: some memory, and a large derived index ----------------------
await on(A, async ({ db }) => {
  const d = db.open();
  d.prepare(`INSERT INTO l1_facts (kind, content, context) VALUES ('decision', ?, 'amalgam')`)
    .run("Build timings are recorded per machine, because machines differ.");
  d.prepare(`INSERT INTO l1_facts (kind, content, context) VALUES ('constraint', ?, 'amalgam')`)
    .run("Everything local: the only network call is the frontier model.");
  d.prepare(`INSERT INTO l3_persona (id, content) VALUES (1, ?)`).run("Terse. Show the measurement.");
  db.close();

  // The pending table is created by the capture module rather than the base
  // schema, so it is reached through the module that owns it.
  const capture = await import(`../lib/capture.mjs?t=${Date.now()}`);
  await capture.savePending([{ kind: "fact", content: "A proposal nobody has looked at yet.", context: "" }], "s");
  const d2 = db.open();

  d2.prepare(`INSERT INTO usage_log (tool, in_chars, out_chars, baseline_chars) VALUES ('code_context', 10, 20, 9999)`).run();
  db.close();

  // The derived half, which must not travel. Its tables belong to the graph
  // index, so they are created by importing the module that owns them.
  const graphdb = await import(`../lib/graphdb.mjs?t=${Date.now()}`);
  graphdb.indexStatus("anything");   // first use is what applies its schema
  const d3 = db.open();
  d3.prepare(`INSERT INTO graph_repos (repo, symbols, edges) VALUES ('r', 500, 1)`).run();
  const sym = d3.prepare(
    `INSERT INTO symbols (repo, node_id, name, label, file, line, callable) VALUES ('r', ?, ?, ?, 'a.js', 1, 1)`);
  for (let i = 0; i < 500; i++) sym.run(`n${i}`, `sym${i}`, `sym${i}()`);
  db.close();
});

fs.writeFileSync(path.join(A, "ui.json"), JSON.stringify({ projects: [A, path.join(TMP, "nowhere")] }));
fs.writeFileSync(path.join(A, "models.json"), JSON.stringify({ enabled: true, tiers: { light: "claude-haiku-4-5" } }));

// --- export ------------------------------------------------------------------
await on(A, async ({ transfer }) => {
  const carried = await transfer.exportBundle(BUNDLE);
  check("the bundle names what it holds", carried.length >= 3,
    carried.map((c) => c.file).join(", "));
  check("and carries a manifest, so an import can recognise it",
    fs.existsSync(path.join(BUNDLE, "amalgam-transfer.json")));
});

await on(B, async ({ db }) => {
  // Read the bundle's database by pointing a fresh handle at it.
  process.env.AMALGAM_DB = path.join(BUNDLE, "memory.db");
  const fresh = await import(`../lib/db.mjs?bundle=${Date.now()}`);
  const d = fresh.open();
  check("memory travelled", d.prepare(`SELECT count(*) n FROM l1_facts`).get().n === 2);
  check("so did the persona and the review queue",
    d.prepare(`SELECT count(*) n FROM l3_persona`).get().n === 1 &&
    d.prepare(`SELECT count(*) n FROM memory_pending`).get().n === 1);

  // The point of the whole exercise.
  const symbols = d.prepare(`SELECT count(*) n FROM symbols`).get().n;
  check("the code index did not", symbols === 0,
    `${symbols} symbol(s) — it is derived from repositories that are not on the far machine`);
  check("nor did this machine's own measurements",
    d.prepare(`SELECT count(*) n FROM usage_log`).get().n === 0,
    "they would be reported as somebody else's savings");
  fresh.close();
});

// --- import onto an empty machine -------------------------------------------
await on(B, async ({ transfer, db }) => {
  const r = await transfer.importFrom(BUNDLE);
  check("an empty machine takes the bundle", !r.error, r.error ?? r.done.join(" | "));
  check("and takes memory whole, keeping supersede history",
    r.done.some((l) => /taken whole/.test(l)), r.done.find((l) => l.startsWith("memory")));

  const d = db.open();
  check("the facts are there", d.prepare(`SELECT count(*) n FROM l1_facts`).get().n === 2);
  db.close();

  const projects = JSON.parse(fs.readFileSync(path.join(B, "ui.json"), "utf8")).projects;
  check("a project whose folder is not on this machine is not adopted",
    projects.length === 1 && projects[0] === A,
    `${projects.length} project(s) — a path from elsewhere is usually just a path`);
});

// --- import onto a machine that already has its own --------------------------
await on(B, async ({ transfer, db }) => {
  const d = db.open();
  d.prepare(`INSERT INTO l1_facts (kind, content, context) VALUES ('fact', ?, 'local')`)
    .run("This one is the laptop, not the desktop.");
  db.close();

  const r = await transfer.importFrom(BUNDLE);
  check("a machine with facts of its own merges instead of replacing",
    r.done.some((l) => /merged/.test(l)), r.done.find((l) => l.startsWith("memory")));

  const d2 = db.open();
  check("nothing already known is added twice",
    d2.prepare(`SELECT count(*) n FROM l1_facts`).get().n === 3,
    "two from the bundle, one of its own");
  check("and the machine's own fact survives",
    !!d2.prepare(`SELECT 1 FROM l1_facts WHERE content LIKE '%laptop%'`).get(),
    "importing must never delete what was already here");
  db.close();

  check("what a merge cannot carry is said, not dropped quietly",
    r.done.some((l) => /queue and raw log stayed behind/.test(l)));
});

// --- refusing what is not a bundle ------------------------------------------
await on(B, async ({ transfer }) => {
  const r = await transfer.importFrom(TMP);
  check("a folder that is not a bundle is refused", !!r.error, r.error);
});

// --- what a Copilot user is told --------------------------------------------
// amalgam runs sessions by speaking Claude Code's streaming protocol, so
// Copilot cannot be driven — but `amalgam wire --copilot` puts every tool here
// inside it. Telling somebody looking at an installed Copilot that they have
// no agent CLI is wrong twice: they have one, and they already have the tools.
{
  const { machineGaps } = await import(`../lib/readiness.mjs?t=${Date.now()}`);
  const agentGap = (o) => machineGaps(o).find((g) => g.id === "agent");

  const neither = agentGap({ claude: null, copilot: null });
  check("with no agent at all, it says so plainly",
    /No agent CLI/.test(neither.what), neither.what);

  const copilotOnly = agentGap({ claude: null, copilot: "/somewhere/copilot" });
  check("with Copilot installed, it does not claim there is no agent",
    !/No agent CLI/.test(copilotOnly.what), copilotOnly.what);
  check("and says the tools still work where they already are",
    /wire --copilot/.test(copilotOnly.why),
    "the gap is Start work, not the whole product");
  check("and that installing Claude Code is optional for them",
    /can stop here/.test(copilotOnly.note ?? ""), copilotOnly.note);

  check("with Claude Code present there is no gap at all",
    !agentGap({ claude: "/somewhere/claude", copilot: null }));
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
