#!/usr/bin/env node
/**
 * Build-and-test reporting evaluation.
 *
 * The exchange being replaced is the most reliably wasteful one in agentic
 * development: a command prints two thousand lines, nine of them matter, and
 * all two thousand are pasted into the conversation so the model can find the
 * nine. What matters about the replacement is not that it is smaller — that is
 * easy and worthless on its own — but that the nine lines come back BYTE FOR
 * BYTE. An error message with a paraphrased line number sends someone to the
 * wrong place with confidence.
 *
 * Real commands are run where a real command will do. Toolchains this machine
 * does not have are represented by their genuine output, captured verbatim,
 * because the thing under test is the reading of those formats.
 *
 * Usage: node tests/check-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, extract, render } from "../lib/checks.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-check-"));

let failed = 0;
const ok = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("check reporting eval\n");

// --- a command that passes --------------------------------------------------
{
  const script = path.join(TMP, "pass.mjs");
  fs.writeFileSync(script, `
    for (let i = 0; i < 500; i++) console.log("compiling module " + i + " ... ok");
    console.log("Tests: 41 passed, 41 total");
  `);
  const r = await check(`node "${script}"`, { cwd: TMP });
  const out = render(r);
  ok("a passing run reports its exit code", r.code === 0 && /exit 0/.test(out) && /passed/.test(out), out.split("\n")[1]);
  ok("500 lines of noise do not come back", out.length < 300 && r.totalLines > 500,
    `${r.totalLines} lines in, ${out.length} characters out`);
  ok("but the summary line does", /Tests: 41 passed/.test(out), out.split("\n").pop());
}

// --- a command that fails ---------------------------------------------------
{
  const script = path.join(TMP, "fail.mjs");
  fs.writeFileSync(script, `
    for (let i = 0; i < 300; i++) console.log("compiling module " + i + " ... ok");
    console.error("FAIL src/session.test.js");
    console.error("  ● validateSession › rejects an empty token");
    console.error("    expected 401, received 200");
    console.error("      at Object.<anonymous> (src/session.test.js:42:18)");
    for (let i = 0; i < 300; i++) console.log("more chatter " + i);
    console.log("Tests: 1 failed, 40 passed, 41 total");
    process.exit(1);
  `);
  const r = await check(`node "${script}"`, { cwd: TMP });
  const out = render(r);
  ok("a failing run leads with the exit code", /exit 1/.test(out), out.split("\n")[1]);
  ok("the failure comes back verbatim",
    out.includes("FAIL src/session.test.js") && out.includes("expected 401, received 200")
    && out.includes("src/session.test.js:42:18"),
    "message, expectation and location all preserved exactly");
  ok("the 600 lines of chatter do not", !out.includes("compiling module") && !out.includes("more chatter"),
    `${r.totalLines} lines in, ${out.split("\n").length} lines out`);
  ok("the counterfactual is measurable", r.raw.length > 5000 && out.length < r.raw.length / 10,
    `${r.raw.length} chars of output -> ${out.length} reported (${Math.round((1 - out.length / r.raw.length) * 100)}% less)`);
}

// --- output from toolchains this machine does not have ----------------------
// Genuine formats, verbatim. The point is that they are read correctly, not
// that these particular tools are installed.
const SAMPLES = {
  "tsc": [
    "src/app.ts(14,22): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "Found 1 error.",
  ],
  "cargo": [
    "   Compiling amalgam v0.1.0 (/src)",
    "error[E0308]: mismatched types",
    " --> src/main.rs:12:20",
    "test result: FAILED. 3 passed; 1 failed; 0 ignored",
  ],
  "pytest": [
    "collected 12 items",
    "test_session.py::test_rejects_blank FAILED",
    "E       AssertionError: assert 200 == 401",
    "=================== 1 failed, 11 passed in 0.42s ===================",
  ],
  "go": [
    "ok      example/pkg/util   0.004s",
    "--- FAIL: TestValidateSession (0.00s)",
    "    session_test.go:31: expected 401, got 200",
    "FAIL    example/pkg/session   0.012s",
  ],
  "make": [
    "gcc -c -o app.o app.c",
    "app.c:18:5: error: 'sesion' undeclared (first use in this function)",
    "make: *** [Makefile:7: app.o] Error 1",
  ],
};
for (const [tool, lines] of Object.entries(SAMPLES)) {
  const noise = Array.from({ length: 200 }, (_, i) => `[${tool}] step ${i} completed`);
  const found = extract([...noise, ...lines].join("\n"));
  const kept = found.lines.join("\n");
  const missed = lines.filter((l) => /error|FAIL|AssertionError|failed/i.test(l) && !kept.includes(l));
  ok(`${tool} failures are recognised`, found.failures > 0 && missed.length === 0,
    missed.length ? `missed: ${missed.join(" | ")}` : `${found.failures} failure line(s) kept out of ${found.totalLines}`);
}

// --- unrecognised output is not guessed at ----------------------------------
{
  const gibberish = Array.from({ length: 60 }, (_, i) => `frobnicating widget ${i}`).join("\n")
    + "\nthe widget frobnicator gave up";
  const found = extract(gibberish);
  ok("nothing is invented for output nobody recognises", found.recognised === false, "falls back to the tail");

  const script = path.join(TMP, "weird.mjs");
  fs.writeFileSync(script, `console.log("frobnicating"); console.log("the widget frobnicator gave up"); process.exit(3);`);
  const r = await check(`node "${script}"`, { cwd: TMP });
  const out = render(r);
  ok("the tail is returned verbatim instead",
    /exit 3/.test(out) && out.includes("the widget frobnicator gave up") && /no recognised failure format/.test(out),
    out.split("\n").filter(Boolean).pop());
}

// --- a flood of failures is capped, and says so -----------------------------
{
  const many = Array.from({ length: 80 }, (_, i) => `error: thing ${i} is wrong`).join("\n");
  const found = extract(many, { maxFailures: 10 });
  ok("a flood of failures is capped", found.lines.length <= 12 && found.truncated === 70,
    `${found.truncated} further failures withheld`);
  ok("and the cap is stated", /further failure/.test(render({
    command: "x", code: 1, totalLines: 80, ms: 10, raw: many, ...found,
  })), "the reader can ask for more");
}

// --- a hanging command does not hang the agent ------------------------------
{
  const script = path.join(TMP, "hang.mjs");
  fs.writeFileSync(script, `setTimeout(() => {}, 60000); console.log("waiting for something");`);
  const r = await check(`node "${script}"`, { cwd: TMP, timeoutMs: 1500 });
  ok("a hanging command is killed and reported", r.killed === true && /timed out/.test(render(r)),
    `stopped after ${(r.ms / 1000).toFixed(1)}s`);
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
