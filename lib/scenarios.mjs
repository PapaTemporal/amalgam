/**
 * The things people actually sit down to do, and what runs when they pick one.
 *
 * Written from the outside in. "Work on a story" is a thing somebody knows
 * they are doing; "distil intent into the SPEC kernel" is an answer, not a
 * question, and nobody arrives at their desk holding it. So the labels are
 * tasks, and which workflow serves them is the framework's business — the same
 * command backs several of these, and that is fine, because the difference
 * between fixing a bug and picking up a story is in what you tell it, not in
 * which machinery runs.
 *
 * The command is still there to read for anyone who wants it. It is not the
 * headline, because knowing it is not how you decide.
 *
 * Grouped by the hats a small team wears rather than by BMAD's own structure:
 * on a team of one, planning, building, reviewing, shipping and answering for
 * it are the same afternoon.
 *
 * Everything is checked against what is installed before it is offered, so an
 * upgrade that renames or removes a workflow leaves no dead button behind.
 */

/**
 * `needs` is the skill that must be installed — null when the task is served
 * better by amalgam's own tools than by a workflow, which is worth saying
 * plainly rather than routing somewhere that half fits.
 *
 * `ask` is what the person fills in. `then` is what usually follows, so a
 * first step does not read like the whole job.
 */
const MAP = [
  {
    hat: "Get work done",
    blurb: "Something is decided and wants doing.",
    items: [
      { label: "Work on a story", needs: "bmad-build",
        ask: "paste the story, or its id",
        note: "Picks it up, plans it, writes it, and reviews its own work against the repo's conventions.",
        then: "review-changes" },
      { label: "Work on an epic", needs: "bmad-build",
        ask: "which epic",
        note: "The same path, told to work at the level of an epic rather than a single story.",
        then: "sprint-state" },
      { label: "Fix a bug", needs: "bmad-build",
        ask: "what is wrong, and how to see it",
        note: "A fix is a change like any other: it follows what the code already does rather than inventing a style." },
      { label: "Make a small change", needs: "bmad-build",
        ask: "what to change",
        note: "A tweak, a rename, a refactor. No ceremony." },
      { label: "Leave it running unattended", needs: "bmad-build-auto",
        note: "One iteration of the loop with nobody watching. For work you would happily walk away from." },
      { label: "The scope just changed mid-sprint", needs: "bmad-correct-course",
        ask: "what changed",
        note: "Works out what it means for the sprint and proposes the correction rather than quietly absorbing it." },
    ],
  },
  {
    hat: "Look into something",
    blurb: "You do not yet know what is wrong, or where anything is.",
    items: [
      { label: "Investigate an issue", needs: null,
        ask: "what you are seeing",
        note: "Traces it through the code graph — callers, blast radius, the paths that reach it — and changes nothing.",
        prompt: [
          "Investigate this and do not change anything:",
          "",
          "{{input}}",
          "",
          "Use code_context to find the symbols that bear on it, graph_impact for what a change there would reach,",
          "and graph_query for structural questions. Read the current source rather than trusting the index.",
          "Tell me what is happening, where, and what you are unsure of.",
        ].join("\n") },
      { label: "Find my way around this codebase", needs: null,
        note: "For code nobody here wrote. What it does, what is risky, and where to start reading.",
        prompt: [
          "I need to understand this codebase before changing anything.",
          "",
          "Run survey_repo and tell me the riskiest files and which of them have no test reach.",
          "Then use graph_query for the hubs — the symbols most things depend on — and explain how the",
          "pieces fit together. Do not change anything.",
        ].join("\n") },
      { label: "Teach the agents about this repo", needs: "bmad-project-context",
        note: "Sets up or refreshes the repo's own instructions, and records the mistakes worth warning about." },
      { label: "Work out what a change would break", needs: null,
        ask: "what you are thinking of changing",
        note: "Blast radius across every service, including the ones reached over HTTP.",
        prompt: [
          "What would break if I changed this? Do not change anything.",
          "",
          "{{input}}",
          "",
          "Use graph_impact and code_context. Say which services are affected, not just which files,",
          "and mark anything you inferred rather than parsed.",
        ].join("\n") },
    ],
  },
  {
    hat: "Start something new",
    blurb: "From an idea to something somebody can pick up.",
    items: [
      { label: "Explore a rough idea", needs: "bmad-brainstorming",
        note: "Facilitated brainstorming. Comes with its own chooser — pick the techniques and it writes the prompt.",
        then: "pressure-test" },
      { label: "Pressure-test an idea before committing", id: "pressure-test", needs: "bmad-forge-idea",
        ask: "the idea",
        note: "Interrogated by personas until it hardens or dies cheaply. Dying cheaply is a good outcome.",
        then: "write-brief" },
      { label: "Research the market or the prior art", needs: "bmad-deep-recon",
        ask: "what to find out",
        note: "Market, domain, technical or competitive — run here, or drafted for whichever tool you prefer." },
      { label: "Write the announcement first", needs: "bmad-prfaq",
        note: "Working backwards from the press release and the questions you would rather not be asked." },
      { label: "Write a one-pager", id: "write-brief", needs: "bmad-product-brief",
        note: "The brief everything else gets built from.", then: "write-prd" },
      { label: "Write or update the requirements", id: "write-prd", needs: "bmad-prd",
        note: "Create, update or validate a PRD.", then: "design-system" },
      { label: "Design the system", id: "design-system", needs: "bmad-architecture",
        note: "The invariants everything built from it has to keep.", then: "break-down" },
      { label: "Design the interface", needs: "bmad-ux",
        note: "Patterns and specifications for what people will actually touch." },
      { label: "Break it into stories", id: "break-down", needs: "bmad-create-epics-and-stories",
        note: "Requirements become work somebody can pick up on a Monday.", then: "sprint-state" },
      { label: "Write it down so it can be checked", needs: "bmad-spec",
        note: "A spec downstream work can be held to, rather than a document that describes a hope." },
    ],
  },
  {
    hat: "Check the work",
    blurb: "Before it merges, and before somebody else finds it.",
    items: [
      { label: "Review my changes", id: "review-changes", needs: "bmad-code-review",
        note: "Adversarial review in parallel layers, then triage — not a list of everything it noticed." },
      { label: "Walk me through this change", needs: "bmad-checkpoint-preview",
        note: "Explains what changed, points at what matters, and helps you test it before you merge." },
      { label: "Review a document or a spec", needs: "bmad-review",
        ask: "what to review",
        note: "Whichever lenses fit: adversarial, edge cases, verification gaps, structure, prose." },
      { label: "Write tests for a feature", needs: "bmad-qa-generate-e2e-tests",
        ask: "which feature",
        note: "End-to-end tests for something that already exists." },
      { label: "Push harder on what was just produced", needs: "bmad-advanced-elicitation",
        note: "Socratic, first principles, pre-mortem, red team. For when an answer came too easily." },
    ],
  },
  {
    hat: "Ship it",
    blurb: "Release, sprint state, and what happened afterwards.",
    items: [
      { label: "What is ready to ship?", id: "sprint-state", needs: "bmad-sprint-planning",
        note: "Readiness gate, sprint status, and repair of the tracking when it has drifted from reality." },
      { label: "Check nothing is broken", needs: null,
        note: "Runs whatever checks this project declares, and reports only the failures.",
        prompt: "Run run_gate on this project and tell me what failed, verbatim. Do not fix anything yet." },
      { label: "Look back at what we shipped", needs: "bmad-retrospective",
        note: "Collects what the epic produced, checks it against the sources, and gives a verdict." },
    ],
  },
  {
    hat: "Think it through",
    blurb: "When the problem is not yet a task.",
    items: [
      { label: "I do not know what to do next", needs: "bmad-help",
        ask: "what you are trying to do",
        note: "Reads where the project actually is and says what comes next." },
      { label: "Get several opinions at once", needs: "bmad-party-mode",
        ask: "the problem",
        note: "A roundtable between the installed agents, arguing in front of you." },
      { label: "Talk to the analyst", needs: "bmad-agent-analyst", note: "Mary — strategy and requirements." },
      { label: "Talk to the product manager", needs: "bmad-agent-pm", note: "John — requirements and discovery." },
      { label: "Talk to the architect", needs: "bmad-agent-architect", note: "Winston — system design." },
      { label: "Talk to the designer", needs: "bmad-agent-ux-designer", note: "Sally — interface and flows." },
      { label: "Talk to the developer", needs: "bmad-agent-dev", note: "Amelia — implementation." },
    ],
  },
];

