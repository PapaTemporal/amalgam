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

Every example below writes `amalgam` for brevity. To make that a real command,
pick whichever suits you:

- **A shell alias** — nothing installed, works immediately.
  PowerShell (add to `$PROFILE`) — **the `@args` is required**:
  ```powershell
  function amalgam { node C:\path\to\amalgam\bin\amalgam.mjs @args }
  ```
  Without `@args` the function silently drops everything you type, so
  `amalgam wire --user` reaches the tool as no arguments at all and you get
  the usage screen instead. `Set-Alias` cannot forward arguments either — it
  has to be a function.
  bash/zsh (add to your rc file):
  ```bash
  alias amalgam='node /path/to/amalgam/bin/amalgam.mjs'
  ```
- **An npm shim** — run `npm link` inside the clone. It writes `amalgam` /
  `amalgam.cmd` into your **user** npm directory (`%APPDATA%\npm` on Windows),
  so it needs no admin rights.

Adding `bin/` to your PATH does *not* work: the file is `amalgam.mjs`, and
Windows will not execute a `.mjs` directly. Otherwise just keep typing
`node bin/amalgam.mjs …` — every example works that way too.

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
code/                        <- workspace: BMAD installed HERE
├── _bmad/                   BMAD config, scripts, modules
├── _bmad-output/            PRDs, epics, stories, project docs for ALL services
├── .claude/skills/          bmad-* workflows + amalgam skills
├── MuseScore/               service (cloned repo) — no BMAD inside it
├── pedalboard/              service
└── amalgam-pkg/             service
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
node bin/amalgam.mjs graph    # build/refresh this repo's code graph
```

`amalgam graph` wraps graphify with `--code-only`, which keeps it on its local
tree-sitter path — the docs/media pass would call a cloud LLM, which this
stack forbids.

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
PROJECT  MuseScore  (C:\Users\kinth\code\MuseScore)
GIT      branch main | 3 uncommitted change(s)
         open branches: fix/20260820-paste-midmeasure-barline
STREAMS  none
BMAD     installed | 49 bmad skills | output _bmad-output
GRAPH    built (C:\Users\kinth\code\MuseScore\graphify-out\graph.json)
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
| `memory_save_fact` | L1 | One distilled fact/preference/decision per call |
| `memory_log` | L0 | Verbatim conversation audit trail |
| `memory_context_write/read/list` | L2 | Durable per-project scenario docs |
| `memory_persona_read/write` | L3 | Stable user profile |
| `digest` | — | Read a large file or command output and return only a dense digest — the raw text never enters the agent's context (needs the optional model) |
| `caveman_compress/expand` | — | Dense↔readable translation (needs the optional model) |
| `graph_query` | — | graphify explain/path/query/build per repo |

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
