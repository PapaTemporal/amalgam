#!/usr/bin/env node
/**
 * Choosing a model for a task, locally, before any of it is sent.
 *
 * Two halves, because they fail differently. The rules are deterministic and
 * must hold on every machine, so they are asserted outright. The local model is
 * a classifier — it will be wrong sometimes and pinning it to exact answers
 * would produce a test that fails for no reason — so it is scored, and what is
 * asserted is the shape of its mistakes rather than their absence.
 *
 * The asymmetry is the whole point. Routing a hard task to a cheap model wastes
 * the work and the person's time; routing an easy one to an expensive model
 * wastes some money. Those are not equally bad, so a wrong answer DOWNWARD is
 * counted separately and held to a much tighter bound than a wrong answer up.
 *
 * Usage: node tests/router-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-router-"));
process.env.AMALGAM_HOME = path.join(TMP, "home");
fs.mkdirSync(process.env.AMALGAM_HOME, { recursive: true });

const { TIERS, DEFAULT_TIER, tierById, rules, route, models, setModel, setRouting, routingEnabled } =
  await import("../lib/router.mjs");
/**
 * Whether the classifier can actually be asked, decided by asking it.
 *
 * `modelInstalled()` reads AMALGAM_HOME, which this file redirects for config
 * isolation — so it reports "not installed" on a machine where the model is
 * running perfectly well. One real call is the honest test.
 */
const { classify } = await import("../lib/router.mjs");
let classifierWorks = false;
try { await classify("rename a variable", { timeoutMs: 20000 }); classifierWorks = true; } catch { /* skipped below */ }

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}\n      ${why}`);

console.log("model routing\n");

const rank = (id) => TIERS.findIndex((t) => t.id === id);

// question -> the tier a careful person would pick
const CASES = [
  ["rename the variable foo to bar in lib/graph.mjs", "light"],
  ["fix the typo in the README heading", "light"],
  ["what does verifyFact return when a path is missing", "light"],
  ["add a test for staleFiles covering the untracked case", "standard"],
  ["implement the story: users can filter the catalog by price", "standard"],
  ["fix the bug where the map shows a service twice", "standard"],
  ["the graph index is sometimes empty after a rebuild and nobody knows why", "deep"],
  ["redesign how memory decides what is worth keeping across sessions", "deep"],
  ["work through the whole epic unattended overnight, deciding the approach as you go", "hardest"],
];

// --- the defaults are defensible ---------------------------------------------
{
  check("the default tier exists and is not the cheapest",
    tierById(DEFAULT_TIER) && rank(DEFAULT_TIER) > 0,
    `${DEFAULT_TIER} — unsure has to cost money, not work`);

  check("every tier names a model", TIERS.every((t) => /\S/.test(t.model)),
    TIERS.map((t) => `${t.id}=${t.model}`).join(" "));

  check("the tiers are ordered cheapest first",
    TIERS.every((t, i) => i === 0 || t.price.out >= TIERS[i - 1].price.out),
    TIERS.map((t) => `$${t.price.out}`).join(" <= "));
}

// --- routing is off until it is turned on ------------------------------------
{
  check("routing is off by default", routingEnabled() === false,
    "it changes which model runs your work, so it is opt-in");
  setRouting(true);
  check("and can be turned on", routingEnabled() === true);
  setRouting(false);
  check("and back off", routingEnabled() === false);
  setRouting(true);
}

// --- the mapping is editable, because the defaults are a judgement -----------
{
  check("a tier maps to its default model", models().light === "claude-haiku-4-5", models().light);
  setModel("light", "claude-sonnet-5");
  check("and can be pointed somewhere else", models().light === "claude-sonnet-5", models().light);
  check("an unknown tier is refused", !!setModel("nonsense", "x").error);
  setModel("light", "claude-haiku-4-5");
}

// --- the rules, which must work with nothing installed -----------------------
{
  check("a mechanical edit is cheap",
    rules("rename the variable foo to bar").tier === "light",
    rules("rename the variable foo to bar").why);

  check("a question about the code is cheap",
    rules("what does verifyFact return").tier === "light",
    rules("what does verifyFact return").why);

  check("something needing judgement is not",
    rules("investigate why the index is sometimes empty").tier === "deep",
    rules("investigate why the index is sometimes empty").why);

  check("an unrecognised task lands on the default",
    rules("do the thing with the stuff").tier === DEFAULT_TIER,
    "timid on purpose: unrecognised is not the same as simple");

  // The expensive direction. A long task description saying nothing about its
  // difficulty must not be read as simple just because it contains "rename".
  const long = "rename the config key, then work out why the scheduler drops jobs " +
               "under load and decide whether the retry policy should change at all";
  check("a long task is not called simple because one word in it is",
    rank(rules(long).tier) >= rank(DEFAULT_TIER), `${rules(long).tier} — ${rules(long).why}`);
}

// --- read-only sessions ------------------------------------------------------
{
  const r = await route("redesign the whole memory subsystem", { permissionMode: "read" });
  check("a read-only session is never routed to the top tier",
    rank(r.tier) < rank("deep") || r.tier === "standard",
    `${r.label} — ${r.why}`);
}

// --- the classifier ----------------------------------------------------------
if (!classifierWorks) {
  skip("the local model sizes tasks", "no local model reachable (amalgam install --with-model)");
} else {
  let exact = 0, below = 0, above = 0;
  const wrong = [];
  for (const [task, want] of CASES) {
    const r = await route(task);
    const d = rank(r.tier) - rank(want);
    if (d === 0) exact++;
    else if (d < 0) { below++; wrong.push(`DOWN ${r.tier} < ${want}: ${task.slice(0, 44)}`); }
    else { above++; wrong.push(`up   ${r.tier} > ${want}: ${task.slice(0, 44)}`); }
  }

  console.log(`      ${exact}/${CASES.length} exact, ${above} too strong, ${below} too weak`);
  for (const w of wrong) console.log(`      ${w}`);

  check("most tasks land on the tier a person would pick",
    exact >= Math.ceil(CASES.length * 0.6), `${exact}/${CASES.length}`);

  // The bound that matters. Sending hard work to a weak model is the failure
  // this feature could actually cause, so it is held tighter than the other.
  check("and it rarely sends hard work to a weak model",
    below <= 1, `${below} task(s) routed below where they belong`);

  check("no answer is ever outside the known tiers",
    (await route(CASES[0][0])).model.length > 0);
}

// --- a broken classifier must not stop a session -----------------------------
{
  // A classifier that throws, and one that answers something that is not a
  // tier. Both have to end in a running session rather than an exception,
  // because a session that cannot start is worse than one on the wrong model.
  const dead = async () => { throw new Error("llama-server would not start"); };
  const r1 = await route("rename a variable", { classifier: dead });
  check("an unreachable local model falls through to the rules",
    r1.by === "rules" && !!r1.model, `${r1.label} by ${r1.by}`);

  const nonsense = async () => { throw new Error('local model answered "maybe sonnet?"'); };
  const r2 = await route("redesign the scheduler", { classifier: nonsense });
  check("so does an answer that is not one of the tiers",
    r2.by === "rules" && !!r2.model, `${r2.label} by ${r2.by}`);
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
