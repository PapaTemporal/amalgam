/**
 * Which model a task deserves, decided locally before any of it is sent.
 *
 * A session runs on whatever model the agent CLI defaults to, which means the
 * same model answers "what does this function return" and "redesign the
 * scheduler". One of those is being overpaid for and the other may be being
 * underserved. The local model already on this machine can read a task and say
 * which kind it is — that is a classification, which is exactly what a 3.6 GB
 * model is good at — and it costs nothing that leaves the machine.
 *
 * Three rules this follows, because the failure modes are asymmetric:
 *
 *   It never downgrades silently. The choice and the reason are shown before
 *   the session starts, and one click overrides it. Being quietly moved to a
 *   cheaper model is a thing done TO somebody.
 *
 *   Unsure means the default. A classifier that hedges toward the strong model
 *   wastes money; one that hedges toward the weak model wastes the work, and
 *   the work is worth more. So anything the local model is not clear about
 *   lands on the default tier rather than the cheap one.
 *
 *   Rules answer when the model cannot. No local model, a server that will not
 *   start, a reply that is not one of the tiers — all fall through to
 *   deterministic heuristics rather than to an error, because a session must
 *   always be able to start.
 *
 * What this deliberately does NOT do is claim to route between agents. amalgam
 * drives Claude Code, whose --model flag this sets; GitHub Copilot is a
 * different CLI speaking a different protocol, and routing to it would be a
 * session runtime, not a table. See docs/models.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
const CONFIG = path.join(HOME, "models.json");

/**
 * The tiers, cheapest first, and what each is actually for.
 *
 * `note` is what the interface shows a person; `when` is what the local model
 * is told to choose between. They differ because one is an explanation and the
 * other is an instruction.
 *
 * Prices are per million tokens, first-party API rates, carried here only so
 * the interface can say what a choice costs relative to another. A Claude Code
 * session may bill against a subscription instead, so these are shown as
 * relative weight rather than as a bill.
 */
export const TIERS = [
  {
    id: "light",
    model: "claude-haiku-4-5",
    label: "Haiku 4.5",
    price: { in: 1, out: 5 },
    context: "200K",
    note: "Mechanical work with a clear answer. Cheapest, and the smallest context.",
    when: "The task is small, mechanical and fully specified: a rename, a formatting fix, " +
          "adding a test for behaviour that already exists, answering a factual question " +
          "about the code, or reading something and summarising it. No design decisions.",
  },
  {
    id: "standard",
    model: "claude-sonnet-5",
    label: "Sonnet 5",
    price: { in: 2, out: 10 },
    context: "1M",
    note: "Ordinary implementation against a clear specification.",
    when: "The task is ordinary implementation work where what to do is already decided: " +
          "build a described feature, fix a bug with a known reproduction, refactor to a " +
          "stated shape, write tests to a spec. Judgement about HOW, not about WHAT.",
  },
  {
    id: "deep",
    model: "claude-opus-5",
    label: "Opus 5",
    price: { in: 5, out: 25 },
    context: "1M",
    note: "The default. Anything with judgement, ambiguity or reach in it.",
    when: "The task needs judgement: the requirements are not settled, the change crosses " +
          "several parts of the system, something is broken and nobody knows why yet, or " +
          "a design or trade-off has to be argued. Also anything you cannot confidently " +
          "place in the two above.",
  },
  {
    id: "hardest",
    model: "claude-fable-5",
    label: "Fable 5",
    price: { in: 10, out: 50 },
    context: "1M",
    note: "The most demanding reasoning and long-horizon work. Turns can run for many minutes.",
    when: "The task is unusually hard AND long-horizon: a large autonomous run with many " +
          "steps and no supervision, or reasoning demanding enough that a wrong answer " +
          "costs more than a slow one. Rare. Do not choose this merely because a task " +
          "is large or important.",
  },
];

/** The tier used when nothing is known, and when anything goes wrong. */
export const DEFAULT_TIER = "deep";

export const tierById = (id) => TIERS.find((t) => t.id === id) ?? null;

/**
 * Which model each tier maps to on this machine.
 *
 * Editable, because the defaults are a judgement and somebody else's judgement
 * is allowed to differ — and because a new model should not need a code change
 * to be used. Unknown keys are ignored rather than trusted.
 */
export function models() {
  const out = Object.fromEntries(TIERS.map((t) => [t.id, t.model]));
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    for (const t of TIERS) {
      const m = saved?.tiers?.[t.id];
      if (typeof m === "string" && m.trim()) out[t.id] = m.trim();
    }
  } catch { /* defaults */ }
  return out;
}

export function setModel(tierId, model) {
  if (!tierById(tierId)) return { error: `unknown tier: ${tierId}` };
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { /* first write */ }
  saved.tiers = { ...(saved.tiers ?? {}), [tierId]: String(model ?? "").trim() || undefined };
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(saved, null, 2));
  } catch (e) { return { error: e.message }; }
  return { tiers: models() };
}

