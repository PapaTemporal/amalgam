---
name: offload
description: Use local offload stack (amalgam MCP) to minimize frontier-model context. Trigger at session start, before searching a codebase, and at session end. Also when the user says "remember", "recall", "what do you know about", or asks to save/load context.
---

# Offload — spend local compute, not context tokens

The amalgam MCP server provides local memory (PostgreSQL), a local small model
(caveman compress/expand), and local code graphs (graphify). Everything runs on
127.0.0.1. Prefer these over burning context.

## Session start (do this once, cheaply)

1. `memory_persona_read` — load the user's stable preferences (L3).
2. `memory_recall` with 3-5 keywords about the task at hand — load relevant
   facts (L1) and scenario docs (L2). Read results as-is: they are
   caveman-dense on purpose; do NOT expand them unless showing the user.

## During work

- **Graph before grep.** For "what calls X", "how do A and B connect",
  "explain symbol Y" in a repo with a built graph, use `graph_query`
  (mode explain/path/query) instead of reading files. Fall back to
  Grep/Read only when the graph lacks the answer.
- **Compress bulky payloads.** Before storing long notes, or when you must
  carry a verbose document forward, run `caveman_compress` locally and keep
  only the dense version.
- **Write memories caveman-dense yourself.** When saving facts you distilled,
  drop articles/filler; keep every fact, name, number, path, command exact.

## Session end / after important exchanges

- `memory_save_fact` — one call per durable fact/preference/decision/constraint
  learned this session (tag `context` with the project, e.g. 'musescore').
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
