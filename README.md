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
          PostgreSQL 17       llama.cpp + Qwen3-4B   graphify (via uv)
          portable, :5455     portable CPU, :8642    tree-sitter, no LLM
          L0 log / L1 facts   caveman_compress       graph explain/path/query
          L2 scenarios        caveman_expand
          L3 persona
```

## Requirements

- **Node 18+** (the only hard prerequisite)
- Windows x64 fully supported; Linux/macOS need manual runtime placement (see below)
- Optional: [uv](https://docs.astral.sh/uv/) for graphify code-graph queries
- ~3 GB disk in `~/.amalgam` (runtimes + model), no admin rights needed

## Install (per machine, once)

```bash
git clone https://github.com/papatemporal/amalgam.git
cd amalgam
node bin/amalgam.mjs install     # downloads runtimes + model into ~/.amalgam
node bin/amalgam.mjs start       # starts PostgreSQL + llama-server
```

Optionally put `bin/` on PATH or use `npx github:papatemporal/amalgam` (works
with your git credentials; repo can stay private).

### Behind a proxy? Everything is on the release page.

Every runtime and the model are published as **release assets on this repo**
(see [Releases](https://github.com/PapaTemporal/amalgam/releases)), so a
machine that can reach github.com needs no other host. The installer tries,
in order: release asset via `gh` CLI → release asset via token
(`AMALGAM_GITHUB_TOKEN` or `GITHUB_TOKEN` env var) → the external URLs below
via `curl` (which honors `HTTP_PROXY`/`HTTPS_PROXY`).

**No gh, no token? Use your browser** (works for this private repo while
logged in to GitHub): open the release page, download the assets, save them
to the paths below, then re-run `amalgam install`:

| Release asset | Save to |
|---|---|
| `llama-cpu-x64.zip` (~90 MB) | `~/.amalgam/downloads/llama-cpu-x64.zip` |
| `postgresql-17.5-1-windows-x64-binaries.zip` (~300 MB) | `~/.amalgam/downloads/postgresql-17.5-1-windows-x64-binaries.zip` |
| `Qwen3-4B-Instruct-2507-Q4_K_M-00001-of-00002.gguf` (~1.8 GB) | `~/.amalgam/models/` (same filename) |
| `Qwen3-4B-Instruct-2507-Q4_K_M-00002-of-00002.gguf` (~0.6 GB) | `~/.amalgam/models/` (same filename) |

The model is a llama.cpp **split GGUF** — download both parts, no
reassembly; llama-server loads part 1 and finds part 2 itself.

External fallbacks (public hosts, used automatically when the release is
unreachable): llama.cpp from
<https://github.com/ggml-org/llama.cpp/releases> (tag b10532), PostgreSQL
from <https://get.enterprisedb.com/postgresql/>, and the model as a single
file from
<https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf>
(mirror: swap `huggingface.co` for `hf-mirror.com`) saved to
`~/.amalgam/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` — the single file
works exactly like the split pair.

Already have the files on another machine? Copy them over and pass
`--cache <dir>`, or drop them straight into the destinations above — the
most proxy-proof option of all.

## Wire a project (per project)

```bash
cd your-project
node /path/to/amalgam/bin/amalgam.mjs wire            # both agents
node /path/to/amalgam/bin/amalgam.mjs wire --claude   # Claude Code only
node /path/to/amalgam/bin/amalgam.mjs wire --copilot  # VS Code Copilot only
```

- **Claude Code**: writes `.mcp.json` (server `amalgam`) and copies the
  `offload` + `caveman` skills into `.claude/skills/`.
- **Copilot**: writes `.vscode/mcp.json` (agent-mode MCP) and appends a
  marker-fenced guidance block to `.github/copilot-instructions.md`.

Both merge — existing config in those files is preserved.

## Daily use

```bash
node bin/amalgam.mjs start    # after reboot; idempotent
node bin/amalgam.mjs status   # health check
node bin/amalgam.mjs stop
```

Build a code graph once per repo (queries are then instant and local):

```bash
cd your-repo
uv tool run --from graphifyy graphify . --code-only
```

`--code-only` matters: it keeps graphify on its local tree-sitter path — the
docs/media pass would call a cloud LLM, which this stack forbids.

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
| `caveman_compress/expand` | — | Local Qwen3-4B dense↔readable translation |
| `graph_query` | — | graphify explain/path/query/build per repo |

## Non-Windows machines

The MCP server and CLI are cross-platform, but the pinned runtime downloads
are Windows zips. On Linux/macOS place equivalents manually, then use
normally:

- llama.cpp build for your platform → `~/.amalgam/runtime/llama/`
- PostgreSQL binaries → `~/.amalgam/runtime/pgsql/` (so `bin/psql` exists)
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
