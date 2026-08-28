# Installing and wiring

Everything in this file is a one-time setup concern. If you just want to get
going, [Getting started](getting-started.md) is the shorter road; come back
here when something needs configuring.

**Or do none of it by hand.** `amalgam ui` runs the same steps as a wizard and
shows each one as it happens:

![Choosing what to install](images/setup.png)

![The machine set up](images/setup-machine-done.png)

The commands below are what those buttons run.

## Requirements

- **Node 22.5+, built with SQLite's FTS5** — the one hard prerequisite, and the
  one thing you supply yourself (see below)
- Optional: [uv](https://docs.astral.sh/uv/) for graphify code-graph queries
- Optional: the local model (~2.5 GB, Windows x64) for `digest` and `caveman_*`
- Default install writes a few hundred KB and needs no admin rights

### Node, and why the version is only half of it

The memory store is SQLite through Node's built-in `node:sqlite`, which arrived
in 22.5. It indexes every fact, scenario and log line with **FTS5** — and FTS5
is a *compile-time* option, so whether a given Node has it depends on who built
that binary, not on how new it is. Homebrew's Node does not. Checking the
version therefore proves nothing, and a machine missing FTS5 used to install
cleanly and then fail at its first memory write with `no such module: fts5`.

`amalgam` now checks the capability itself and stops with instructions. To see
what your Node has:

```bash
node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(a)')"
```

Silence means you have it. **The official builds on nodejs.org have it**, and
they need no installer, no administrator and no package manager — they are
plain archives you extract wherever you can write:

| Platform | Archive |
|---|---|
| Windows x64 / arm64 | `node-v22.23.2-win-x64.zip` · `-win-arm64.zip` |
| macOS arm64 / x64 | `node-v22.23.2-darwin-arm64.tar.gz` · `-darwin-x64.tar.gz` |
| Linux x64 / arm64 | `node-v22.23.2-linux-x64.tar.xz` · `-linux-arm64.tar.xz` |

All from <https://nodejs.org/dist/v22.23.2/>. Extract, then run amalgam with
that binary **by full path** — no PATH edit, no shell profile, nothing that
depends on whether you use zsh, bash, fish, PowerShell or cmd:

```bash
node-v22.23.2-darwin-arm64/bin/node bin/amalgam.mjs install
```

You only do that once. `amalgam wire` and `amalgam shim` record the absolute
path of whichever Node ran them, so the MCP server, the session hooks and the
`amalgam` command all use that same runtime afterwards without PATH being
involved. Re-running `wire` repoints anything an older install left behind.

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

## Typing `amalgam` instead of `node bin/amalgam.mjs`

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

## Behind a proxy?

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

## Workspace layout (where BMAD goes)

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

### What an update does not bring with it

`amalgam update` pulls, re-deploys and re-wires. That is the whole story for
**code** — and it assumes a clone is already there to pull into. A machine that
has never had amalgam on it starts from the install above instead.

Everything else lives on the machine rather than in the repository:

| | | |
|---|---|---|
| The agent CLI, and being signed into it | `npm install -g @anthropic-ai/claude-code`, then `claude` once | reported |
| — unless you use Copilot | nothing: `amalgam wire --copilot` already put these tools in it | reported |
| The embedding model and the local model | `amalgam install --with-embeddings --with-model` | reported |
| The interactive graph's drawing library | `amalgam vendor-graph` — one 686 KB copy, then it never needs the network | reported |
| A code graph and its diagram, per repository | `amalgam graph --label`, or **Rebuild** in the interface | reported |
| **Which projects you have** | carried by `amalgam transfer`, or add them again | |
| **What memory knows** | `amalgam transfer export` here, `import` there | |
| **What a rebuild costs here** | `amalgam update --build` | reported |
| **Which model runs which task** | carried by `amalgam transfer`, or turn it on in **Setup** | |

The rows marked *reported* are the ones `amalgam update` checks for when it
finishes. It fixes what it can without being asked — the graph's drawing
library is a 686 KB download that behaves identically afterwards, so it just
does it — and for the rest it prints the single command that would close them:

```
Most of that is one command:  amalgam update --with-embeddings --build
```

The line is consent, not cost: fetching 2.5 GB or spending four minutes
rebuilding a graph is your machine's time, and that gets a flag rather than a
surprise. A machine with nothing outstanding says so in one line.

**Memory travels in a bundle.** Facts, scenarios, your persona, the review
queue, your project list and your routing settings live on the machine, not in
the repository. On the machine you are leaving:

```bash
amalgam transfer export ~/amalgam-bundle
```

Copy the folder over, and on the other machine:

```bash
amalgam transfer import ~/amalgam-bundle
```

An empty machine takes it whole, including the supersede history that records
which corrections replaced what. A machine that already has facts of its own
**merges** instead — importing never deletes what was already there — skipping
anything it already knows, and saying so. The review queue and the raw log do
not merge, only live facts, and it tells you that rather than dropping them
quietly.

The bundle is small on purpose. The code index shares that SQLite file, and on
the machine this was written on it is 97,918 symbols and 206,151 edges with
their vectors — 341 MB of something entirely derived from repositories that
are not on the other machine anyway. It stays behind, along with this machine's
own savings measurements, leaving 848 KB to carry.

A fact naming a path that exists only on the first machine will be flagged as
stale on the second. That is the check working, not a problem to fix.

**Automatic refresh stays asleep until you build once.** How long a rebuild
takes is recorded per machine, because machines differ — so a repository set
up somewhere else arrives with a graph and no idea what refreshing it would
cost, and the policy will not start work whose cost it does not know. One
`amalgam graph` per repository teaches it, and from then on that repository
keeps itself current. Until then the update report lists it as *"never built on
this machine, so it will never refresh itself"*.

One case is worth calling out: a repository whose graph was built by a version
with the indexing bugs in it has a `graphify-out/graph.json` on disk and
nothing behind it in the index. It looks fine from the outside and reports no
symbols. Rebuilding is the fix, and the update report names those repositories
rather than leaving you to notice.

The interface can do all of this too. `amalgam ui` → **Setup** has an update
button that runs exactly the command above, and a chip in the sidebar goes
amber when the deployed copy is behind your clone. Because the built pages are
committed to the repository, an update updates the interface along with
everything else — so the terminal is needed for the first install and optional
after it.

## Non-Windows machines

The MCP server and CLI are cross-platform, but the pinned runtime downloads
are Windows zips. On Linux/macOS place equivalents manually, then use
normally:

- llama.cpp build for your platform → `~/.amalgam/runtime/llama/`
- the same GGUF model → `~/.amalgam/models/`

---

Set up? [Getting started](getting-started.md) is the next page.
