# Getting started

Your first hour, and what to expect while it happens.

## Two ways through this

Everything below can be done from a screen or from a terminal. Neither is the
"real" one — they run the same code, and you can switch at any point.

| | |
|---|---|
| **`amalgam ui`** | Setup wizards with live progress, project dashboards, metrics, and buttons that compose a context-loaded prompt. Nothing to install: it ships compiled. See **[the interface](ui.md)**. |
| **The CLI** | Every capability as a command. Scriptable, remote-friendly, no browser. That is the path this page follows. |

If you would rather click than type, run `amalgam ui` after step 0 below and
let the wizard take over — the rest of this page describes what it is doing on
your behalf.

![The setup wizard, choosing what to install](images/setup.png)


## 0. Install and wire (5 minutes, once per machine)

```bash
git clone https://github.com/papatemporal/amalgam.git
cd amalgam
node bin/amalgam.mjs install --with-embeddings
node bin/amalgam.mjs wire --user
node bin/amalgam.mjs shim          # so `amalgam` works without an alias
```

**What just happened.** `install` copied the code to `~/.amalgam` and created a
SQLite file for memory — no service, no port, nothing running. `--with-embeddings`
added a 220 MB embedding model so search works by meaning rather than by exact
words; skip it and everything still works with keyword search. `wire --user`
registered the MCP server and two session hooks for *every* project on this
machine.

**What to expect.** Nothing visible yet. Restart your agent session — until you
do, it is still running the tool list it started with.

Optional, and a real decision: `--with-model` adds a 2.5 GB local model that
powers `digest`, better retrieval ranking, and session capture. Everything else
works without it. It loads on first use and shuts itself down after fifteen
idle minutes.

**Verify:**

```bash
amalgam status
```

Requirements, proxies, per-project wiring and updating are all in
[Installing](install.md) — you should not need any of it to start.

## 1. Point it at a codebase (2 minutes)

```bash
cd /path/to/your/project
amalgam graph
```

**What just happened.** graphify parsed your code with tree-sitter — locally, no
LLM — and amalgam imported the result into the same SQLite file as memory,
embedding each symbol along with the comment above it.

**What to expect.** A line per service saying how many symbols and edges were
found. On a large repository the first build takes a few minutes; re-running it
later re-embeds only what changed.

## 2a. If the codebase is new to you (brownfield)

This is the path most people need and the one that used to have no answer.

```bash
amalgam survey --run-checks
```

**What to expect** — a report in four parts:

1. **Bootstrap.** Whether the project's own checks exist and pass. If they do
   not, stop: there is no way to tell whether a change broke anything, and that
   is the first job.
2. **Riskiest files**, ranked by churn × dependents, each with its reasons —
   how often it changes, how many files depend on it, whether any test reaches
   it.
3. **Write characterization tests here first** — the risky files nothing tests.
   This is the list that decides whether the next month goes well.
4. **Changes together but lives apart** — files that keep appearing in the same
   commit despite being in different directories. That is a seam the layout is
   hiding.

Then let your agent read the qualitative side:

```
/bmad-project-context
```

The two are complementary on purpose. `project-context` writes down what the
system *is*, in a file your team can review and commit. `survey` measures which
parts are *dangerous*, from history and structure. Neither replaces the other.

**A good first task in a brownfield repo** is the one `survey` names last: an
active file that tests already cover. Make a small change there, run the gate,
and you will know whether the setup works before you trust it with anything
that matters.

## 2b. If you are starting fresh (greenfield)

Skip the survey — there is no history to measure. Go straight to planning; see
[the workflow](workflow.md) for the full sequence.

The thing worth doing early, which most projects do far too late:

```bash
amalgam gate --list
```

If that prints nothing, your project has no checks yet, and every review from
here on will spend an expensive model on questions a linter answers for free.
Add a test script before the second feature, not after the tenth.

## 3. Work a task (the loop)

Open your agent session and just work. The session hook has already told the
agent what is available. What you should see it doing:

- **Starting** with `memory_recall` instead of asking you what the project is.
- **Reaching for `code_context`** instead of reading three files, when it needs
  to change something that already exists.
- **Running `run_check`** instead of pasting a test log — you will see the exit
  code and the failures, not two thousand lines of progress.
- **Calling `run_gate`** before asking you to review anything.

If it is not doing those, the session predates the wiring. Restart it.

