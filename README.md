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

### Behind a proxy?

`install` downloads with system `curl`, which honors `HTTP_PROXY` /
`HTTPS_PROXY`. If a download still fails, the installer prints this manual
list — fetch each file by hand, place it at the destination, re-run `install`:

| File | URL | Save to |
|---|---|---|
| llama.cpp CPU build (~90 MB) | <https://github.com/ggml-org/llama.cpp/releases/download/b10532/llama-b10532-bin-win-cpu-x64.zip> | `~/.amalgam/downloads/llama-cpu-x64.zip` |
| PostgreSQL 17.5 portable (~300 MB) | <https://get.enterprisedb.com/postgresql/postgresql-17.5-1-windows-x64-binaries.zip> | `~/.amalgam/downloads/postgresql-17.5-1-windows-x64-binaries.zip` |
| Qwen3-4B-Instruct Q4_K_M (~2.4 GB) | <https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf> | `~/.amalgam/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` |

**huggingface.co blocked?** The installer automatically falls back to the
mirror <https://hf-mirror.com> (same URL path, different domain). It also
works manually: swap `huggingface.co` for `hf-mirror.com` in the model URL
above.

Already have the files on another machine? Copy them over and pass
`--cache <dir>`, or drop them straight into the destinations above — the
most proxy-proof option of all. (This machine keeps copies in
`~/.amalgam/downloads/` and `~/.amalgam/models/` for exactly that.)

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