/**
 * Who is sitting down, and what that changes.
 *
 * A hat is what you are doing this hour; a role is what you are doing this
 * job. Both are real, and they are not the same axis — a product manager
 * still fixes a typo and a developer still writes a one-pager — so a role
 * here orders the menu rather than cutting it down. Everything stays exactly
 * where it was; the tasks somebody in this role reaches for most simply come
 * first, and so do the specialists they would actually talk to.
 *
 * Restricting would be the easier thing to build and the wrong thing to use.
 * The person who most needs a task outside their role is the person who has
 * just been handed it.
 *
 * `talkTo` names persona tasks by the same labels used above, so a role never
 * introduces a second vocabulary for the same thing.
 */
const ROLES = [
  {
    label: "Developer",
    note: "Building it, and answering for what you changed.",
    tasks: [
      "Work on a story", "Fix a bug", "Make a small change", "Review my changes",
      "Work out what a change would break", "Check nothing is broken",
      "Investigate an issue", "Write tests for a feature",
      "Find my way around this codebase",
    ],
    talkTo: ["Talk to the developer", "Talk to the architect"],
  },
  {
    label: "Product manager",
    note: "Deciding what gets built, and whether it is done.",
    tasks: [
      "Write or update the requirements", "Break it into stories", "Work on an epic",
      "The scope just changed mid-sprint", "What is ready to ship?",
      "Write a one-pager", "Write the announcement first",
      "Review a document or a spec", "Look back at what we shipped",
    ],
    talkTo: ["Talk to the product manager", "Talk to the analyst"],
  },
  {
    label: "Architect",
    note: "The shape of the thing, and what it costs to change it.",
    tasks: [
      "Design the system", "Work out what a change would break",
      "Pressure-test an idea before committing", "Teach the agents about this repo",
      "Find my way around this codebase", "Review a document or a spec",
      "Walk me through this change",
    ],
    talkTo: ["Talk to the architect", "Talk to the developer"],
  },
  {
    label: "Designer",
    note: "How it is used, before how it is built.",
    tasks: [
      "Design the interface", "Explore a rough idea",
      "Write or update the requirements", "Review a document or a spec",
      "Walk me through this change",
    ],
    talkTo: ["Talk to the designer", "Talk to the product manager"],
  },
  {
    label: "Analyst",
    note: "Whether it is worth building at all.",
    tasks: [
      "Research the market or the prior art", "Explore a rough idea",
      "Pressure-test an idea before committing", "Write a one-pager",
      "Write or update the requirements", "Investigate an issue",
    ],
    talkTo: ["Talk to the analyst", "Talk to the product manager"],
  },
];

