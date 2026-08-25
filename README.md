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

![A project dashboard, with a composed prompt ready to run](docs/images/flow.png)

*The optional interface: everything about one codebase on one page, and a
prompt that arrives already carrying the project's graph status, real check
command, open work, and what memory holds.*

## The measured version

There are two optional downloads and they buy different things, so here is
what each one is actually worth. Everything structural works with neither.

| Instead of | You get | Nothing installed | Embeddings (~220 MB) | Both (~2.7 GB) |
|---|---|---|---|---|
| Pasting a test run into the chat | The exit code and the failing lines, byte for byte | **22,738 → 105 chars** | same | same |
| Grepping for what a diff affects | The symbols it touched and everything calling them | **96% smaller** | same | same |
| Reading the files around a function | The symbols that bear on the task, their callers, their current source | **97% smaller** | same size | same size |
| Searching code by intent rather than by name | The right symbol in the top five | **0 of 12** | **5 of 12** | **5 of 12** |
| …and in the top three | Less to read before you find it | 0 of 12 | 3 of 12 | **5 of 12** |
| Recalling what you decided months ago | The facts that bear on it | by keyword | **by meaning** | by meaning |
| Reading a long log to summarise it | A digest, made locally | — | — | **91% smaller** |
| Opening a graph of an unfamiliar codebase | Neighbourhoods with names, not numbers | numbered | numbered | **named** |
| Ending a session | Durable facts proposed for review | — | — | **automatic** |

**Nothing installed** is not a crippled mode. The three reductions at the top
are structural — they come from sending symbols instead of files, and an exit
code instead of a log — and they do not improve by a single character when you
add a model. On a machine with no downloads at all, amalgam still replaces file
reads with evidence packets and test logs with their failures.

**The embedding model is the one to install.** It is the difference between
searching by name and searching by description: without it a question phrased
as intent finds nothing at all, and with it the right symbol is in the top five
of twelve tries. It does the same for memory, which falls back to keyword
search without it.

**The local model is a convenience, not a retrieval upgrade.** It moves answers
up the list rather than finding more of them — top-five is unchanged at five of
twelve, top-three goes from three to five. What it genuinely adds is elsewhere:
digest, naming the neighbourhoods in a graph, and proposing facts at the end of
a session. If disk is tight, skip this one.

### What it was measured against

Two codebases, because a saving measured on a small one proves very little.

| | | |
|---|---|---|
| **amalgam** | 759 symbols, 1,702 edges, JavaScript | retrieval accuracy, check output, blast radius |
| **MuseScore** | 95,826 symbols, 203,910 edges, C++ | packet size at scale |

Retrieval accuracy is measured on amalgam only, and that is a limitation worth
stating rather than glossing: the twelve questions have a known right answer
because the codebase is one I can vouch for. The same benchmark against
MuseScore would need twelve questions whose correct answer I could defend, and
I cannot.

### One question, in full

The task is `where does the score get written to a file`, asked of MuseScore.
Answering it by reading the files the relevant symbols live in is **two files,
380,924 characters**. What gets sent instead is **2,288** — a 99.4% reduction,
and the top of it looks like this:

```
--- writeMxlArchive  src/importexport/musicxml/internal/musicxml/export/exportxml.cpp:6829
--- saveMxl  src/importexport/musicxml/internal/musicxml/export/exportxml.cpp:6852
bool saveMxl(Score* score, IODevice* device)
{
    muse::ZipWriter zip(device);

    //anonymized filename since we don't know the actual one here
    String fn = u"score.xml";
    writeMxlArchive(score, zip, fn);
    zip.close();

    return true;
}
--- .writeScore  src/engraving/api/v1/engravingapiv1.h:290
--- EngravingApiV1  src/engraving/api/v1/engravingapiv1.h:42
```

Five symbols, each with the file and line it is at now and the source as it
currently reads — not as the index remembers it. A second question, *how is a
chord laid out on the staff*, replaces four files and 504,596 characters with
3,883: 99.2%.

Neither number needs a model. The embedding model is what turned an
English question into those five symbols; without it the same question matches
on names and finds nothing, which is the zero in the table above.

### On these numbers

Measured on 2026-08-25 with `amalgam stats` and `bench/code-search.mjs`, which
prints all three configurations in one run so the table can be checked against
it. A measured claim is a claim about a moment, exactly like a code graph: an
earlier version of this table said ten of twelve, which was true when written
and stopped being true as the repository grew by a hundred and eighty symbols.
Re-run both and you will get today's numbers rather than these.

`amalgam stats` counts a saving only where a real counterfactual exists: a
packet knows the files it replaced, a digest knows what it consumed. Recall
claims nothing, because measuring it would mean running the alternative.

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
