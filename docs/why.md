# Why amalgam exists

## The problem

An AI coding agent is expensive in a specific and repetitive way. It spends
most of its budget re-deriving things your machine already knows.

Watch a normal session and count what actually crosses the wire:

- It reads three files to find one function, because it does not know where
  things are.
- It pastes two thousand lines of test output so it can find the nine that
  failed.
- It re-learns, for the fourth time this week, that this project vendors its
  dependencies and that the build must work offline.
- It asks you what you were doing yesterday, because the session that knew
  ended.
- It reviews a change that a type checker would have rejected in two seconds.

None of that is thinking. It is lookup, transport and recall — work a laptop
does for free, being paid for at frontier-model prices, several times per task.

## The idea

Spend local compute instead of frontier context.

Everything in amalgam is one of two moves. Either it **answers a question
locally** that would otherwise have been answered by shipping text to a large
model, or it **remembers something** so it never has to be derived twice. The
only network call in the entire system is the frontier model itself.

That constraint is not decoration. It means the whole stack runs on a laptop
with no admin rights, no installers, no daemons, no accounts and no cloud
services. Memory is a single SQLite file. The optional models are two
downloads you can decline.

## What it actually gets you

Measured on this repository, not estimated:

| Instead of | You get | Measured |
|---|---|---|
| Reading the files around a function | The symbols that bear on the task, their callers, and their current source | **89.6% fewer characters** |
| Pasting a test run into the chat | The exit code and the failing lines, byte for byte | **7,768 chars → 184** |
| Re-reading a long document | A dense digest; the raw text never enters context | **91% smaller** |
| Grepping for what a diff affects | The symbols it touched and everything that calls them | **96% smaller** |
| Re-explaining the project each session | Facts that survive, with the stale ones flagged | — |

`amalgam stats` keeps the running total, and only counts a saving where a real
counterfactual exists — a packet knows the files it replaced, a digest knows
what it consumed. Recall claims nothing, because measuring it would mean
running the alternative.

## What it gets you that is not about cost

Cost was the entry point. The parts people end up relying on are the ones that
make the work *correct*:

**Memory that corrects itself.** A fact that a later fact replaced leaves
recall instead of competing with its own correction. A fact naming a path that
no longer exists is flagged before you act on it. Both are cheap, local checks
— no model decides what is true.

**Evidence instead of an index.** The code graph chooses which lines matter;
the working tree supplies what they say. A symbol that moved is found by name,
a symbol that was deleted is reported missing, and nothing is ever quoted from
a stale snapshot. A graph that has fallen behind costs precision, never
correctness.

**A verdict instead of a status column.** `amalgam trace` reports which stories
declare a way to be checked, which pass it, and which are marked done resting
on nothing re-checkable — the number that decides whether a release is real.

**Triage before you touch anything.** `amalgam survey` ranks an unfamiliar
codebase by churn × dependents, names the risky files no test reaches, and
finds the files that change together despite living apart.

**The collision git cannot see.** Two work streams changing the same function
merge cleanly and break behaviour, both suites green in isolation.
`amalgam collide` compares symbols rather than text, and gives you a merge
order.

## What it is not

- **Not a model.** It makes your frontier model cheaper and better informed. It
  does not replace it, and the optional 4B local model is used for reduction
  and ranking, never for writing your code.
- **Not a cloud service.** There is no account, no telemetry, no server. If
  your machine is offline, everything except the frontier model still works.
- **Not a replacement for your workflow.** BMAD (or whatever you plan with)
  keeps owning the process. amalgam supplies memory, evidence and verification
  underneath it.
- **Not magic about correctness.** It will tell you a check passed. It will not
  tell you an acceptance criterion is *met*, because nothing here reads English
  that well, and a tool that implied otherwise would be manufacturing exactly
  the false confidence it exists to remove.

## Honest limits

- The secret redactor in session capture catches known shapes — keys, tokens,
  private keys, credentialed URLs, named assignments. It will not catch a
  password with no recognisable form. If that matters for your work, capture
  turns off with one environment variable.
- Retrieval finds the right symbol in the top five about ten times in twelve on
  our benchmark, and in first place about four. It is a search, not an oracle.
- The risk ranking in `survey` is a heuristic over two measurements. Read the
  reasons it prints, not the order.
- The local model is optional and small. Where it is used, its output is either
  checked (re-ranking only reorders candidates retrieval already found) or held
  for review (session capture proposes facts, never saves them).

## Next

- [Getting started](getting-started.md) — your first hour, greenfield or brownfield
- [The workflow](workflow.md) — how this composes with BMAD into an SDLC
- [Tool map](tools.md) — every command and tool, and when to reach for it