/** Everything by id, so `then` can name a task rather than a command. */
const byId = new Map();
for (const g of MAP) for (const i of g.items) if (i.id) byId.set(i.id, i);

/**
 * The tasks this project can actually run.
 *
 * Anything needing a workflow that is not installed is dropped rather than
 * offered and then failing; a hat left with nothing in it goes with it.
 */
export function scenarios(installed) {
  const have = new Set(installed.map((w) => w.name));
  const describe = new Map(installed.map((w) => [w.name, w.description]));
  const runnable = (i) => !i.needs || have.has(i.needs);

  return MAP.map((group) => ({
    hat: group.hat,
    blurb: group.blurb,
    items: group.items.filter(runnable).map((i) => {
      const next = i.then ? byId.get(i.then) : null;
      return {
        label: i.label,
        note: i.note,
        // What actually runs. Readable, but not the headline.
        command: i.needs ? `/${i.needs}` : null,
        // Prefilled and editable: the command plus a place for your own words.
        prefill: i.needs ? (i.ask ? `/${i.needs} ` : `/${i.needs}`) : (i.prompt ?? ""),
        ask: i.ask ?? null,
        // A prompt template uses {{input}}; a command just takes a tail.
        template: i.needs ? null : (i.prompt ?? null),
        skillNote: i.needs ? describe.get(i.needs) ?? null : null,
        next: next && runnable(next) ? next.label : null,
      };
    }),
  })).filter((g) => g.items.length);
}

/**
 * The same tasks, ordered for who is asking.
 *
 * Built from the output of `scenarios` rather than beside it, so a role can
 * never offer something the project cannot run, and a task that changes its
 * wording does not have to be changed twice. A role whose work is entirely
 * uninstalled is dropped, for the same reason an empty hat is.
 */
export function roles(installed) {
  const known = new Map();
  for (const g of scenarios(installed)) for (const i of g.items) known.set(i.label, i);

  return ROLES.map((r) => ({
    label: r.label,
    note: r.note,
    items: r.tasks.map((t) => known.get(t)).filter(Boolean),
    talkTo: r.talkTo.map((t) => known.get(t)).filter(Boolean),
  })).filter((r) => r.items.length);
}
