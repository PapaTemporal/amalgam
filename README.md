# Amalgam

**Your AI coding agent spends most of its budget re-deriving things your laptop
already knows.** Reading three files to find one function. Pasting two thousand
lines of test output to find the nine that failed. Re-learning your conventions
every session. Reviewing a change a type checker would have rejected for free.

Amalgam does that work locally and hands the model the answer.

Fully local, portable, zero installs, zero admin, zero cloud. The only network
call in the system is the agent's own call to the frontier model.

```bash
git clone https://github.com/papatemporal/amalgam.git && cd amalgam
node bin/amalgam.mjs install --with-embeddings
node bin/amalgam.mjs wire --user
node bin/amalgam.mjs shim
```

Then either drive it from a screen:

```bash
amalgam ui          # optional; ships compiled, nothing to build
```

or stay in the terminal: `amalgam graph` in any project, restart your agent
session, and work.

## The measured version

| Instead of | You get | Measured |
|---|---|---|
| Reading the files around a function | The symbols that bear on the task, their callers, their current source | **89.6% fewer characters** |
| Pasting a test run into the chat | The exit code and the failing lines, byte for byte | **7,768 chars → 184** |
| Grepping for what a diff affects | The symbols it touched and everything calling them | **96% smaller** |
| Searching code by guessing names | Search by intent — right symbol in the top five | **10/12, vs 1/12** |

`amalgam stats` keeps the running total, and counts a saving only where a real
counterfactual exists: a packet knows the files it replaced, a digest knows what
it consumed. Recall claims nothing, because measuring it would mean running the
alternative.

## Six ideas it is built on

**Evidence, not files.** The code graph decides *which* lines matter; the
working tree supplies *what they say*. A symbol that moved is found by name, a
deleted one is reported missing, and nothing is ever quoted from a stale index.
A graph that has fallen behind costs precision, never correctness.

**Memory that corrects itself.** A fact replaced by a later one leaves recall
instead of competing with its own correction. A fact naming a path that no
longer exists is flagged before you act on it. Both checks are local, and no
model decides what is true.

**Output that never enters context.** Test runs, builds and long files are read
here and reduced here. What crosses the wire is the exit code and the nine
lines that failed — byte for byte, never paraphrased, because an error message
with a wrong line number sends you somewhere else with confidence.

**Cheap tools rule first.** A type checker answers in two seconds what a review
pays frontier prices to conclude. `amalgam gate` runs the project's own checks
before anything expensive looks at the change.

**Done is a claim that gets checked.** `amalgam trace` reports which stories
declare a way to be verified, which pass it, and which are marked done resting
on nothing re-checkable — the number that decides whether a release is real.

**The collision git cannot see.** Two streams changing the same function merge
cleanly and break behaviour, both suites green apart. `amalgam collide` compares
symbols rather than text, and hands you a merge order.

## Start here

| If you want | Read |
|---|---|
| Why this exists, and what it does not do | **[Why amalgam](docs/why.md)** |
| Your first hour, greenfield or brownfield | **[Getting started](docs/getting-started.md)** |
| How it composes with BMAD into an SDLC | **[The workflow](docs/workflow.md)** |
| Every command and tool, by the question it answers | **[Tool map](docs/tools.md)** |
| The optional interface: wizards, dashboards, metrics | **[The interface](docs/ui.md)** |
| Requirements, wiring, proxies, updating | **[Installing](docs/install.md)** |
| Why each part works the way it does | **[Design notes](docs/design.md)** |

## What it is made of

An amalgamation of four ideas — **BMAD** (skill orchestration),
**TencentDB-Agent-Memory** (L0→L3 layered memory), **caveman** (telegraphic
token compression), **graphify** (code knowledge graphs) — rebuilt to run on a
laptop with no admin rights.

```
Claude Code / Copilot ──stdio──▶ ~/.amalgam/mcp/server.mjs (zero-dep Node)
                                    │
                ┌───────────────────┼─────────────────────┐
                ▼                   ▼                     ▼
          SQLite (built in)   llama.cpp + Qwen3-4B    graphify (via uv)
          one file, no daemon OPTIONAL, :8642     tree-sitter, no LLM
          L0 log / L1 facts   digest, rerank,      graph explain/path/query
          L2 scenarios        session capture
          L3 persona
```

Memory is a single file. The two models are downloads you can decline —
everything still works without them, with keyword search in place of semantic
search and no local reduction.

## Credits

- Caveman skill © Julius Brussee, MIT — vendored from
  [juliusbrussee/caveman](https://github.com/juliusbrussee/caveman)
- Concepts: [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
  (layered memory), [Graphify](https://github.com/Graphify-Labs/graphify)
  (code graphs), [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)
  (skill orchestration)
