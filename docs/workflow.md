# The workflow: amalgam + BMAD

BMAD is the process layer — agents, phases, artifacts. amalgam is the substrate
underneath it: memory, evidence, verification and isolation. They are separate
on purpose, and this page is about how they compose.

The short version: **BMAD decides what to do; amalgam supplies what is known
and checks what was claimed.**

## Which SDLC

BMAD is a plan-then-build cycle with an explicit review gate. Read it as five
phases; the fifth is the one most teams skip and later wish they had not.

```
   ┌── 1. Frame ──┐   ┌── 2. Design ──┐   ┌── 3. Slice ──┐
   │  the problem │ → │  the solution │ → │  into stories│
   └──────────────┘   └───────────────┘   └──────────────┘
                                                 ↓
                    ┌── 5. Verify ──┐   ┌── 4. Build ──┐
                    │  and retro    │ ← │  one story   │ ⟲
                    └───────────────┘   └──────────────┘
```

The loop is deliberate: you go round 4 once per story, and reach 5 once per
epic. Greenfield starts at 1. Brownfield starts *before* 1 — see below.

## Phase 0 — Brownfield only: know what you have

| Do | What it gives you |
|---|---|
| `amalgam graph` | The structure: symbols, callers, what depends on what |
| `amalgam survey --run-checks` | The danger: churn × dependents, untested risk, hidden seams |
| `/bmad-project-context` | The description: conventions, pitfalls, how to build — committed to the repo |

**What to expect.** Half an hour, mostly waiting on the graph. You end with a
ranked list of what is risky and a written description of how the project
works. If `survey` says the project's own checks fail, fix that first —
everything downstream assumes you can tell whether a change broke something.

**Do not skip to planning.** Planning against a codebase nobody has measured
produces stories that cannot be estimated and specs that name files that do not
exist.

## Phase 1 — Frame the problem

| Do | Artifact |
|---|---|
| `/bmad-brainstorming` or `/bmad-forge-idea` | Ideas, pressure-tested |
| `/bmad-deep-recon` | Research, filed and cited |
| `/bmad-product-brief` | The brief |
| `/bmad-prd` | The PRD |

**What to expect.** Conversation, not code. The analyst and PM agents
interrogate; you answer. Expect to be asked *why* more than you would like —
that is the point of the phase, and the cost of skipping it lands in phase 4.

**amalgam's part.** `memory_recall` at the start of each session means you are
not re-explaining the product every time. Decisions you make here should end up
as facts (`memory_save_fact`), because they are exactly what a session three
weeks from now will otherwise re-litigate.

## Phase 2 — Design the solution

| Do | Artifact |
|---|---|
| `/bmad-architecture` | The architecture spine |
| `/bmad-ux` | UX patterns and specs |

**What to expect.** The architect works from the PRD and, in a brownfield
project, from what actually exists. This is where `code_context` earns its
place: the agent asks the graph what the system does rather than reading its
way through it.

## Phase 3 — Slice into stories

| Do | Artifact |
|---|---|
| `/bmad-create-epics-and-stories` | Epics and stories |
| `/bmad-spec` | The spec kernel for a piece of work |
| `/bmad-sprint-planning` | `sprint-status.yaml` — the tracking file |

**What to expect.** Each story becomes a spec file with acceptance criteria, a
code map, and — the part worth insisting on — **verification commands**. A
story that declares no way to check itself cannot be shown to work later, and
`amalgam trace` will name it.

**Write the verification line even when it feels obvious.** It is the single
highest-leverage habit in this workflow: it turns "done" from an opinion into
something a machine re-checks on demand.

## Phase 4 — Build one story

| Do | What happens |
|---|---|
| `amalgam stream new <story>` | An isolated worktree, if the work is build-heavy or parallel |
| `amalgam task new "<title>" --story <id>` | The thread tying story ↔ branch ↔ decisions ↔ facts |
| `/bmad-build` | Plan, implement, self-review, present |
| `run_check` / `amalgam gate` | Checks, without the log entering anyone's context |
| `/bmad-code-review` | Adversarial review — *after* the gate is green |

**What to expect.** The dev agent plans before it edits, and stops to ask when
it hits something in the spec's "Ask First" list. Expect it to use
`code_context` rather than reading files, and `run_check` rather than pasting
output. If it is doing neither, the session predates the wiring — restart it.

**The ordering that saves the most money:** gate first, review second. A review
that spends an expensive model on an unused import is a review you paid for
twice.

**If more than one story is in flight:**

```bash
amalgam collide
```

Two streams changing the same symbol will merge cleanly and break behaviour.
`collide` compares symbols, not text, and gives you a merge order. Run it
*before* the merging starts, not during.

## Phase 5 — Verify and retrospect

| Do | What it answers |
|---|---|
| `amalgam gate` | Do the project's own checks pass? |
| `amalgam trace --verify` | Which stories can actually be shown to work? |
| `/bmad-retrospective` | What should change about how we work? |
| `amalgam memory pending` | What did these sessions learn that is worth keeping? |

**What to expect.** `trace` will find things. The usual finding is a story
marked done whose spec declares no verification command — not because anyone
was dishonest, but because the phase-3 habit had not formed yet. That is the
number to drive to zero before calling a milestone complete.

**The retrospective is where memory earns out.** Its action items are exactly
the kind of thing that evaporates: save them as facts, and next month's session
recalls them instead of rediscovering them.

## Where each amalgam piece fits

| Phase | You reach for |
|---|---|
| 0 Brownfield | `graph`, `survey`, `project-context` |
| 1 Frame | `memory_recall`, `memory_save_fact`, `digest` for research |
| 2 Design | `code_context`, `graph_query` |
| 3 Slice | `gate --list` (so specs declare real commands), `task new` |
| 4 Build | `stream`, `task note`, `code_context`, `run_check`, `run_gate`, `collide` |
| 5 Verify | `gate`, `trace --verify`, `memory pending`, `stats` |

## Anti-patterns

**Planning without measuring (brownfield).** Stories written against a codebase
nobody surveyed name files that do not exist and miss the parts that break.

**Specs with no verification commands.** Everything downstream degrades to
opinion, and `trace` can only report the absence.

**Reviewing before gating.** Paying frontier prices for lint.

**Parallel streams with no collision check.** The failure is silent: clean
merge, broken behaviour, two green suites.

**Never reviewing the memory queue.** Capture proposes; if nobody accepts or
rejects, the queue grows and the store stays empty — the worst of both.

## A realistic first week

| Day | Focus |
|---|---|
| 1 | Install, wire, `graph`, `survey`. Fix the build if it is broken. |
| 2 | `project-context`, then a small change in a well-covered file to prove the loop. |
| 3 | Frame and PRD for the first real slice. |
| 4 | Architecture, stories with verification commands, sprint status. |
| 5 | Build one story end to end: stream → build → gate → review → trace. |

If day 5 ends with `amalgam trace --verify` showing one story proven, the setup
works. Scale from there.
