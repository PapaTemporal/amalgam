# Amalgam

Local offload stack for frontier-model coding agents. An amalgamation of four
ideas — **BMAD** (skill orchestration), **TencentDB-Agent-Memory** (L0→L3
layered memory), **caveman** (telegraphic token compression), **graphify**
(code knowledge graphs) — rebuilt to run **fully local, portable, zero
installs, zero admin, zero cloud**. The only network call the agent ever makes
is its own call to the frontier model.

```
Claude Code / Copilot ──stdio──▶ ~/.amalgam/mcp/server.mjs (zero-dep Node)
                                    │
                ┌───────────────────┼─────────────────────┐
                ▼                   ▼                     ▼
          SQLite (built in)   llama.cpp + Qwen3-4B    graphify (via uv)
          one file, no daemon OPTIONAL, :8642     tree-sitter, no LLM
          L0 log / L1 facts   digest (bulk -> dense)  graph explain/path/query
          L2 scenarios        caveman compress/expand
          L3 persona
```

## Requirements

- **Node 22.5+** (the only hard prerequisite — it supplies the built-in SQLite the memory
  store uses; nothing is installed for it)
- Optional: [uv](https://docs.astral.sh/uv/) for graphify code-graph queries
- Optional: the local model (~2.5 GB, Windows x64) for `digest` and `caveman_*`
- Default install writes a few hundred KB and needs no admin rights

## Install (per machine, once)

Pick **one** of the two routes below — they are alternatives, not steps.

**From a clone** — use this if you want to read or change the code:

```bash
git clone https://github.com/papatemporal/amalgam.git
cd amalgam
node bin/amalgam.mjs install                    # memory only — downloads nothing
node bin/amalgam.mjs install --with-embeddings  # + semantic recall (~153 MB)
node bin/amalgam.mjs install --with-model       # + digest & caveman (~2.5 GB)
```

**Without cloning** — npx fetches the repo itself (your git credentials cover
the private repo):

```bash
npx github:papatemporal/amalgam install --with-embeddings
```

The flags are cumulative in effect, not sequential: `--with-model` implies
`--with-embeddings`, and re-running with a new flag only fetches what is
missing.

There is no service to start: memory is a SQLite file opened on demand, and
the model (if installed) starts itself the first time a tool needs it.

### Typing `amalgam` instead of `node bin/amalgam.mjs`

Every example below writes `amalgam` for brevity. To make that a real command:

```bash
node bin/amalgam.mjs shim
```

That writes `amalgam.cmd` and `amalgam` into a directory already on your PATH
(no admin), so the command works from cmd, PowerShell, and Git Bash alike and
survives new shells. Pass a directory to choose one: `amalgam shim <dir>`.

**Why not an alias?** Aliases are the usual advice and the usual bug: both of
these silently drop your arguments, so `amalgam wire --user` arrives as no
arguments at all and you get the usage screen.

| | Drops arguments | Works |
|---|---|---|
| PowerShell | `function amalgam { node .../amalgam.mjs }` | `function amalgam { node .../amalgam.mjs @args }` |
| cmd `doskey` | `doskey amalgam=node .../amalgam.mjs` | `doskey amalgam=node .../amalgam.mjs $*` |

`Set-Alias` cannot forward arguments at all, and a `doskey` macro lasts only
for the session that defined it and never applies to PowerShell. Adding `bin/`
to PATH does not work either: the file is `amalgam.mjs`, which Windows will not
execute directly.

Or skip all of it and keep typing `node bin/amalgam.mjs ...`; every example
works that way too.

### Behind a proxy?

The default install downloads **nothing**, so proxies are irrelevant to it.
They matter only for `--with-model`, whose payloads are published as **release
assets on this repo** (see [Releases](https://github.com/PapaTemporal/amalgam/releases)).
The installer tries: release asset via `gh` CLI → release asset via token
(`AMALGAM_GITHUB_TOKEN` or `GITHUB_TOKEN`) → the external URLs below via
`curl` (which honors `HTTP_PROXY`/`HTTPS_PROXY`).

**No gh, no token? Use your browser** (works for this private repo while
logged in to GitHub): open the release page, download the assets, save them
to the paths below, then re-run `amalgam install --with-model`:

| Release asset | Needed for | Save to |
|---|---|---|
| `llama-cpu-x64.zip` (~19 MB) | both | `~/.amalgam/downloads/llama-cpu-x64.zip` |
| `bge-small-en-v1.5-f32.gguf` (~134 MB) | `--with-embeddings` | `~/.amalgam/models/` (same filename) |
| `Qwen3-4B-Instruct-2507-Q4_K_M-00001-of-00002.gguf` (~1.8 GB) | `--with-model` | `~/.amalgam/models/` (same filename) |
| `Qwen3-4B-Instruct-2507-Q4_K_M-00002-of-00002.gguf` (~0.6 GB) | `--with-model` | `~/.amalgam/models/` (same filename) |

The model is a llama.cpp **split GGUF** — download both parts, no
reassembly; llama-server loads part 1 and finds part 2 itself.

External fallbacks (public hosts, used automatically when the release is
unreachable): llama.cpp from
<https://github.com/ggml-org/llama.cpp/releases> (tag b10532), the embedding
model from
<https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf>, and the
generation model as a single file from
<https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf>
(mirror: swap `huggingface.co` for `hf-mirror.com`) saved to
`~/.amalgam/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` — the single file
works exactly like the split pair.

Already have the files on another machine? Copy them over and pass
`--cache <dir>`, or drop them straight into the destinations above — the
most proxy-proof option of all.

## Wire it up

**Recommended — once per machine, works in every repo:**

```bash
node bin/amalgam.mjs wire --user
```

This installs the skills into `~/.claude/skills/`, the SessionStart hook into
`~/.claude/settings.json`, and the MCP server into `~/.claude.json` — so every
session on the machine has them, whichever repo it opens. (Both config files
are backed up as `*.amalgam-bak` before the first merge.)

**Per project** (adds a project-local `.mcp.json` / `.vscode/mcp.json`, useful
when a repo should carry its own wiring):

```bash
cd your-project
node /path/to/amalgam/bin/amalgam.mjs wire            # both agents
node /path/to/amalgam/bin/amalgam.mjs wire --claude   # Claude Code only
node /path/to/amalgam/bin/amalgam.mjs wire --copilot  # VS Code Copilot only
```

### Workspace layout (where BMAD goes)

BMAD is a **workspace-level** tool, not a per-repo one. Install it once at the
directory that holds your repos; clone services into that directory; its
workflows then reason across the whole system and write their documents at the
workspace level.

```text
workspace/                   <- workspace: BMAD installed HERE
├── _bmad/                   BMAD config, scripts, modules
├── _bmad-output/            PRDs, epics, stories, project docs for ALL services
├── .claude/skills/          bmad-* workflows + amalgam skills
├── api-server/              service (cloned repo) — no BMAD inside it
├── web-client/              service
└── shared-lib/              service
```

```bash
cd C:\path\to\workspace
npx bmad-method install --yes --tools claude-code --directory .
node /path/to/amalgam/bin/amalgam.mjs wire        # amalgam for the same workspace
```

Run your agent sessions from the workspace directory. `amalgam brief` detects
this shape and lists the services under it with their branch and state, so
`/start` can ask which service a piece of work targets while keeping planning
artifacts where they belong — above the services, describing the system.

Nothing is installed into a service repo. A service keeps only its own code
(plus, optionally, a `graphify-out/` code graph, which is per-repo by nature).

> `amalgam globalize <dir>` exists for the unrelated case of a tool that
> insists on installing its skills per-repo: it promotes them to
> `~/.claude/skills/` so they load everywhere. BMAD does not need it.

- **Claude Code**: writes `.mcp.json` (server `amalgam`) and copies the
  `offload` + `caveman` skills into `.claude/skills/`.
- **Copilot**: writes `.vscode/mcp.json` (agent-mode MCP) and appends a
  marker-fenced guidance block to `.github/copilot-instructions.md`.

**After wiring, it runs itself.** The SessionStart hook injects the offload
directives as session context — deterministic, unlike skill description
matching, and it reaches every workflow in the session including BMAD skills,
without modifying any of them. Nothing needs starting: memory is a file, and
the optional model loads on the first tool that needs it, so idle sessions
never pay its ~3.6 GB of RAM.

Both merge — existing config in those files is preserved.

## Daily use

```bash
node bin/amalgam.mjs status   # what is present and running
node bin/amalgam.mjs stats    # measured tool usage — is this earning its keep?
node bin/amalgam.mjs graph    # build/refresh the code graph (see below)
```

A graph belongs to **one service**, never to a whole workspace — mixing several
codebases into a single index produces a graph too muddled to answer anything
well. So `graph` builds one graph per service, and picks its targets from where
you run it:

```bash
cd api-server && amalgam graph       # inside a repo: that repo
amalgam graph /path/to/api-server    # an explicit path: exactly that, nothing else
amalgam graph --directory ../web     # same, when the path could be mistaken for a flag
amalgam graph                        # at a workspace root: every service, one graph each
amalgam graph --check                # report staleness instead of rebuilding
```

At a workspace root — a directory that is not itself a repo but holds two or
more — it walks every service and gives each its own graph. Directories not
under version control are skipped, since those are usually vendored tools or
downloads rather than code you are working on; `--all` includes them. Pass
`--sql` to parse `.sql` files as well.


`amalgam graph` wraps graphify with `--code-only`, which keeps it on its local
tree-sitter path — the docs/media pass would call a cloud LLM, which this
stack forbids.

## Updating

The agent does not run this repo directly: `install` copies the code into
`~/.amalgam`, and `wire` copies the skills again into `~/.claude` and into each
wired project. So `git pull` on its own changes nothing that actually runs.

```bash
amalgam update      # pull, re-deploy, and refresh every copy that was wired
amalgam version     # what is deployed vs. what this source has
```

`update` pulls the clone (skipped automatically when you have local changes),
re-deploys the payload, then refreshes user-scope wiring and every project it
recorded at wire time. Restart open agent sessions afterwards — skills, hooks,
and MCP servers are read once at session start.

`version` reports drift on its own:

```text
amalgam 0.1.0 (350ef61)
source   : /path/to/amalgam-pkg
installed: 0.1.0 (0000000) on 2026-08-21 -> /home/you/.amalgam

The deployed copy is behind this source. Run: amalgam update
```

Installed with npx rather than a clone? Re-run the same npx command — it
fetches the latest each time.

## Semantic recall

With `--with-embeddings` (~153 MB total), memory is searched by **meaning as
well as by keyword**: a small embedding model (bge-small-en-v1.5, 384 dims)
runs locally, vectors live in the same SQLite file, and results are ordered by
cosine similarity with keyword hits appended for exact identifiers.

This is the difference it makes — the query below shares **no content words**
with the memory that answers it, so keyword search alone returns nothing useful:

```text
query : "offline setup preference, avoid internet services"
result: User want all tooling local, portable, no installers, no admin,
        no cloud. Only network call = frontier model.
```

Quality is a measurement, not a claim:

```bash
node tests/recall-eval.mjs     # paraphrase queries -> expected memories
```

Memories are embedded when written, and any written before embeddings were
installed are backfilled automatically on the next recall.

## Does it actually save context?

`amalgam stats` reports only measured quantities, so the premise can be
checked rather than asserted:

```text
tool              calls    returned (est. tokens)   note
digest            2        1292                     input 14515 tok -> 1292 tok (91% smaller, measured)
memory_recall     1        330                      context loaded locally instead of by reading files
```

Reduction percentages are real before/after measurements on actual calls.
Everything else is reported as *volume*, not savings — no counterfactual was
run, so those numbers are evidence of use, not proof of benefit.

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

## Work streams (parallel work, and cleaning up after it)

With AI you often have several things in flight. Each one can get its own
**stream** — a git worktree plus branch — so builds, edits, and test runs
never collide, including with the checkout you have open yourself.

```bash
amalgam stream new automation-tab --repo C:\path\to\repo --purpose "fix automation panel"
# -> creates ..\repo-automation-tab on branch stream/automation-tab
```

Because compiled worktrees are expensive (a C++ build dir is gigabytes),
streams are designed to be **reclaimed**, not accumulated:

```bash
amalgam stream list        # every stream + why it is (or isn't) reclaimable
amalgam stream done <name> # "I evaluated this" -> now reclaimable
amalgam stream gc          # print the reclaim plan (nothing is deleted)
amalgam stream gc --yes    # execute it
amalgam stream drop <name> # remove one now
```

`gc` applies four policies, in this order:

| Situation | Action |
|---|---|
| Real uncommitted changes | **kept** — never auto-removed |
| Pinned (`--pin`, e.g. a nightly job's warm build dir) | **kept** |
| Branch merged into base | worktree removed, merged branch deleted |
| Marked `done` but unmerged | worktree removed, **branch kept** (commits survive) |
| Stale (no commits in N days, default 14) but still open | **build dirs freed only**, code kept |

Build output never counts as "dirty" (otherwise every compiled worktree
would be unreclaimable forever), but any real untracked or modified file
does. `--builds-only` reclaims space without removing worktrees;
`--max-age-days N` tunes staleness.

## MCP tools

| Tool | Layer | Purpose |
|---|---|---|
| `memory_recall` | L1+L2 (+L0) | Ranked full-text search; primary context loader |
| `memory_save_fact` | L1 | One distilled fact/preference/decision per call; checks the fact's paths and reports likely duplicates |
| `memory_supersede` | L1 | Mark older facts replaced by a newer one — history kept, recall cleaned |
| `task_start` / `task_note` | — | Open a work item; record decisions, blockers, test results, commits against it |
| `task_resume` / `task_done` | — | Pick work back up in one read, or close it without losing its history |
| `memory_log` | L0 | Verbatim conversation audit trail |
| `memory_context_write/read/list` | L2 | Durable per-project scenario docs |
| `memory_persona_read/write` | L3 | Stable user profile |
| `digest` | — | Read a large file or command output and return only a dense digest — the raw text never enters the agent's context (needs the optional model) |
| `caveman_compress/expand` | — | Dense↔readable translation (needs the optional model) |
| `graph_query` | — | graphify explain/path/query/build per repo |
| `code_context` | — | Evidence packet for a task: the symbols that matter, their callers, and their current source — instead of whole files |
| `graph_impact` | — | Blast radius of a diff: which symbols changed and everything that calls them |

### The graph as an index, not a document

`amalgam graph` builds the graph and then imports it into the same SQLite file
memory lives in. graphify stays the extractor — this project has no business
owning a tree-sitter pipeline — but a JSON document is a poor query surface: it
is parsed in full for every question, it can only be searched by the words
already written in it, and there is nowhere to keep anything learned about it.

Indexed, each symbol carries its signature **and the comment block above it**,
embedded with the same local model memory uses. That is what lets a question
find code phrased differently from it:

```text
"guard against empty passwords before requests are routed"
   -> validateSession()      (shares not one word with the query)
   name-only search          -> nothing
```

Re-importing keeps the vectors of symbols that did not change, so a rebuild
embeds only what moved — on this repo, a no-op rebuild re-embeds nothing at
all. Ranking is cosine first, then two mild corrections: a question about
behaviour is usually answered by something callable, and by something other
code actually reaches.

Speed is not the reason to do this. At 222 KB the document parses in 3.7 ms
against the index's 2.5 ms — worth having at scale, not worth mentioning at
this size. The reasons are the search by meaning, the incremental embedding,
and having one store rather than two.

### Edges you can believe

A call graph built from names cannot see scope. `resolve` inside
`new Promise((resolve, reject) => …)` is a parameter, and `x.parse()` is
someone else's method, but both look exactly like calls to a same-named export
elsewhere in the project. So edges get the same treatment as symbol text: the
graph proposes, the working tree decides. Each edge records its call site, and
that line is read before the edge is reported —

| verdict | meaning |
|---|---|
| confirmed | a bare call to the name sits on the recorded line |
| moved | not there, but the call exists elsewhere in the file — the graph is behind, the relationship is real |
| shadowed | a parameter, a local binding, or a method on something else — a false positive |
| absent | no such call anywhere in the file — a dead edge |

Shadowed and absent edges are dropped rather than shown with a caveat: a caller
list is read as a list of places to go and look, so a wrong entry costs exactly
the wasted read this is trying to avoid. On this repo that removes 4.4% of
caller edges. It also means a stale graph degrades honestly instead of
confidently pointing at code that has moved.

### Never read a build log

The most reliably wasteful exchange in agentic development: a command prints
two thousand lines, nine of them matter, and all two thousand are pasted into
the conversation so the model can find the nine — several times per task, at
frontier prices.

`run_check` runs the command and returns the exit code and the failures,
**byte for byte**. Fidelity is the point rather than brevity: an error message
with a paraphrased line number sends someone to the wrong place with
confidence, so nothing here is ever summarised by a model. Compilers and test
runners announce failures in formats a regular expression reads perfectly —
tsc, cargo, pytest, go test, make, jest and friends — and output nobody
recognises falls back to the tail verbatim rather than being guessed at.

```bash
amalgam check "npm test"
```

```text
$ npm test --silent
exit 0 · 188 lines of output · 34.1s · passed
4/4 passed
all checks passed …

(7768 characters of output, 7584 of them not printed)
```

Two details worth knowing, both found by the tests rather than by design: the
streams are captured separately, because merged into one buffer they interleave
by arrival and a failure ends up hundreds of lines from its own explanation;
and a timeout kills the whole process tree, since killing the shell leaves the
test runner underneath it happily hanging.

### Is it done, or just marked done?

A pile of merged stories is not a finished application, and the difference is
evidence. `amalgam trace` reads the planning layer's own artifacts — a spec
declares its acceptance criteria, the files it expects to touch, and the
commands that confirm it; sprint status carries the ids and states — and
reports which stories can be shown to work.

```bash
amalgam trace            # what each story declares
amalgam trace --verify   # actually run each story's own checks
```

The number that matters is the last one: **stories marked done that declare no
way to check them.** A spec still wearing its template placeholders counts as
having declared nothing, and a story naming files that no longer exist is
reported as drifted.

It will not tell you an acceptance criterion is met. Nothing here reads English
well enough to know that a passing command proves "given an expired token, then
the user is asked to sign in again", and a tool implying otherwise manufactures
exactly the false confidence it exists to remove.

### Starting in a codebase nobody here wrote

Describing an unfamiliar system is one job — and one the planning layer already
does. Working out which parts of it are *dangerous* is a different question,
and not one you read: churn from git, dependents from the code graph, and
whether any test reaches it at all.

```bash
amalgam survey                  # riskiest files, hidden seams, where to start
amalgam survey --run-checks     # and whether the project even builds
```

Risk is churn **times** dependents, because either alone is survivable and the
product is what "we cannot change this" is made of. The output that earns its
place is the intersection with no tests — the characterization tests to write
*before* touching anything — followed by the safest place to make a first
change, so an agent's first contribution is verifiable before anyone trusts it.

Pointed at this repository it reported, correctly and unwelcomely, that
`bin/amalgam.mjs` has thirty commits and no test reaching it, and that it
changes together with `mcp/server.mjs` ten times over — every capability has to
be registered in both places.

### What parallel work is about to do to itself

Streams make parallel development possible; nothing watched what happened
between them. The interesting failure is not the conflict git reports. It is
the merge that succeeds while one stream changed what a function returns and
another wrote new callers of it — both suites green in isolation, both wrong
together.

Git compares text and cannot see that. The graph knows who calls what:

```bash
amalgam collide
```

```text
COLLISION  tighten-auth + cache-auth — both change: validateToken (src/auth.js)
           A clean merge here is the dangerous case: both tested green apart.
order      tighten-auth before audit-api — audit-api calls validateToken, which tighten-auth changes

Merge order: cache-auth -> report-format -> tighten-auth -> audit-api
```

Streams changing disjoint code are reported as exactly that and nothing else —
a detector that cries wolf on independent work is ignored within a day. A cycle
is reported as *entangled*: two streams that cannot be sequenced and must be
integrated together, which is worth knowing before the merging starts.

### Let the cheap tools rule first

Asking the expensive model "is this change right?" pays frontier prices for a
question a type checker answers for free. Most of what such a review returns is
not judgement at all — an unused import, a broken test, a signature that no
longer matches — and every one of those is settled locally, deterministically,
in seconds.

`amalgam gate` runs the project's own checks, found from package.json,
Cargo.toml, go.mod, pytest or a Makefile, cheapest first so a two-second type
error does not wait behind a four-minute suite. What passes is never mentioned
again; what fails comes back verbatim, and only that is worth a model's
attention.

```bash
amalgam gate --list     # what it detected
amalgam gate            # run them, stop at the first failure
```

```text
gate: passed — 1 check(s)
  pass  test       26.9s

Nothing needs review that a local check could settle.
```

A project that disagrees with the detection says so once, in package.json:

```json
{ "amalgam": { "checks": [{ "name": "ci", "command": "make verify" }] } }
```

### The injected block is ordered for caching

Everything the session hook prints sits at the front of every conversation on
the machine, where prompt caching matches on exact prefixes. So the directives
— identical every time — come first and are never interpolated with anything,
and every varying part (proposals waiting, streams to reclaim) is appended
after them. One session-dependent character in the wrong place would invalidate
that prefix for every session, so `tests/hook-eval.mjs` asserts the static half
is byte-identical under different state.

### Recall spends a budget, not a count

Asking for "eight memories" controls neither cost nor redundancy. Eight terse
facts and eight long ones differ by an order of magnitude in the thing this
project exists to conserve, and a store written to for months accumulates
memories that say nearly the same thing — so the head of a ranked list can be
four phrasings of one answer while the fact that would have completed the
picture sits fifth.

Recall now selects rather than slicing. Candidates are taken in rank order
while they fit a character budget (`budget_chars`, 6000 by default), and one
that is ≥0.93 cosine to something already chosen is dropped as redundant —
measured against the selection, never against the query, since two memories can
both answer it well and still be the same memory twice.

What was left out is always stated, because a silently truncated answer reads
exactly like a complete one:

```text
(1 near-duplicate(s) omitted; 4 more matched, past the 6000-character budget)
```

### Capture that does not depend on remembering

Memory only pays for itself if things get written to it, and the original
design asked the agent to do that at the end of a session — precisely when its
context is most exhausted and its attention is on finishing. Predictably, the
raw layer sat empty for weeks.

A SessionEnd hook now writes the session's own record, in two tiers so that a
machine with no model download still gets the useful half:

- **always** — the conversation's turns are logged to L0 (tool traffic
  dropped: it is the bulk of a session and the least durable part of it);
- **with the local model** — a detached child distils that transcript into
  candidate facts, asking specifically for what stays true rather than what was
  happening at the time.

The timing is deliberate: the cheap half runs inside the hook, the slow half is
handed to a background process and forgotten, so nothing can delay a session
ending and nothing it fails at can prevent one.

**Candidates are proposals, never memories.** Writing unattended model output
straight into long-term memory would poison the store everything else depends
on — a wrong fact recalled with confidence is the most expensive failure this
project has. They wait for review, and the next session is told they are
waiting:

```bash
amalgam memory pending          # what the last session proposed
amalgam memory accept 3 4       # into memory, verified on the way in
amalgam memory reject 5         # or not
```

A 4B model padding four near-identical lines out of a thin session is exactly
the behaviour the review step exists for.

**What it stores, and for how long.** Capture changes what this store is: from
the things somebody chose to keep, to everything that was said. That is a
reasonable default for a local single-user tool and an unreasonable one to
impose, so:

- turns are **redacted on the way in** — private key blocks, API keys, GitHub
  and Slack tokens, AWS key ids, JWTs, `Authorization:` headers, URL
  credentials, and any assignment whose name announces a secret
  (`*_TOKEN`, `*_PASSWORD`, `*_SECRET`, …). There is deliberately no general
  high-entropy rule: it would eat commit hashes and digests, and a log full of
  `[redacted]` is its own kind of useless. This catches known shapes, not
  everything — it is a safety net, not a guarantee;
- the raw layer is **capped and aged out** — 30 days and 5,000 turns by
  default (`AMALGAM_L0_DAYS`, `AMALGAM_L0_MAX_ROWS`), pruned on every write;
- it can be **turned off entirely** with `AMALGAM_CAPTURE=off`, and deleted at
  any time with `amalgam memory forget --all`, which never touches distilled
  facts.

### The model does not sit there

Lazy start was only half the bargain: a model that loads on demand and then
holds 3.6 GB until the machine reboots costs more than one that started
eagerly, because the cost is invisible — no session mentions it and nobody
thinks to run `amalgam stop` hours later.

Every model call now stamps a use file, and starting the server also starts a
detached watchdog that shuts it down after 15 minutes idle
(`AMALGAM_LLAMA_IDLE_MIN`, `0` to disable). The watchdog exits on its own when
the server is gone, so an idle machine ends up running neither. `amalgam
status` shows how long the model has been idle and when it will go.

### Keeping a memory honest

A store that answers quickly and confidently with last month's truth is worse
than one that answers nothing, because the mistake is paid for twice: once when
it is read, again when it is corrected. Two mechanisms guard against it, and
neither asks a model whether a memory is true.

**Supersession.** When a fact replaces an older one, say so — `memory_supersede`
records the edge, the old row leaves recall, and `include_superseded` brings the
history back when it is the history you want. `memory_save_fact` compares each
new fact against the stored vectors and reports anything close enough to be the
thing it replaces, which costs a dot product per row and no model call.

**Verification.** Prose needs a judge, but the anchors inside a fact — paths,
above all — are checkable for free. Facts are checked as they are written and
re-checked by `amalgam memory verify`; a fact whose paths have vanished is
shown in recall with `!stale` beside it rather than hidden, because it is
sometimes still the only answer. `unknown` stays distinct from `ok`, so a fact
that could not be checked is never presented as one that passed.

```bash
amalgam memory verify     # re-check every live fact against this machine
amalgam memory stale      # just the ones whose paths have gone
amalgam memory history    # what replaced what
```

### Work items: resuming without re-deriving

Each part of this stack knows one thing and none of them know each other. BMAD
holds the story, git holds the branch, a work stream holds the worktree, memory
holds the facts, the test run holds the verdict. Resuming yesterday's work
means rediscovering all five — a research task at frontier-model prices, every
time.

A task is a thin thread through them. It does not plan or replace a story; it
records which story, which branch, which stream, and what happened, so "where
was I" is a lookup. Events are append-only, because the useful question is
almost always *what did I already try*.

```bash
amalgam task new "Rework session token validation" --story API-42
amalgam task note 1 "reject empty tokens at the edge, not per handler" --kind decision
amalgam task note 1 "unit 41/41, integration needs a fixture user" --kind test
amalgam task show 1        # coordinates, history, and what was learned
```

The agent has the same store through `task_start` / `task_note` / `task_resume`,
and `amalgam brief` lists what is open — so the thread survives whichever end of
it you pick up. Facts saved with a `task_id` come back with the task.

### Evidence instead of files

An agent that needs to change existing code usually reads the files around it,
which is the most expensive possible way to learn two things: where a symbol is
defined, and what depends on it. The graph already knows both.

So `code_context` splits the job. The graph decides **which** lines matter; the
working tree supplies **what** they say. That division is what makes a stale
graph tolerable: a symbol that moved is found by name, a symbol that was
deleted is reported missing rather than quoted from a stale snapshot, and the
answer says how far behind the graph is. Nothing is ever quoted from the index
itself.

Measured on this repository, three ordinary "change existing code" tasks:

```text
task                                             packet   files it replaces
change how supersede candidates are scored        2,786   34,676   (-92.0%)
fix how fact anchors are verified                 2,876    3,385   (-15.0%)
adjust recall ranking across both legs            3,052   45,540   (-93.3%)
                                                  8,714   83,601   (-89.6%)
```

The middle row is the honest one: against a small file a packet saves almost
nothing, and reading the file is the better move. The win scales with the size
of what you would otherwise have read, which is why the tool reports what it
selected rather than pretending to be right every time.

### Where the local model actually helps

The original idea was to translate the agent's prose to and from "caveman" to
save tokens. That turned out to be the weaker half: MCP tools return data
*into* the agent's context, so compressing text after a tool already returned
it saves nothing, and the agent can write densely by itself for free.

`digest` is the shape that pays. Bulk text is read and reduced **here**, so
only the digest crosses into the agent's context — measured at 91% smaller on
a 58 KB source file (14,515 → 1,292 tokens), with the file itself never
entering context. Reach for it before reading a long log, spec, or dump.

## Non-Windows machines

The MCP server and CLI are cross-platform, but the pinned runtime downloads
are Windows zips. On Linux/macOS place equivalents manually, then use
normally:

- llama.cpp build for your platform → `~/.amalgam/runtime/llama/`
- the same GGUF model → `~/.amalgam/models/`

## Env overrides

`AMALGAM_HOME` (default `~/.amalgam`), `AMALGAM_PG_PORT` (5455),
`AMALGAM_LLAMA_PORT` (8642), `AMALGAM_PSQL`, `AMALGAM_LLAMA_URL`,
`AMALGAM_SESSION_ID`.

## Credits

- Caveman skill © Julius Brussee, MIT — vendored from
  [juliusbrussee/caveman](https://github.com/juliusbrussee/caveman)
- Concepts: [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
  (layered memory), [Graphify](https://github.com/Graphify-Labs/graphify)
  (code graphs), [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)
  (skill orchestration)
