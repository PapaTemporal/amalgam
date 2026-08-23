#!/usr/bin/env node
/**
 * Traceability evaluation.
 *
 * The one thing this feature must never do is flatter the project. Every check
 * below is aimed at that: a story wearing unfilled template placeholders has
 * declared nothing, a story marked done with no way to check it is the finding
 * that matters most, and a passing command is reported as a passing command
 * and never as a met acceptance criterion.
 *
 * Specs are written in the real BMAD template shape, because parsing the
 * artifacts the planning layer actually produces is the entire point.
 *
 * Usage: node tests/trace-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSpecs, parseSpec, parseSprintStatus, assess, verify, summarise, render } from "../lib/trace.mjs";
import { check } from "../lib/checks.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-trace-"));

let failed = 0;
const ok = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

const write = (rel, text) => {
  const f = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

console.log("traceability eval\n");

// A real project shape: source, a story that checks itself, one that does not,
// one still full of template placeholders, and one whose plan has drifted.
write("src/session.js", "export const validate = (t) => String(t).trim().length > 8;\n");

write("_bmad-output/stories/1-1-token-validation.md", `---
title: 'Token validation'
type: 'feature'
status: 'done'
---

## Code Map

- \`src/session.js\` -- the validator

## Tasks & Acceptance

**Execution:**
- [ ] \`src/session.js\` -- add validation -- rejects blanks

**Acceptance Criteria:**
- Given an empty token, when validate is called, then it returns false
- Given a long token, when validate is called, then it returns true

## Verification

**Commands:**
- \`node -e "process.exit(0)"\` -- expected: exits clean
`);

write("_bmad-output/stories/1-2-account-management.md", `---
title: 'Account management'
status: 'done'
---

## Tasks & Acceptance

**Acceptance Criteria:**
- Given a signed-in user, when they change their email, then a confirmation is sent
`);

write("_bmad-output/stories/1-3-untouched.md", `---
title: '{title}'
status: 'draft'
---

## Code Map

- \`FILE\` -- ROLE_OR_RELEVANCE

## Tasks & Acceptance

**Acceptance Criteria:**
- Given PRECONDITION, when ACTION, then EXPECTED_RESULT

## Verification

**Commands:**
- \`COMMAND\` -- expected: SUCCESS_CRITERIA
`);

write("_bmad-output/stories/1-4-drifted.md", `---
title: 'Drifted story'
status: 'review'
---

## Code Map

- \`src/gone.js\` -- a file nobody wrote

## Tasks & Acceptance

**Acceptance Criteria:**
- Given a request, when it arrives, then it is logged

## Verification

**Commands:**
- \`node -e "process.exit(1)"\` -- expected: this one fails
`);

write("_bmad-output/sprint-status.yaml", `generated: 05-06-2025 21:30
project: Test
story_location: "_bmad-output/stories"

development_status:
  epic-1: in-progress
  1-1-token-validation: done
  1-2-account-management: done
  1-3-untouched: backlog
  1-4-drifted: review
`);

// --- parsing the real template shape ---------------------------------------
const one = parseSpec(path.join(TMP, "_bmad-output/stories/1-1-token-validation.md"));
ok("a spec's frontmatter is read", one.title === "Token validation" && one.status === "done",
  `${one.title} [${one.status}]`);
ok("acceptance criteria are counted", one.criteria.length === 2, `${one.criteria.length} criteria`);
ok("verification commands are extracted from backticks",
  one.commands.length === 1 && one.commands[0].startsWith("node -e"), one.commands.join(" | "));
ok("the code map is read", one.codeMap.join() === "src/session.js", one.codeMap.join(", "));

const blank = parseSpec(path.join(TMP, "_bmad-output/stories/1-3-untouched.md"));
ok("unfilled template placeholders count as nothing declared",
  blank.criteria.length === 0 && blank.commands.length === 0 && blank.codeMap.length === 0,
  "a spec still wearing FILE/COMMAND/PRECONDITION has declared nothing");

const notASpec = write("_bmad-output/notes.md", "# Just some notes\n\nNothing to see.\n");
ok("ordinary markdown is not mistaken for a spec", parseSpec(notASpec) === null);

// --- sprint status ----------------------------------------------------------
const sprint = parseSprintStatus(TMP);
ok("sprint status is found and read",
  sprint && sprint.stories["1-1-token-validation"] === "done" && sprint.stories["epic-1"] === "in-progress",
  `${Object.keys(sprint?.stories ?? {}).length} entries`);

// --- assessment -------------------------------------------------------------
const specs = findSpecs(TMP);
ok("every spec in the tree is found", specs.length === 4, `${specs.length} specs`);

const assessed = specs.map((s) => assess(s, { repo: TMP, sprintStatus: sprint }));
const byId = Object.fromEntries(assessed.map((a) => [a.id, a]));

ok("state comes from sprint status, not the file's own claim",
  byId["1-4-drifted"].state === "review", byId["1-4-drifted"].state);
ok("a story naming files that do not exist is flagged as drifted",
  byId["1-4-drifted"].missingFiles.join() === "src/gone.js",
  byId["1-4-drifted"].missingFiles.join(", "));
ok("a story whose code map is real is not flagged",
  byId["1-1-token-validation"].missingFiles.length === 0);

// --- the finding that matters ----------------------------------------------
const before = summarise(assessed);
ok("a story marked done with no way to check it is reported as unproven",
  before.unproven.length === 1 && before.unproven[0] === "1-2-account-management",
  `unproven: ${before.unproven.join(", ")}`);
ok("a backlog story with no checks is NOT counted as unproven",
  !before.unproven.includes("1-3-untouched"),
  "not yet started is a schedule, not a hole in the evidence");

// --- running the stories' own checks ---------------------------------------
await verify(assessed, { repo: TMP, check, timeoutMs: 30000 });
const after = summarise(assessed);
ok("a story whose command passes is marked proven",
  after.passing.includes("1-1-token-validation"), `passing: ${after.passing.join(", ")}`);
ok("a story whose command fails is marked failing",
  after.failing.includes("1-4-drifted"), `failing: ${after.failing.join(", ")}`);
ok("a story that declared nothing is neither",
  byId["1-2-account-management"].verified === null,
  "silence is not evidence in either direction");

const out = render(assessed, after, { verified: true });
ok("the report refuses to claim the criteria are met",
  /not a proof that the acceptance criteria are met/i.test(out),
  "a passing command is reported as a passing command");
ok("the report names the unproven story", out.includes("1-2-account-management"),
  out.split("\n").find((l) => l.includes("declare no way")) ?? "");

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
