# Tool map

Everything amalgam offers, what it is for, and when to reach for it.

Two surfaces, one system. The **CLI** is for you, at a prompt. The **MCP tools**
are the same capabilities exposed to an agent, and the session hook tells the
agent they exist. Anything you can check by hand, the agent is using the same
way.

## When you want to…

| You want to | Use |
|---|---|
| Understand code you are about to change | `code_context` |
| Know what a diff affects | `graph_impact` |
| Run tests or a build without drowning in output | `run_check` / `amalgam check` |
| Know whether a change is even worth reviewing | `run_gate` / `amalgam gate` |
| Start in a codebase nobody here wrote | `amalgam survey` / `survey_repo` |
| Know whether the work is actually finished | `amalgam trace` / `trace_stories` |
| Work on several things at once | `amalgam stream`, then `amalgam collide` |
| Remember something across sessions | `memory_save_fact` |
| Recover what you knew | `memory_recall`, `amalgam task show` |
| Read something long without paying for it | `digest` |
| Find out whether any of this is working | `amalgam stats` |

## Memory

Four layers in one SQLite file: raw turns (L0), distilled facts (L1), scenario
documents (L2), persona (L3).

| Tool | Purpose |
|---|---|
| `memory_recall` | Search by meaning and by keyword. Spends a character budget, drops near-duplicates, and says what it left out |
| `memory_save_fact` | One durable fact. Checks the paths it names, and reports anything already stored that it may replace |
| `memory_supersede` | Record that one fact replaces others. History stays; recall stops returning both |
| `memory_context_write` / `_read` / `_list` | Scenario documents — build steps, conventions, current plan |
| `memory_persona_read` / `_write` | Stable preferences and working style |
| `memory_log` | Verbatim exchanges worth keeping |

```bash
amalgam memory verify      # re-check every fact's paths against this machine
amalgam memory stale       # just the ones whose paths have gone
amalgam memory history     # what replaced what
amalgam memory pending     # facts a finished session proposed
amalgam memory accept 3 4  # into memory: verified, embedded, duplicate-checked
amalgam memory supersede 12 7 9
amalgam memory prune       # apply retention to raw turns
amalgam memory forget --all
```

**The rule worth knowing:** nothing writes itself into memory. Session capture
*proposes*; a person or an agent accepts. A fact that names a path which has
disappeared is shown with `!stale` beside it rather than hidden, because it may
still be the only answer — but you get to discount it.

## Code understanding

| Tool | Purpose |
|---|---|
| `code_context` | The symbols bearing on a task, their callers and callees, and their **current** source from disk |
| `graph_impact` | Which symbols a diff touched, and everything that calls them |
| `graph_query` | Structural questions: explain a symbol, find a path between two |

```bash
amalgam graph              # build/refresh, then index for search
amalgam graph --check      # is it stale?
amalgam graph --sql        # also parse .sql
```

**The design rule:** the graph decides *which* lines matter, the working tree
supplies *what they say*. A symbol that moved is located by name, a symbol that
was deleted is reported missing, and edges are checked against the source
before being reported — a Promise callback named `resolve` is not a call to
your exported `resolve`. A stale graph costs precision, never correctness.

## Running things

| Tool | Purpose |
|---|---|
| `run_check` | One command; returns the exit code and the failures byte for byte |
| `run_gate` | Every check the project defines, cheapest first, stopping at the first failure |

```bash
amalgam check "npm test"
amalgam gate --list        # what it detected
amalgam gate               # run them
```

Detection reads package.json scripts, Cargo.toml, go.mod, pytest config or a
Makefile. To override, say so once:

```json
{ "amalgam": { "checks": [{ "name": "ci", "command": "make verify" }] } }
```

**Nothing is summarised by a model.** Compilers and test runners announce
failures in formats a regular expression reads perfectly; output nobody
recognises falls back to the tail verbatim rather than being guessed at.

## Project state and completion

| Tool | Purpose |
|---|---|
| `survey_repo` | Brownfield triage: risk by churn × dependents, untested risk, hidden seams, a safe first change |
| `trace_stories` | Which stories declare a check, which pass it, which are done resting on nothing |
| `task_start` / `task_note` / `task_resume` / `task_done` | The thread tying story ↔ branch ↔ stream ↔ decisions ↔ facts |

```bash
amalgam survey --days 180 --run-checks
amalgam trace --verify
amalgam task new "Rework token validation" --story API-42
amalgam task note 1 "integration suite needs a fixture user" --kind blocker
amalgam task show 1
amalgam brief              # git, streams, tasks, BMAD artifacts, graph, services
```

## Parallel work

| Tool | Purpose |
|---|---|
| `stream_collisions` | What streams in flight are about to do to each other, and the order to merge |

```bash
amalgam stream new payments --repo .
amalgam stream list
amalgam collide
amalgam stream done payments
amalgam stream gc          # plan; --yes to execute
amalgam stream pin nightly # keep a warm build directory through gc
```

**Reclamation rules:** uncommitted work is never removed at any age. Pinned
streams survive everything. Merged means worktree and branch both go. Marked
done but unmerged means the worktree goes and the **branch stays**. Stale frees
build output and keeps the code.

## Local model (optional)

| Tool | Purpose |
|---|---|
| `digest` | A file or command output reduced locally; the raw text never enters your context |
| `caveman_compress` / `_expand` | Dense ↔ readable translation |

Also used, invisibly, to re-rank code search candidates and to distil a
finished session into candidate facts. It loads on first use and a watchdog
stops it after fifteen idle minutes (`AMALGAM_LLAMA_IDLE_MIN`).

## Housekeeping

```bash
amalgam status     # what is installed and running, and how idle the model is
amalgam version    # deployed vs. this checkout
amalgam update     # pull, re-deploy, refresh every wired copy
amalgam stats      # measured savings, counted only where a counterfactual exists
amalgam wire --user
amalgam shim
```

## Environment

| Variable | Effect |
|---|---|
| `AMALGAM_HOME` | Where the install lives (default `~/.amalgam`) |
| `AMALGAM_DB` | Memory database path |
| `AMALGAM_CAPTURE=off` | Disable session capture entirely |
| `AMALGAM_L0_DAYS` / `AMALGAM_L0_MAX_ROWS` | Raw-turn retention (default 30 days, 5,000 rows) |
| `AMALGAM_LLAMA_IDLE_MIN` | Idle shutdown for the local model (default 15, `0` disables) |
| `AMALGAM_LLAMA_PORT` | Local model port |
| `AMALGAM_HOOK_DEBUG=1` | Surface hook failures, which are otherwise silent by design |

## A note on restarts

The MCP server your agent talks to is spawned when the session starts. After
`amalgam update`, an open session keeps the tool list it began with — restart
it before expecting new tools to exist.
