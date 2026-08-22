---
name: offload
description: Use local offload stack (amalgam MCP) to minimize frontier-model context, and isolate parallel work in git worktree streams. Trigger at session start, before searching a codebase, and at session end. Also when the user says "remember", "recall", "what do you know about", asks to save/load context, or starts work that would collide with other in-flight changes.
---

# Offload — spend local compute, not context tokens

The amalgam MCP server provides local memory (SQLite, searched by meaning and
keyword), a local small model (`digest`, and caveman compress/expand), and
local code graphs (graphify). Everything runs on this machine. Prefer these
over burning context.

- `memory_recall` finds memories even when your wording shares no words with
  them, so search by intent rather than guessing stored phrasing.
- `digest` reads a long file or verbose command output and returns only a
  dense summary — the raw text never enters your context. Reach for it before
  reading anything bulky in full.

## Session start (do this once, cheaply)

1. `memory_persona_read` — load the user's stable preferences (L3).
2. `memory_recall` with 3-5 keywords about the task at hand — load relevant
   facts (L1) and scenario docs (L2). Read results as-is: they are
   caveman-dense on purpose; do NOT expand them unless showing the user.
3. If this session is in a stream worktree (directory name `<repo>-<stream>`),
   recall with that stream's tag first — see Work streams below.

## Work streams (parallel work without collisions)

Several AI sessions may run at once. Each substantial, independent piece of
work belongs in its own **stream**: a git worktree with its own branch, so
edits, builds, and test runs in one stream cannot disturb another — or the
checkout the user has open.

**Start a stream** when work is independent of what else is in flight, will
take more than a quick edit, or needs to build/test:

```
amalgam stream new <name> --repo <repo> --purpose "<one line>"
```

It creates `<repo>-<name>/` on branch `stream/<name>`. Do that work there.
For a quick edit on an idle repo, plain branches are fine — don't create
ceremony for a one-line fix.

**Tag memories by stream.** Use `context: "<repo>/<stream>"` on
`memory_save_fact`, and path scenario docs as `<repo>/<stream>/...`. Streams
then recall their own context instead of each other's, which is the memory-side
mirror of the file isolation the worktree gives you.

**Close the loop — this is what keeps disk from leaking.** A built worktree
can be gigabytes, so a stream must be told when it stops being useful:

- Merged the work into the main branch? It is reclaimable automatically.
- The user has evaluated the result, or the work is abandoned or superseded?
  Say so explicitly: `amalgam stream done <name> --repo <repo>`.
- Run `amalgam stream gc` (plan) / `--yes` (execute) periodically — at session
  start on a repo with streams, or whenever the user mentions disk space.

Safety rules gc already enforces, so you can run the plan freely: it never
touches a worktree with real uncommitted changes, never deletes an unmerged
branch (only the worktree, keeping the commits), keeps pinned streams, and
frees build output before removing anything. Report the plan to the user
before executing if any stream shows unmerged commits.

**Long-lived worktrees** (a nightly job's warm build dir) should be created
with `--pin`, or pinned later with `amalgam stream pin <name>`, so gc leaves
them and their expensive build directories alone.

## During work

- **Evidence before files.** About to change existing code? Call
  `code_context` with the task in plain language. It returns the symbols
  that bear on it, who calls them, what they call, and their current
  source read from disk — a few hundred tokens where the files around
  them are a few thousand. The graph chooses the lines; the working tree
  supplies them, so a slightly stale graph costs precision, never
  correctness. It says so when it is behind.
- **Blast radius before review.** `graph_impact` maps a diff to the
  symbols it actually touched and everything that calls them. Use it
  instead of grepping for callers when reviewing or extending a change.
- **Graph before grep.** For "what calls X", "how do A and B connect",
  "explain symbol Y", use `graph_query` (mode explain/path/query). Fall
  back to Grep/Read only when the graph lacks the answer — and prefer a
  file read outright for a file small enough that a packet would not
  save anything.
- **Compress bulky payloads.** Before storing long notes, or when you must
  carry a verbose document forward, run `caveman_compress` locally and keep
  only the dense version.
- **Write memories caveman-dense yourself.** When saving facts you distilled,
  drop articles/filler; keep every fact, name, number, path, command exact.

## Session end / after important exchanges

- `memory_save_fact` — one call per durable fact/preference/decision/constraint
  learned this session (tag `context` with the project, e.g. 'api-server').
  It warns when the fact names a path that does not exist, and reports any
  stored fact close enough to be the thing it replaces.
- `memory_supersede` — when a fact you just saved corrects an older one, say
  so. The old row stays as history but leaves recall, so the mistake and its
  correction are not both paid for on every future query. Recall shows
  `!stale` beside a fact whose paths have since disappeared; treat that as a
  reason to re-check before acting, and supersede it once you know better.
- `memory_context_write` — update the project's scenario doc if the working
  state changed (current plan, build quirks, decisions).
- `memory_persona_write` — only when stable user preferences changed; read,
  merge, rewrite whole doc.
- `memory_log` — only for exchanges worth keeping verbatim.

## Showing memory to the user

Stored content is telegraphic. When quoting memory to the user, either expand
it yourself or use `caveman_expand` (local model) for longer passages.

## If tools error

`ERROR: ... unreachable / spawn failed` means the local stack is down. Tell the
user to run `amalgam\scripts\start-all.ps1`. Never substitute a cloud service.
