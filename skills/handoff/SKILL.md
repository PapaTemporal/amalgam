---
name: handoff
description: Close a session on purpose so the next one starts cheap — write the project scenario, save durable facts, square the open work items, and verify the restore point is current before the user clears. Use when the user invokes /handoff, or says things like "the context is getting long", "let's start fresh", "wrap up", "before I clear", "save where we are", or when the context indicator is high and there is a natural stopping point.
---

# Handoff — make crossing a session boundary cheap

## Why this exists

Everything else amalgam does reduces what a single call **adds** to a
conversation: a symbol packet instead of two files, an exit code instead of a
build log, a digest instead of the output. None of it removes anything already
said. A transcript is append-only, so the context indicator climbs no matter
how efficient each addition was — amalgam flattens the slope and cannot change
the direction.

The only thing that changes the direction is a session boundary. This skill is
the boundary being crossed deliberately instead of hit by surprise, and the
whole job is making sure the next session starts knowing what this one knew.

Measured on this project, a current restore point is a few hundred tokens
against a conversation of tens of thousands. But that trade is only good if
what would be restored is **actually current**, and the default is that it is
not: the first time `amalgam checkpoint` was run here, the project's scenario
was fifty-seven commits behind. Starting over would have cost more than it
saved, and nothing said so.

## Step 1 — look at what a fresh session would get

```bash
amalgam checkpoint
```

Read the whole thing before writing anything. It reports the persona, this
project's scenario documents, the open work items, the token cost of the lot,
and — the part that decides everything else — how many commits each scenario
is behind.

State the situation to the user in one or two sentences: what a fresh session
would start with, what it costs, and what is stale. Do not paste the raw
output.

## Step 2 — write down what this session actually learned

Three different kinds of thing, three different homes. Do all that apply; skip
the ones with nothing to put in them rather than inventing filler.

**Project state → `memory_context_write`.** The scenario document is what a
fresh session reads instead of scrolling back. Write it as the state of the
project *now*, not a diary of this session: what the thing is, what shape it is
in, what was just decided, what is half-done and where. Overwrite the old one —
this is a snapshot, not an append-only log. If `checkpoint` said the scenario
was behind, this step is the point of the whole skill.

**Durable facts → `memory_save_fact`.** One call per fact. A fact is something
that will still be true next month and that cost something to learn: a decision
and its reason, a gotcha, a constraint the user stated, a measured number.
Keep names, paths, commands and numbers exact — dense wording, but never
paraphrase an identifier. Not worth saving: what the code already says, what
git history already records, what only mattered inside this conversation.

If a save reports that it may replace an older fact, look at both and call
`memory_supersede` when it does, so recall stops returning a contradiction.

**Work in flight → `task_note` / `task_done`.** Square the open items with
reality. An item `checkpoint` lists as open that is actually finished should be
closed; work that is genuinely half-done should carry a note saying where it
stopped and what the next move is. A work item that says "in progress" and
nothing else is the same as no work item.

## Step 3 — prove it, then hand over

Run `amalgam checkpoint` again. The scenario should now read as current with
the code. If it still reports commits behind, the write did not land where you
thought — say so plainly rather than declaring success.

Then tell the user, concretely:

- what the next session will start with, and roughly what it costs
- anything you deliberately did **not** save, and why
- that it is now safe to clear

Do not clear anything yourself, and do not tell the user their context is fine
when `checkpoint` says the restore point is stale. The decision to cross is
theirs; this skill only makes it an informed one.

## Rules

- **Write before reporting.** Never tell the user they are safe to start fresh
  on the strength of a scenario you have not actually written.
- **Snapshot, not diary.** The scenario answers "where is this project", not
  "what did we do today". Nobody resuming needs the narrative.
- **Facts are durable or they are noise.** Twenty low-value facts make recall
  worse, not better; the review queue exists because volume has a cost.
- **This does not shrink the current conversation.** Nothing can — the
  transcript belongs to the harness, not to amalgam. Be straight about that: the
  benefit is entirely on the other side of the boundary.
