/**
 * The checks a change must pass before it is worth anyone's attention.
 *
 * An agent that finishes an edit and asks the expensive model "is this right?"
 * is paying frontier prices for a question a type checker answers for free.
 * Most of what comes back from such a review is not judgement at all — it is
 * an unused import, a broken test, a signature that no longer matches — and
 * every one of those is decided locally, deterministically, in seconds.
 *
 * So this runs the project's own checks first and reports a single verdict.
 * What passes is never mentioned again. What fails comes back verbatim, and
 * only that reaches the model, whose attention is then spent on the part that
 * actually needs judgement.
 *
 * Cheapest first, deliberately: a type error found in two seconds should not
 * wait behind a four-minute test suite, and a run that stops at the first
 * failure usually stops early.
 */
import fs from "node:fs";
import path from "node:path";
import { check, render } from "./checks.mjs";

/**
 * Work out how this project checks itself.
 *
 * Detection covers the common cases and is never clever about it: a project
 * that disagrees says so in package.json under "amalgam".checks, and that
 * settles it. Guessing wrong is cheap here — the command fails loudly — but
 * guessing *silently* is not, so what was chosen is always reported.
 */
export function detectChecks(repo) {
  const at = (f) => path.join(repo, f);
  const read = (f) => { try { return fs.readFileSync(at(f), "utf8"); } catch { return null; } };

  const pkgRaw = read("package.json");
  if (pkgRaw) {
    let pkg = {};
    try { pkg = JSON.parse(pkgRaw); } catch { /* malformed: fall through to detection */ }

    // An explicit list wins over anything inferred.
    const configured = pkg.amalgam?.checks;
    if (Array.isArray(configured) && configured.length) {
      return configured
        .map((c) => (typeof c === "string" ? { name: c, command: c } : c))
        .filter((c) => c?.command);
    }

    const scripts = pkg.scripts ?? {};
    // Ordered by cost, not by importance: the fast ones fail fast.
    const wanted = ["typecheck", "types", "tsc", "lint", "check", "test"];
    const found = [];
    for (const name of wanted) {
      if (scripts[name] && !found.some((f) => f.name === name)) {
        found.push({ name, command: `npm run ${name} --silent` });
      }
    }
    if (found.length) return found;
  }

  if (read("Cargo.toml")) {
    return [
      { name: "check", command: "cargo check --quiet" },
      { name: "test", command: "cargo test --quiet" },
    ];
  }
  if (read("go.mod")) {
    return [{ name: "vet", command: "go vet ./..." }, { name: "test", command: "go test ./..." }];
  }
  if (read("pyproject.toml") || read("pytest.ini") || read("setup.cfg")) {
    return [{ name: "test", command: "pytest -q" }];
  }
  const makefile = read("Makefile") ?? read("makefile");
  if (makefile) {
    const targets = ["check", "lint", "test"].filter((t) => new RegExp(`^${t}\\s*:`, "m").test(makefile));
    if (targets.length) return targets.map((t) => ({ name: t, command: `make ${t}` }));
  }
  return [];
}

/**
 * Run the gate.
 *
 * `stopOnFirst` is the default because the second check rarely tells you
 * anything while the first is still broken, and a developer waiting on a gate
 * wants the first answer quickly rather than every answer eventually.
 */
export async function runGate(repo, { checks = null, stopOnFirst = true, timeoutMs } = {}) {
  const list = checks ?? detectChecks(repo);
  if (!list.length) {
    return { detected: false, passed: null, results: [], repo };
  }
  const results = [];
  for (const c of list) {
    const r = await check(c.command, { cwd: repo, timeoutMs });
    results.push({ ...c, result: r });
    if (r.code !== 0 && stopOnFirst) break;
  }
  return {
    detected: true,
    passed: results.every((r) => r.result.code === 0),
    ran: results.length,
    total: list.length,
    results,
    repo,
  };
}

export function renderGate(gate) {
  if (!gate.detected) {
    return "No checks detected for this project. Add them under \"amalgam\": { \"checks\": [...] } in package.json, "
      + "or run a command directly with run_check.";
  }

  const head = gate.results.map((r) => {
    const { code, ms, failures } = r.result;
    return `  ${code === 0 ? "pass" : "FAIL"}  ${r.name.padEnd(10)} ${(ms / 1000).toFixed(1)}s`
      + `${code === 0 ? "" : `  ${failures} failure line(s)`}`;
  }).join("\n");

  const skipped = gate.total > gate.ran ? `\n  (${gate.total - gate.ran} later check(s) not run)` : "";

  if (gate.passed) {
    return `gate: passed — ${gate.ran} check(s)\n${head}${skipped}\n\nNothing needs review that a local check could settle.`;
  }

  // Only the failing check's output, and only its failing lines.
  const failed = gate.results.filter((r) => r.result.code !== 0);
  const detail = failed.map((r) => render(r.result)).join("\n\n");
  return `gate: FAILED\n${head}${skipped}\n\n${detail}`;
}
