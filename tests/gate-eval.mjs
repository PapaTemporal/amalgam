#!/usr/bin/env node
/**
 * Gate evaluation.
 *
 * The claim is narrow and worth pinning: a project's own checks are found
 * without being told, run cheapest first, and produce a verdict whose failing
 * half is verbatim and whose passing half is three lines. What must not happen
 * is a gate that guesses silently — a wrong command is fine, an unexplained
 * one is not.
 *
 * Projects are built in temp directories with real manifests and real
 * commands; nothing is mocked, because detection reading a manifest wrongly is
 * exactly the failure this guards against.
 *
 * Usage: node tests/gate-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectChecks, runGate, renderGate } from "../lib/gates.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-gate-"));

let failed = 0;
const ok = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

const project = (name, files) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
  return dir;
};

console.log("gate eval\n");

// --- detection --------------------------------------------------------------
{
  const dir = project("node-app", {
    "package.json": JSON.stringify({
      name: "x",
      scripts: { build: "echo build", test: "echo test", lint: "echo lint", typecheck: "echo tsc" },
    }),
  });
  const checks = detectChecks(dir);
  ok("npm scripts are found", checks.length === 3, checks.map((c) => c.name).join(", "));
  ok("cheapest first: types, then lint, then tests",
    checks.map((c) => c.name).join(",") === "typecheck,lint,test",
    "a two-second type error should not wait behind a four-minute suite");
  ok("scripts that are not checks are left alone",
    !checks.some((c) => c.name === "build"), "build is not a check");
}

{
  const dir = project("configured", {
    "package.json": JSON.stringify({
      scripts: { test: "echo never-run" },
      amalgam: { checks: [{ name: "custom", command: "echo hello" }] },
    }),
  });
  const checks = detectChecks(dir);
  ok("an explicit list overrides detection",
    checks.length === 1 && checks[0].name === "custom", checks.map((c) => c.command).join(", "));
}

{
  ok("a rust project is recognised",
    detectChecks(project("rusty", { "Cargo.toml": "[package]\nname='x'\n" }))
      .map((c) => c.command).join(" ").includes("cargo"),
    "cargo check then cargo test");
  ok("a go project is recognised",
    detectChecks(project("gopher", { "go.mod": "module x\n" }))
      .some((c) => c.command.startsWith("go ")));
  ok("a python project is recognised",
    detectChecks(project("snake", { "pyproject.toml": "[project]\nname='x'\n" }))
      .some((c) => c.command.startsWith("pytest")));
  ok("a Makefile's real targets are used",
    detectChecks(project("maker", { "Makefile": "build:\n\techo b\ntest:\n\techo t\n" }))
      .map((c) => c.name).join(",") === "test",
    "only targets that exist, and only ones that check something");
  ok("a project with nothing to run says so",
    detectChecks(project("bare", { "README.md": "nothing here" })).length === 0);
}

// --- passing gate -----------------------------------------------------------
{
  const dir = project("passing", {
    "package.json": JSON.stringify({ scripts: { lint: "node -e \"console.log('lint ok')\"", test: "node -e \"console.log('41 passed')\"" } }),
  });
  const gate = await runGate(dir);
  const out = renderGate(gate);
  ok("a passing gate passes", gate.passed === true && gate.ran === 2, out.split("\n")[0]);
  ok("and says almost nothing", out.length < 260, `${out.length} characters for a full green run`);
}

// --- failing gate -----------------------------------------------------------
{
  const dir = project("failing", {
    "package.json": JSON.stringify({
      scripts: {
        typecheck: "node -e \"console.log('src/app.ts(14,22): error TS2345: Argument of type string'); process.exit(1)\"",
        test: "node -e \"console.log('this suite must never run'); process.exit(0)\"",
      },
    }),
  });
  const gate = await runGate(dir);
  const out = renderGate(gate);
  ok("a failing gate fails", gate.passed === false, out.split("\n")[0]);
  ok("the failure comes back verbatim", out.includes("error TS2345") && out.includes("src/app.ts(14,22)"),
    "the exact compiler message, not a summary of it");
  ok("later checks do not run once one has failed",
    gate.ran === 1 && !out.includes("must never run"), `${gate.ran} of ${gate.total} checks ran`);
  ok("and the report says what was skipped", /later check\(s\) not run/.test(out),
    out.split("\n").find((l) => l.includes("not run")));
}

// --- everything runs when asked --------------------------------------------
{
  const dir = project("all", {
    "package.json": JSON.stringify({
      scripts: { lint: "node -e \"process.exit(1)\"", test: "node -e \"console.log('ran anyway')\"" },
    }),
  });
  const gate = await runGate(dir, { stopOnFirst: false });
  ok("stop_on_first: false runs the rest", gate.ran === 2 && gate.passed === false,
    `${gate.ran} checks ran, verdict ${gate.passed}`);
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
