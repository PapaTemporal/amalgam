# Design notes

Why each part works the way it does, and what was measured to decide it. None
of this is needed to use amalgam — it is here for the reader who wants to know
whether a claim was tested or merely asserted, and for anyone extending it.

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

## The graph as an index, not a document

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

## Edges you can believe

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

## Never read a build log

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

## Is it done, or just marked done?

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

## Starting in a codebase nobody here wrote

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

## What parallel work is about to do to itself

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

## Let the cheap tools rule first

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

## The injected block is ordered for caching

Everything the session hook prints sits at the front of every conversation on
the machine, where prompt caching matches on exact prefixes. So the directives
— identical every time — come first and are never interpolated with anything,
and every varying part (proposals waiting, streams to reclaim) is appended
after them. One session-dependent character in the wrong place would invalidate
that prefix for every session, so `tests/hook-eval.mjs` asserts the static half
is byte-identical under different state.

## Recall spends a budget, not a count

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

## Capture that does not depend on remembering

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

## The model does not sit there

Lazy start was only half the bargain: a model that loads on demand and then
holds 3.6 GB until the machine reboots costs more than one that started
eagerly, because the cost is invisible — no session mentions it and nobody
thinks to run `amalgam stop` hours later.

Every model call now stamps a use file, and starting the server also starts a
detached watchdog that shuts it down after 15 minutes idle
(`AMALGAM_LLAMA_IDLE_MIN`, `0` to disable). The watchdog exits on its own when
the server is gone, so an idle machine ends up running neither. `amalgam
status` shows how long the model has been idle and when it will go.

## Keeping a memory honest

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

## Work items: resuming without re-deriving

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

## Evidence instead of files

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

## Where the local model actually helps

The original idea was to translate the agent's prose to and from "caveman" to
save tokens. That turned out to be the weaker half: MCP tools return data
*into* the agent's context, so compressing text after a tool already returned
it saves nothing, and the agent can write densely by itself for free.

`digest` is the shape that pays. Bulk text is read and reduced **here**, so
only the digest crosses into the agent's context — measured at 91% smaller on
a 58 KB source file (14,515 → 1,292 tokens), with the file itself never
entering context. Reach for it before reading a long log, spec, or dump.

## Staying current

A session **ends** by writing down what it learned and, if a graph has fallen
behind its code, rebuilding it. That covers everything the session itself did.
It covers nothing that happened *between* sessions — a pull, a branch switch,
work done on another machine, an editor open in another window — and those land
on exactly the state an agent trusts most: an index that answers confidently
and a memory that states facts flatly. A stale index does not give a slower
answer. It gives a wrong one in the same tone as a right one.

So a session **opens** by reconciling rather than assuming. Two questions, both
asked of reality rather than of a cache:

| | Question | Answered by |
|---|---|---|
| the code | is each graph still at the commit it was built from? | the commit id inside the graph, against `HEAD` |
| the memory | do the paths its facts name still exist? | `lib/verify.mjs` |

**It reports; it does not repair.** Rebuilding at session start would either
make somebody wait for their first prompt or change the index underneath a
session already using it. Neither is worth it, because saying *"the graph has
not seen these four files — read them directly"* costs nothing and degrades
precisely: the graph selects which lines, the working tree supplies what they
say. Repair belongs at the end, where nobody is waiting.

**The common case is free.** Almost always nothing has changed, and that answer
comes from comparing two commit ids — with no git process at all, since `HEAD`
is a file and is read as one, falling back to asking git properly whenever the
layout is anything but ordinary. Measured here: 2 ms when current, against
about 650 ms only when a repository has actually moved and there is something
worth naming.

A repository more than forty commits behind is not enumerated. "Read these four
hundred files directly" is not advice anybody can act on, so the advice becomes
*rebuild* — and arriving at it does not cost a walk of every tree in between.

Nothing is said when nothing changed. A notice printed every session stops
being read by the third one.

### A detached child has to leave evidence

The refresh runs detached from the session-end hook with its output discarded,
because nobody wants a rebuild printing into a terminal they have closed. That
silence had a cost: the hook spawned the CLI beside itself under
`AMALGAM_HOME`, the install payload copied `mcp`, `skills`, `lib` and `hooks`
but **not** `bin`, and the child died instantly on `MODULE_NOT_FOUND` with
nowhere to say so.

The feature was broken on every machine from the day it shipped, and every
surface looked correct — because each one reported what the policy *intended*.
`amalgam refresh --plan` would say `WOULD  amalgam-pkg  12s last time`, which
was true, and told you nothing about whether it had ever happened.

So each run now writes down that it ran: when, what it rebuilt, and what went
wrong if anything did. One line, overwritten each time. It exists to
distinguish **"it has never run"** from **"it ran and found nothing to do"** —
states that look identical from outside and mean completely different things.
`refresh --plan` and the Setup card both lead with it now.

The test that was missing is the one that would have caught it: read the paths
the hooks reach for, and assert the install actually put them there. It fails
with `missing: bin` against the original code.

### Timings are per machine, and that has a cold start

A build timing is recorded where the build happened, because machines differ
and another machine's number is not yours. The consequence is that a repository
set up somewhere else arrives on a new machine with a graph and no idea what
rebuilding it costs — so the policy refuses to start it, correctly, and
automatic refresh does nothing at all until somebody builds each repository
once by hand.

That is defensible but it was invisible, which is not. It is now one of the
things **[this machine still needs](ui.md)** reports, alongside a missing agent
CLI and an unfetched model: *"never built on this machine, so it will never
refresh itself"*. One build clears it — that is how the machine learns the
cost — and from then on the repository keeps itself current.

### Why the graph swap is one transaction

Refreshing can overlap with a session that is working, which turns a
theoretical hazard into a real one. Replacing a repository's index deletes its
edges before inserting the new ones, and a reader arriving in that window sees
symbols with no edges between them — not a stale answer but a confidently wrong
one, which is the single failure this design is least willing to trade for
speed. The structural swap is therefore one transaction.

It stops before the embeddings deliberately: those await a model server, and a
write transaction held across an await would block every other writer for as
long as a large repository takes to embed. Vectors are an enhancement, not the
index, and are written afterwards one batch at a time.

---

Back to the [tool map](tools.md), or [why any of this exists](why.md).
