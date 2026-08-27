/**
 * What this machine is still missing.
 *
 * Updating brings code. It does not sign an agent in, fetch a library, or
 * rebuild an index that failed on a version with the bug in it — those live on
 * the machine, not in the repository, and a second machine that has pulled
 * everything can still be half inert.
 *
 * Neither "reinstall" nor "update" covers all of it, and expecting somebody to
 * know which of the two covers which part is the kind of question a tool
 * should answer rather than pose. So the check lives here, once, and both the
 * command line and the interface report from it.
 *
 * Only genuine gaps are returned. A machine with nothing outstanding gets an
 * empty list, which is a sentence rather than a checklist of ticks.
 */
import fs from "node:fs";
import path from "node:path";

import { agentCli } from "./session.mjs";
import { visVendored } from "./graphpage.mjs";
import { readRegistry, projectKey } from "./uiserver.mjs";
import { isWorkspace, services as servicesOf } from "./workspace.mjs";
import { isIndexed } from "./graphdb.mjs";
import { buildRecord } from "./refresh.mjs";
import { embeddingsInstalled } from "./embed.mjs";
import { modelInstalled } from "./services.mjs";

const GRAPH_REL = path.join("graphify-out", "graph.json");
const PAGE_REL = path.join("graphify-out", "graph.html");

/**
 * Every gap, in the order they are worth fixing.
 *
 * `fix` is the command somebody would type. `action` is what the interface can
 * press on their behalf, or null when the fix belongs to a project page rather
 * than to this one.
 */
export function machineGaps() {
  const gaps = [];

  if (!agentCli()) {
    gaps.push({
      id: "agent",
      what: "No agent CLI on this machine",
      why: "Without one the interface can only compose prompts for you to paste. Nothing can be run here.",
      fix: "npm install -g @anthropic-ai/claude-code",
      action: { endpoint: "/agent/install", label: "Install it" },
      // Installing it is not the same as being able to use it, and there is no
      // way to know which without running it.
      note: "Afterwards run `claude` once and sign in — that part cannot be done from here.",
    });
  }

  if (!visVendored()) {
    gaps.push({
      id: "vendor",
      what: "The interactive graph needs the internet to draw itself",
      why: "graphify's page fetches its drawing library from a CDN, so it is blank offline.",
      fix: "amalgam vendor-graph",
      action: { endpoint: "/graphpages/vendor", label: "Keep a local copy" },
      note: "One 686 KB download, and it never reaches the network again.",
    });
  }

  if (!embeddingsInstalled()) {
    gaps.push({
      id: "embeddings",
      what: "No embedding model",
      why: "Search falls back to matching names. Describing what you want will not find it.",
      fix: "amalgam install --with-embeddings",
      action: null,
      note: "Tick Semantic recall under Reinstall.",
    });
  }

  if (!modelInstalled()) {
    gaps.push({
      id: "model",
      what: "No local model",
      why: "Digest, re-ranking, session capture and community naming all need one. Everything else works without it.",
      fix: "amalgam install --with-model",
      action: null,
      note: "Tick Local model under Reinstall.",
    });
  }

  // Repositories, which are per machine because the clones are.
  const needs = [];
  for (const proj of readRegistry().projects) {
    const root = path.resolve(String(proj ?? ""));
    if (!root || !fs.existsSync(root)) continue;
    const parts = isWorkspace(root)
      ? servicesOf(root)
      : [{ name: path.basename(root), path: root }];

    for (const part of parts) {
      if (!fs.existsSync(path.join(part.path, GRAPH_REL))) continue;
      // A graph that never reached the index is what the fixed indexing bugs
      // left behind: it looks built from the outside and reports no symbols,
      // so nobody would think to check it.
      if (!isIndexed(part.path)) {
        needs.push({ service: part.name, project: root, reason: "graph built, never indexed" });
      } else if (!fs.existsSync(path.join(part.path, PAGE_REL))) {
        needs.push({ service: part.name, project: root, reason: "no diagram drawn" });
      } else if (!buildRecord(part.path)) {
        // The second-machine case, and the one nothing used to say out loud.
        // Build timings are per machine — they have to be, since machines
        // differ — so a repository set up somewhere else arrives here with a
        // graph and no idea what rebuilding it costs. The refresh policy
        // refuses to start work whose cost it does not know, which is right,
        // but it means automatic refresh quietly does nothing at all until
        // somebody builds each repository once by hand.
        needs.push({
          service: part.name, project: root,
          reason: "never built on this machine, so it will never refresh itself",
        });
      }
    }
  }

  if (needs.length) {
    const projects = [...new Set(needs.map((n) => n.project))];
    gaps.push({
      id: "repos",
      what: `${needs.length} repositor${needs.length === 1 ? "y" : "ies"} to rebuild here`,
      why: needs.map((n) => `${n.service} — ${n.reason}`).join("; "),
      fix: "amalgam graph --label",
      action: null,
      // The fix belongs to each project's own page, where Rebuild already is.
      projects: projects.map((p) => ({ key: projectKey(p), name: path.basename(p), path: p })),
      note: "Rebuild on each project, or run the command from the project folder. " +
            "One build is enough for the last kind: it is how the machine learns what a " +
            "rebuild costs, and after that the repository keeps itself current.",
    });
  }

  return gaps;
}

/** The same thing, printed. */
export function renderGaps(gaps) {
  if (!gaps.length) return "\nNothing else this machine needs.";
  const lines = ["\nStill to do on this machine — none of it travels with an update:"];
  for (const g of gaps) {
    lines.push("", `  ${g.what}`);
    lines.push(`    ${g.why}`);
    lines.push(`    ${g.fix}`);
    if (g.note) lines.push(`    ${g.note}`);
  }
  return lines.join("\n");
}
