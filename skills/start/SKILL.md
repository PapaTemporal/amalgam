---
name: start
description: Guided front door for a work session — presents a menu of concrete choices (build, plan, investigate, housekeeping), drills down (new vs. continue), and routes to the right BMAD workflow with context already loaded. Use when the user invokes /start, or says things like "what should I work on", "where did we leave off", "let's get started", "what's the status", or opens a session without a specific task in mind.
---

# Start — turn a blank prompt into a chosen next action

The point is to remove the blank-page moment. Do not ask an open question like
"what would you like to work on?" — gather the state first, then present
**concrete lettered choices** grounded in what actually exists in this project.

## Step 1 — load state before asking anything

Run these together, then read the results before speaking:

1. `amalgam brief` (Bash) — git branch and dirt, open branches, work streams,
   BMAD artifacts with statuses, whether a code graph exists, service state.
   Use the project root as the argument when the cwd is not the repo.
2. `memory_recall` (MCP) with the project name plus a couple of task words —
   what past sessions decided, and what the nightly job did. Stored text is
   caveman-dense; read as-is.
3. `memory_persona_read` (MCP) if this is a fresh session.

If `amalgam brief` reports BMAD is not installed, drop the BMAD-specific
options and offer plain equivalents (implement / investigate / plan by hand).

## Step 2 — one short orientation line, then the menu

Tell the user where things stand in **one or two sentences** — branch, what is
in flight, anything the nightly job left. Never dump the raw brief.

Then call `AskUserQuestion` with a top-level question and these four options
(adapt labels to reality — if a story is in progress, say so in the option):

| Option | Means | Routes to |
|---|---|---|
| **Build** | implement code | story / quick fix workflows |
| **Plan** | decide what to build | brief, PRD, architecture, epics |
| **Investigate** | understand or diagnose | research, code review, codebase questions |
| **Housekeeping** | keep the machine tidy | sprint status, retrospective, streams/disk, memory |

## Step 3 — drill down (this is where "new vs. continue" belongs)

Ask a second `AskUserQuestion` scoped to the branch they chose. Always make
in-progress items concrete: list the actual story/file names from the brief
rather than the abstract category.

**Build**
- Continue an in-progress story → `bmad-dev-story` (name the story)
- Start the next planned story → `bmad-dev-story` / `bmad-dev-auto`
- Small change, no story needed → `bmad-quick-dev`
- No story exists yet → `bmad-create-story` first

**Plan**
- Shape a raw idea → `bmad-brainstorming` / `bmad-forge-idea` / `bmad-product-brief`
- Write or revise requirements → `bmad-create-prd` / `bmad-edit-prd` / `bmad-validate-prd`
- Design the system → `bmad-create-architecture`
- Break work down → `bmad-create-epics-and-stories`

**Investigate**
- Learn this codebase → `graph_query` first, then `bmad-document-project` or
  `bmad-generate-project-context` if a durable write-up is wanted
- Research a topic → `bmad-technical-research` / `bmad-domain-research` / `bmad-market-research`
- Review existing code → `bmad-code-review` / `bmad-review`
- Diagnose a specific bug → work directly, leading with `graph_query` over file reads

**Housekeeping**
- Sprint status or planning → `bmad-sprint-planning`
- Retrospective → `bmad-retrospective`
- Disk and worktrees → `amalgam stream list` / `gc` (show the plan before executing)
- Memory → `memory_recall` / `memory_context_read`, or save what is missing

Keep it to two questions. A third is only for a genuine fork the answer
depends on; more than that is an interrogation, not a flow.

## Step 3b — workspace vs. service, and checking the route exists

`amalgam brief` reports either a WORKSPACE (a directory holding several
services) or a PROJECT (a single repo).

**BMAD lives at the workspace level.** Its `_bmad/` config, its
`_bmad-output/` documents, and its skills belong to the workspace, and its
workflows reason across every service under it — planning, documentation, and
architecture describe the whole system, not one checkout. Do not install BMAD
inside an individual service repo.

So in a workspace, when a chosen workflow concerns code rather than the system
as a whole, the useful extra question is **which service** it targets — offer
the service list from the brief. Implementation work then happens in that
service's repo (in a stream when it is build-heavy), while the planning
artifacts it came from stay at the workspace level.

Before routing, confirm the target skill is in your available-skills list
(`ListSkills` if unsure). If `bmad-*` skills are missing, the session is
probably rooted inside a service instead of at the workspace — say so and name
the workspace directory. Never invent a skill name or pretend a handoff
happened.

## Step 4 — set up, then hand off

Before invoking the chosen workflow:

- **Isolate build-heavy or parallel work.** If the choice means editing and
  building while something else is in flight (or the user's checkout is dirty),
  offer a stream: `amalgam stream new <name> --repo <repo> --purpose "..."`.
  Skip the ceremony for a quick read-only task or a one-line fix.
- **Load context for the chosen topic**: another `memory_recall` scoped to it,
  and `memory_context_read` for the project's scenario doc if one exists.

Then actually invoke the target skill with the `Skill` tool — do not merely
describe it or tell the user which command to run. Pass what you learned
(story name, topic, stream path) as arguments so the workflow starts warm.

## Step 5 — close the loop at the end of the work

When the chosen work finishes, save what would otherwise be lost:
`memory_save_fact` for decisions and gotchas, `memory_context_write` for
project state, and `amalgam stream done <name>` once the user has judged the
result so its disk can be reclaimed.

## Rules

- Concrete over abstract: "Continue story 2.3 (in review)" beats "work on a story".
- Never present an option the brief says is impossible (no stories → do not
  offer "continue a story"; offer creating one).
- If the user already stated a clear task, skip the menu entirely and route
  straight to the right workflow — this skill exists to remove ambiguity, not
  to add a toll booth.