/** Routing is off unless it is on: it changes which model runs your work. */
export function routingEnabled() {
  const env = process.env.AMALGAM_ROUTE_MODELS;
  if (env) return env.toLowerCase() !== "off";
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")).enabled === true; }
  catch { return false; }
}

export function setRouting(on) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { /* first write */ }
  saved.enabled = !!on;
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(saved, null, 2));
  } catch { /* stays off */ }
  return routingEnabled();
}

/**
 * The deterministic answer, used when there is no local model to ask.
 *
 * Keyword heuristics are a blunt instrument and this one is deliberately
 * timid: it only moves off the default when a task says plainly what it is.
 * Being wrong downward is the expensive direction, so the phrases that pull
 * DOWN a tier have to be unambiguous, while anything unrecognised stays put.
 */
export function rules(task) {
  const t = String(task ?? "").toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;

  const mechanical = /\b(rename|typo|format|reformat|lint|comment|docstring|changelog|bump|indent)\b/.test(t);
  const explaining = /\b(what does|what is|where is|explain|summari[sz]e|list the|show me|which file)\b/.test(t);
  // "why" is the diagnosis word. "What does this do" is a question with an
  // answer in the file; "why does this happen" is one that is not.
  const designing = /\b(why|design|architect|rewrite|migrate|trade-?off|approach|strategy|root cause|nobody knows|investigate|decide whether|figure out|work out)\b/.test(t);
  const longRun = /\b(unattended|overnight|autonomous|without supervision|end to end|whole (?:epic|project))\b/.test(t);

  if (longRun && designing) return { tier: "hardest", why: "a long autonomous run that also needs judgement" };
  if (designing) return { tier: "deep", why: "it asks for judgement rather than execution" };

  // Both gates matter. A task can say "rename" and still be three jobs in a
  // trenchcoat, and reading one keyword out of a long sentence is exactly how
  // hard work gets sent to a weak model. Something genuinely mechanical is
  // short, and says nothing that needs deciding.
  if ((mechanical || explaining) && words <= 20) {
    return { tier: "light", why: explaining ? "a question about the code, not a change to it" : "a mechanical edit" };
  }
  return { tier: DEFAULT_TIER, why: "nothing in it says it is simpler than the default" };
}

const SYSTEM = `You size coding tasks so the right model is used. Answer with ONE tier id and a short reason.

${TIERS.map((t) => `${t.id}: ${t.when}`).join("\n\n")}

Reply with exactly one line: <tier id>|<reason in under 12 words>
If you are not confident, answer ${DEFAULT_TIER}. Never explain your reasoning beyond that one line.`;

/**
 * Ask the local model, and refuse to believe anything it did not actually say.
 *
 * A classifier answering out of range is not a rare event worth an exception —
 * it is Tuesday — so an unparseable reply is treated as no answer at all and
 * the rules decide instead.
 */
export async function classify(task, { timeoutMs = 8000 } = {}) {
  const { llama } = await import("./llm.mjs");
  const reply = await Promise.race([
    llama(SYSTEM, String(task).slice(0, 4000), 64),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), timeoutMs)),
  ]);

  const line = String(reply ?? "").trim().split(/\r?\n/).find(Boolean) ?? "";
  const [rawTier, ...rest] = line.split("|");
  const id = String(rawTier ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!tierById(id)) throw new Error(`local model answered "${line.slice(0, 40)}"`);

  const why = rest.join("|").trim().replace(/^["']|["']$/g, "");
  return { tier: id, why: why || "chosen by the local model" };
}

/**
 * The whole decision: which model, why, and who decided.
 *
 * `by` is carried because it changes how much the answer is worth. "rules"
 * means nothing read the task but a regular expression, and the interface says
 * so rather than presenting a keyword match as an assessment.
 */
export async function route(task, { permissionMode = null, classifier = classify } = {}) {
  const map = models();
  const done = (tier, why, by) => ({
    tier, why, by, model: map[tier], label: tierById(tier)?.label ?? map[tier],
    note: tierById(tier)?.note ?? "", price: tierById(tier)?.price ?? null,
  });

  // Read-only sessions cannot change anything, so the expensive tiers have
  // nothing to be careful with. This is a fact about the session rather than a
  // guess about the task, which is why it is checked before asking anybody.
  if (permissionMode === "read") {
    const r = rules(task);
    const tier = r.tier === "hardest" || r.tier === "deep" ? "standard" : r.tier;
    return done(tier, "read-only: it can answer, not change anything", "rules");
  }

  try {
    const { tier, why } = await classifier(task);
    return done(tier, why, "the local model");
  } catch {
    // No local model, a server that will not start, a reply outside the tiers:
    // all the same answer. A session must always be able to start.
    const r = rules(task);
    return done(r.tier, r.why, "rules");
  }
}
