# Tool map

Everything amalgam offers, what it is for, and when to reach for it.

Two surfaces, one system. The **CLI** is for you, at a prompt. The **MCP tools**
are the same capabilities exposed to an agent, and the session hook tells the
agent they exist. Anything you can check by hand, the agent is using the same
way.

There is a third, optional surface: `amalgam ui` puts most of this behind a
screen — see [the interface](ui.md). It calls exactly these functions, so
nothing here is bypassed or duplicated by it.

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
amalgam contracts          # links the parser cannot see: who calls which route
```

**Contracts** are the second kind of edge: a parser only sees connections
written as symbols, so a `fetch("/api/state")` meeting a route declared
elsewhere is invisible to it. `amalgam contracts` infers those from string
evidence across every service, stores them, and reports routes nobody calls and
calls to routes nobody serves. They are kept separate from parsed edges and
carry their confidence, because one is a fact about syntax and the other is a
match between strings.

```bash
amalgam graph              # build/refresh, cluster, then index for search
amalgam graph --check      # is it stale?
amalgam graph --sql        # also parse .sql
amalgam graph --label      # name the communities using the local model
amalgam diagram            # draw a graph that is already built (seconds)
amalgam diagram --label    # ...and name its communities with the local model
amalgam refresh            # bring stale graphs up to date, within a budget
amalgam refresh --plan     # what it would do, and why it would skip the rest
amalgam vendor-graph       # keep the graph page's drawing library locally
```

Building now clusters as well as extracts, which is what writes graphify's
**GRAPH_REPORT.md** and its interactive **graph.html** — every symbol a node,
coloured by the community it belongs to, with a sidebar to filter and search
and a panel that inspects one. amalgam serves that page rather than competing
with it: open it from a project, under *Interactive graph*.

Two notes on it. Communities are numbered unless you pass `--label`, which
names them from the local model — no key, no cloud call, and the difference
between a legend reading "Community 0" and one reading "api.js". And the page
fetches its drawing library from a CDN, so it is blank offline; `amalgam
vendor-graph` keeps one 686 KB copy and the page never reaches the network
again.

**Staying accurate as the code moves.** Four things, none of which is a
background process:

1. *Nothing is quoted from the index.* The graph decides which lines matter;
   the file supplies what they say. A symbol that moved is found by name, a
   symbol that was deleted is reported missing, and an edge is re-read at the
   call site before it is reported. This is why a stale graph costs precision
   rather than correctness — it misses what is new, it does not invent what
   is gone.
2. *Stale graphs refresh themselves, within a budget.* When a session ends the
   machine is idle and nobody is waiting, so that is when it happens — no
   daemon, no watcher, no git hook. Only extraction and indexing, never
   clustering or drawing: accuracy lives in the index and the picture is what
   makes a rebuild expensive. A repository is only refreshed if amalgam has
   timed it before and it came in under 90 seconds, and not more than once
   every 30 minutes. Measured, those gates matter: one repository here
   refreshes in 17 seconds and another takes 4½ minutes with nothing changed at
   all. `amalgam refresh --plan` shows the decision for every repository, and
   `AMALGAM_AUTO_REFRESH=off` stops it entirely.
3. *Staleness is counted and shown.* Commits touching code since the graph was
   built, per repository, on the project card and the Code Graph panel, and in
   `amalgam graph --check`. Prose-only commits are excluded, because a warning
   that is usually noise is a warning nobody reads.
4. *Memory facts are checked when accepted and on demand.* `amalgam memory
   verify` re-reads the filesystem anchors in every live fact and marks the
   ones whose paths have gone. A fact with nothing checkable is reported as
   unknown rather than as fine.
5. *Nothing is believed twice.* An accepted fact that restates a stored one is
   reported as a near-duplicate, and `memory_supersede` marks the older so
   recall stops returning both.

**The design rule:** the graph decides *which* lines matter, the working tree
supplies *what they say*. A symbol that moved is located by name, a symbol that
was deleted is reported missing, and edges are checked against the source
before being reported — a Promise callback named `resolve` is not a call to
your exported `resolve`. A stale graph costs precision, never correctness.

The same graph is browsable by hand in the interface — `amalgam ui`, then
**Explore** on a project. Search by meaning, walk the tree, see the hubs and
clusters, draw the neighbourhood of any symbol, trace a path between two, or
ask what a change would reach. Paths and blast radii cross service boundaries
through the inferred contract edges, and every hop that came from a route
string rather than a parser says so. See **[the interface](ui.md#explore)**.

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

---

New here? [Getting started](getting-started.md) walks the first hour. For the
reasoning behind each behaviour, see [design notes](design.md).