**Track anything spanning more than one exchange:**

```bash
amalgam task new "Rework session token validation" --story API-42
```

Then notes as things happen — decisions, blockers, test results — so that
tomorrow's "where was I" is a lookup rather than an investigation:

```bash
amalgam task note 1 "reject empty tokens at the edge, not per handler" --kind decision
amalgam task show 1
```

## 4. Parallel work (when you have more than one thing in flight)

```bash
amalgam stream new payments --repo .
amalgam collide
```

**What to expect.** A stream is a git worktree, isolated, with its own build
directory. `collide` compares what each stream has changed — by symbol, not by
text — and tells you three things: which streams will *fight* (both changed the
same function, and a clean merge is the dangerous case), which merely share a
file, and which must merge in a particular order because one calls what the
other changed.

When a stream's work has been judged:

```bash
amalgam stream done payments
amalgam stream gc            # plan only — nothing is deleted
amalgam stream gc --yes      # execute
```

Uncommitted work is never removed, at any age. A stream marked done but not
merged loses its worktree and **keeps its branch**.

## 5. Before you call it finished

```bash
amalgam gate            # does the project's own checks pass?
amalgam trace --verify  # which stories can actually be shown to work?
amalgam stats           # what did all this save?
```

`trace` is the one worth reading carefully. It will name the stories that are
marked done while declaring no way to check them. That number is the honest
state of your project.

## 6. What happens when the session ends

You do not have to do anything. When a session ends — `/clear`, quitting, or
the app closing it — a hook writes the conversation's turns to the raw memory
layer (redacted, capped at 30 days and 5,000 turns) and, if you installed the
local model, distils them into **candidate facts**.

Candidates are proposals, never memories. The next session opens by telling you
they are waiting:

```bash
amalgam memory pending
amalgam memory accept 3 4     # into memory, verified and duplicate-checked
amalgam memory reject 5
```

If you would rather none of this happened, `AMALGAM_CAPTURE=off` stops it
entirely, and `amalgam memory forget --all` deletes what is already there
without touching your distilled facts.

## Starting a session: `/start`

BMAD is a set of workflows, not a front door — it never asks what you want to
do, so every session begins with a blank prompt. The `start` skill is that
front door. It loads state first (`amalgam brief`: git, work streams, BMAD
artifacts and their statuses, whether a code graph exists) plus memory of past
sessions, then offers concrete choices:

> **Build** · **Plan** · **Investigate** · **Housekeeping**

It drills down with real names — "continue story 2.3 (in review)" rather than
"work on a story" — then routes into the matching BMAD workflow with context
already loaded, opening a work stream first when the task is build-heavy.
Invoke it as `/start`, or just say "what should I work on".

`amalgam brief` is useful on its own:

```bash
amalgam brief                     # current directory
amalgam brief C:\path\to\repo     # a specific project
```

```text
PROJECT  api-server  (C:\path\to\workspace\api-server)
GIT      branch main | 3 uncommitted change(s)
         open branches: fix/20260820-null-session-token
STREAMS  none
BMAD     installed | 49 bmad skills | output _bmad-output
GRAPH    built (C:\path\to\workspace\api-server\graphify-out\graph.json)
RUNTIME  memory=sqlite (no service) model=installed
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A project on the list should not be there | Added by mistake, or a service promoted by an older build | Click the **×** on its card — nothing on disk is touched |
| A project shows fewer symbols than expected | Some services have a graph file but were never imported into the index | Run `amalgam graph` at the project root — it builds and indexes every service |
| `amalgam graph` fails or the Build button is disabled | `uv` is not installed | Install [uv](https://docs.astral.sh/uv/); graphify runs through it |
| The agent never uses the tools | Session started before wiring | Restart the session |
| `code_context` says no graph | Never indexed | `amalgam graph` |
| Retrieval finds nothing by meaning | No embedding model | `amalgam install --with-embeddings` |
| `digest` / capture unavailable | No local model | `amalgam install --with-model` |
| `amalgam` command not found | Alias trouble | `amalgam shim`, or call `node bin/amalgam.mjs` |
| Facts mention paths that are gone | Normal drift | `amalgam memory verify`, then supersede |

---

Next: [the workflow](workflow.md) for how this composes with BMAD, or the
[tool map](tools.md) when you want to know which tool answers which question.
