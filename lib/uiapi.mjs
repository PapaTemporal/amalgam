/**
 * What the interface is allowed to ask for.
 *
 * Every route here delegates to the same function the CLI calls. That is a
 * deliberate constraint rather than laziness: a dashboard that computes its
 * own version of "is this project set up" will eventually disagree with the
 * command that answers the same question, and the person in front of it will
 * believe whichever one is wrong.
 *
 * Nothing here writes to a project. Reads are free; anything that changes a
 * repository goes through a job (see uiserver.mjs) so it is visible, ordered,
 * and stops at the first failure.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HOME, modelInstalled, llamaHealthy, minutesIdle, IDLE_MINUTES } from "./services.mjs";
import { embeddingsInstalled } from "./embed.mjs";
import { open as openDb } from "./db.mjs";
import { listTasks, resume as resumeTask } from "./tasks.mjs";
import { readStreams, inspectStream, classify } from "./streams.mjs";
import { detectChecks } from "./gates.mjs";
import { findSpecs, parseSprintStatus, assess, summarise } from "./trace.mjs";
import { rank as rankRisk, coupling } from "./survey.mjs";
import { isIndexed, graphFromDb, indexStatus } from "./graphdb.mjs";
import { isWorkspace, services as workspaceServices, serviceGraphs, graphSummary, graphFor as graphForAny } from "./workspace.mjs";
import { loadGraph } from "./graph.mjs";
import { countPending, listPending } from "./capture.mjs";
import { readRegistry, writeRegistry, projectKey, browse, startJob } from "./uiserver.mjs";
import { compose, launch } from "./uiflows.mjs";
import { loadContracts } from "./contracts.mjs";
import { symbolSpans } from "./graph.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = `node "${path.join(PKG, "bin", "amalgam.mjs")}"`;

const git = (repo, args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

const has = (cmd) => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? (r.stdout ?? "").split(/\r?\n/)[0].trim() : null;
};

// One entry point that handles a service or a whole project.
const graphFor = (repo) => { try { return graphForAny(repo); } catch { return null; } };

/**
 * Which agent this machine can actually drive.
 *
 * The interface offers to start work three ways and picks the best one
 * available, so it has to know what is there. A machine with no agent CLI
 * still gets a composed prompt to paste — which is how BMAD works today, and
 * is never worse than what the user has now.
 */
export function agents() {
  const found = [];
  for (const [id, bin, label] of [["claude", "claude", "Claude Code"], ["copilot", "copilot", "GitHub Copilot CLI"]]) {
    const at = has(bin);
    if (at) found.push({ id, label, path: at });
  }
  return { found, canRunHeadless: found.length > 0, canOpenTerminal: true, canCopy: true };
}

/** Sessions this machine has transcripts for, newest first. */
export function recentSessions(limit = 8) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const out = [];
  try {
    for (const dir of fs.readdirSync(root)) {
      const full = path.join(root, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith(".jsonl")) continue;
        const file = path.join(full, f);
        const st = fs.statSync(file);
        out.push({ project: dir, id: f.replace(/\.jsonl$/, ""), file, bytes: st.size, at: st.mtimeMs });
      }
    }
  } catch { /* no transcripts is a normal state */ }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

function projectSummary(dir) {
  const repo = path.resolve(dir);
  const exists = fs.existsSync(repo);
  const branch = exists ? git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) : { ok: false };
  const dirty = exists ? git(repo, ["status", "--porcelain"]) : { ok: false, out: "" };
  const index = exists ? indexStatus(repo) : null;
  const streams = Object.values(readStreams().streams ?? {})
    .filter((s) => path.resolve(s.repo) === repo);

  // A project IS a workspace: BMAD installs at this level, its documents
  // describe the system across services, and sessions run from here. The
  // repositories inside are services. So a project's graph is the union of its
  // services' graphs, and a project's checks are the checks its services
  // declare — reporting "none" at this level was reading the shape backwards.
  const workspace = isWorkspace(repo);
  const serviceList = workspace ? serviceGraphs(repo) : [];
  const graph = exists ? graphSummary(repo) : null;

  const graphBlocked = graph ? null
    : !has("uv") ? "uv is not installed, and graphify needs it — see https://docs.astral.sh/uv/"
      : !exists ? "the folder is gone"
        : workspace && !serviceList.length ? "no repositories found in this project yet"
          : null;

  return {
    key: projectKey(repo),
    path: repo,
    name: path.basename(repo),
    graphBlocked,
    workspace,
    exists,
    isRepo: exists && fs.existsSync(path.join(repo, ".git")),
    branch: branch.ok ? branch.out : null,
    dirtyFiles: dirty.ok ? dirty.out.split("\n").filter(Boolean).length : 0,
    hasBmad: exists && fs.existsSync(path.join(repo, "_bmad")),
    graph,
    // Checks belong to whatever declares them. In a workspace that is each
    // service, so they are reported per service rather than pretended away.
    checks: exists ? detectChecks(repo).map((c) => c.name) : [],
    services: workspace
      ? serviceList.map((svc) => ({
          name: svc.name,
          path: svc.path,
          key: projectKey(svc.path),
          indexed: svc.indexed,
          symbols: svc.symbols,
          needsIndex: !svc.indexed && svc.hasGraphFile,
          checks: detectChecks(svc.path).map((c) => c.name),
          branch: git(svc.path, ["rev-parse", "--abbrev-ref", "HEAD"]).out || null,
        }))
      : [],
    streams: streams.length,
    tasks: exists ? listTasks({ repo, state: "open" }).length : 0,
  };
}

export function buildApi() {
  return {
    // ------------------------------------------------------------- machine
    "/api/state": async () => {
      const db = openDb();
      const counts = db.prepare(`
        SELECT (SELECT count(*) FROM l1_facts WHERE superseded_by IS NULL) AS facts,
               (SELECT count(*) FROM l0_log) AS turns,
               (SELECT count(*) FROM tasks WHERE state = 'open') AS openTasks`).get();
      return {
        home: HOME,
        node: process.version,
        embeddings: embeddingsInstalled(),
        model: modelInstalled(),
        // Installed and running are different questions, and conflating them
        // showed an idle countdown for a model that had already shut down.
        modelRunning: modelInstalled() ? await llamaHealthy() : false,
        modelIdleMinutes: minutesIdle(),
        modelIdleLimit: IDLE_MINUTES,
        uv: !!has("uv"),
        agents: agents(),
        counts: { ...counts, pending: countPending() },
        projects: readRegistry().projects.map(projectSummary),
      };
    },

    "/api/model/health": async () => ({ running: await llamaHealthy() }),

    // ------------------------------------------------------------- browsing
    "/api/browse": ({ url }) => browse(url.searchParams.get("path")),

    // ------------------------------------------------------------- projects
    "POST /api/projects/add": ({ body }) => {
      const dir = path.resolve(body.path ?? "");
      if (!fs.existsSync(dir)) return { status: 400, body: { error: `no such directory: ${dir}` } };
      const reg = readRegistry();
      if (!reg.projects.some((p) => path.resolve(p) === dir)) reg.projects.push(dir);
      writeRegistry(reg);
      return { project: projectSummary(dir) };
    },

    "POST /api/projects/remove": ({ body }) => {
      const reg = readRegistry();
      reg.projects = reg.projects.filter((p) => projectKey(p) !== body.key);
      writeRegistry(reg);
      return { ok: true };
    },

    /**
     * One project, in as much depth as a dashboard can show without running
     * anything. Everything expensive — checks, verification, a fresh graph —
     * is a job the user starts deliberately.
     */
    "/api/project": ({ url }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === url.searchParams.get("key"));
      if (!dir) return { status: 404, body: { error: "project not registered" } };
      const repo = path.resolve(dir);
      const summary = projectSummary(repo);
      if (!summary.exists) return { project: summary };

      const graph = graphFor(repo);
      const specs = findSpecs(repo).map((s) => assess(s, { repo, sprintStatus: parseSprintStatus(repo) }));
      const streamRecords = Object.values(readStreams().streams ?? {})
        .filter((s) => path.resolve(s.repo) === repo)
        .map((s) => {
          const st = inspectStream(s, { sizes: false });
          return { name: s.name, branch: s.branch, ...classify(st, 14), dirty: st.dirty, pinned: !!st.pinned };
        });

      let risk = null;
      try {
        const survey = rankRisk(repo, { graph, limit: 8 });
        if (survey) {
          risk = {
            commits: survey.commits,
            rows: survey.rows.map((r) => ({ file: r.file, why: r.why, tested: r.tested, commits: r.commits, fan: r.fan })),
            coupling: coupling(survey.pairs, { keep: survey.isCode }).slice(0, 5),
          };
        }
      } catch { /* a repo with no history simply has no risk view */ }

      return {
        project: summary,
        trace: { summary: summarise(specs), stories: specs.map((s) => ({
          id: s.id, title: s.title, state: s.state, criteria: s.criteria.length,
          commands: s.commands.length, missingFiles: s.missingFiles.length,
        })) },
        risk,
        streams: streamRecords,
        tasks: listTasks({ repo, state: "all", limit: 12 }),
      };
    },

    "/api/task": ({ url }) => resumeTask(Number(url.searchParams.get("id"))) ?? { status: 404, body: { error: "no such task" } },

    // --------------------------------------------------------------- memory
    "/api/memory": ({ url }) => {
      const db = openDb();
      const q = (url.searchParams.get("q") ?? "").trim();
      const rows = q
        ? db.prepare(`SELECT id, kind, context, content, verify_state FROM l1_facts
                       WHERE superseded_by IS NULL AND content LIKE ? ORDER BY id DESC LIMIT 60`).all(`%${q}%`)
        : db.prepare(`SELECT id, kind, context, content, verify_state FROM l1_facts
                       WHERE superseded_by IS NULL ORDER BY id DESC LIMIT 60`).all();
      return { facts: rows, pending: listPending(20) };
    },

    // ---------------------------------------------------------------- stats
    "/api/stats": () => {
      const db = openDb();
      const rows = db.prepare(`
        SELECT tool, count(*) AS calls, sum(in_chars) AS inChars, sum(out_chars) AS outChars,
               sum(coalesce(baseline_chars, 0)) AS baseline
          FROM usage_log GROUP BY tool ORDER BY calls DESC`).all();
      const daily = db.prepare(`
        SELECT date(at) AS day, sum(out_chars) AS out, sum(coalesce(baseline_chars,0)) AS baseline, count(*) AS calls
          FROM usage_log GROUP BY day ORDER BY day DESC LIMIT 14`).all();
      const avoided = rows.reduce((n, r) => {
        if (r.tool === "digest" || r.tool === "caveman_compress") return n + Math.max(r.inChars - r.outChars, 0);
        return n + Math.max((r.baseline ?? 0) - r.outChars, 0);
      }, 0);
      return { rows, daily, avoided, sessions: recentSessions() };
    },

    // ----------------------------------------------------------------- jobs
    /**
     * Setting the machine up. The steps are the documented ones, in the
     * documented order, so what the wizard does and what the getting-started
     * page says can never drift apart.
     */
    "POST /api/setup/machine": ({ body }) => {
      const steps = [
        { label: "Install amalgam", command: `${CLI} install${body.embeddings ? " --with-embeddings" : ""}${body.model ? " --with-model" : ""}` },
        { label: "Wire every project on this machine", command: `${CLI} wire --user` },
        { label: "Put `amalgam` on PATH", command: `${CLI} shim`, optional: true },
        { label: "Check the result", command: `${CLI} status` },
      ];
      return { jobId: startJob(steps, { cwd: PKG, title: "Setting up amalgam" }).id };
    },

    /**
     * Setting a project up: BMAD if asked for, then a code graph, then wiring.
     * Graph last of the three because it is the slow one, and a user watching
     * a tracker should see the quick wins land first.
     */
    "POST /api/setup/project": ({ body }) => {
      const dir = path.resolve(body.path ?? "");
      if (!fs.existsSync(dir)) return { status: 400, body: { error: `no such directory: ${dir}` } };
      const steps = [];
      if (body.git && !fs.existsSync(path.join(dir, ".git"))) {
        steps.push({ label: "Initialise git", command: `git init -b main` });
      }
      if (body.bmad) {
        steps.push({ label: "Install BMAD workflows", command: `npx --yes bmad-method install --yes --tools claude-code --directory .` });
      }
      steps.push({ label: "Wire amalgam into this project", command: `${CLI} wire`, optional: true });
      steps.push({ label: "Build the code graph", command: `${CLI} graph` });
      const reg = readRegistry();
      if (!reg.projects.some((p) => path.resolve(p) === dir)) { reg.projects.push(dir); writeRegistry(reg); }
      return { jobId: startJob(steps, { cwd: dir, title: `Setting up ${path.basename(dir)}` }).id, project: projectSummary(dir) };
    },

    // ---------------------------------------------------------------- flows
    /**
     * Compose the prompt a flow would run, and show it before running it.
     * A button that hides what it is about to ask an agent to do is a button
     * nobody can review.
     */
    "POST /api/flow/compose": ({ body }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === body.key);
      if (!dir) return { status: 404, body: { error: "project not registered" } };
      const flow = compose(path.resolve(dir), body.flow);
      if (!flow) return { status: 400, body: { error: `no such flow: ${body.flow}` } };
      return { ...flow, canLaunch: agents().found.length > 0 };
    },

    "POST /api/flow/launch": ({ body }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === body.key);
      if (!dir) return { status: 404, body: { error: "project not registered" } };
      const flow = compose(path.resolve(dir), body.flow);
      if (!flow) return { status: 400, body: { error: `no such flow: ${body.flow}` } };
      return launch(path.resolve(dir), flow.prompt, { agent: agents().found[0] ?? null });
    },

    // ----------------------------------------------------------- the map
    /**
     * The project as a picture: services, and the contracts between them.
     *
     * Two levels, because they answer different questions. The map says which
     * components talk to which — the thing a diagram on a wall is usually
     * trying to say. A flow says what one request actually touches, end to
     * end, which is the thing you need before changing it.
     */
    "/api/map": async ({ url }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === url.searchParams.get("key"));
      if (!dir) return { status: 404, body: { error: "project not registered" } };
      const root = path.resolve(dir);
      const contracts = await loadContracts(root);
      // A single-repository project is one service, and it has a symbol count
      // like any other — reporting "no graph" for an indexed repo was the map
      // inventing a distinction the rest of the system does not make.
      const own = indexStatus(root);
      const svcs = isWorkspace(root)
        ? serviceGraphs(root)
        : [{ name: path.basename(root), path: root, symbols: own?.symbols ?? 0 }];

      // A file with no service prefix belongs to the project itself, which is
      // the single-repository case; naming it after the folder keeps one shape
      // for both.
      const owner = (side) => side.service ?? path.basename(root);

      const nodes = new Map();
      for (const s of svcs) nodes.set(s.name, { id: s.name, label: s.name, symbols: s.symbols ?? 0, kind: "service" });
      for (const e of contracts.edges) {
        for (const n of [owner(e.from), owner(e.to)]) {
          if (!nodes.has(n)) nodes.set(n, { id: n, label: n, symbols: 0, kind: "service" });
        }
      }

      // One line per pair of services, carrying the routes that justify it.
      const links = new Map();
      for (const e of contracts.edges) {
        const from = owner(e.from), to = owner(e.to);
        const key = `${from}->${to}`;
        if (!links.has(key)) links.set(key, { from, to, count: 0, routes: [] });
        const link = links.get(key);
        link.count++;
        if (link.routes.length < 12) link.routes.push({ method: e.method, path: e.path, confidence: e.confidence });
      }

      return {
        project: path.basename(root),
        projectPath: root,
        nodes: [...nodes.values()],
        links: [...links.values()],
        endpoints: contracts.edges.map((e) => ({
          method: e.method, path: e.path, confidence: e.confidence,
          from: e.from, to: e.to,
        })),
        orphanRoutes: contracts.orphanRoutes,
        orphanCalls: contracts.orphanCalls,
      };
    },

    /**
     * One request, end to end.
     *
     * The caller, the handler it reaches over HTTP, and what the handler goes
     * on to call — which is where a flow stops being a diagram and starts
     * being the answer to "what will this change break".
     */
    "/api/flow": async ({ url }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === url.searchParams.get("key"));
      if (!dir) return { status: 404, body: { error: "project not registered" } };
      const root = path.resolve(dir);
      const wanted = url.searchParams.get("path");
      const contracts = await loadContracts(root);
      const edges = contracts.edges.filter((e) => e.path === wanted);
      if (!edges.length) return { status: 404, body: { error: `no contract for ${wanted}` } };

      const graph = graphFor(root);
      const spans = graph ? symbolSpans(graph) : new Map();
      // Which symbol contains a given line: the call site and the handler are
      // positions in a file, and a flow is only useful in terms of functions.
      const symbolAt = (file, line) => {
        for (const s of spans.get(file) ?? []) {
          if (line >= s.from && line <= s.to) return { id: s.node.id, name: s.node.name, file: s.node.file, line: s.node.line };
        }
        return null;
      };

      const steps = edges.map((e) => {
        const caller = symbolAt(e.from.file, e.from.line);
        const handler = symbolAt(e.to.file, e.to.line);
        const downstream = handler && graph
          ? (graph.callees.get(handler.id) ?? []).slice(0, 12)
              .map((c) => graph.nodes.get(c.id)).filter(Boolean)
              .map((n) => ({ id: n.id, name: n.name, file: n.file, line: n.line }))
          : [];
        return { method: e.method, path: e.path, confidence: e.confidence, from: e.from, to: e.to, caller, handler, downstream };
      });
      return { path: wanted, steps };
    },

    /** Run one of amalgam's own read-only reports as a job, so it streams. */
    "POST /api/run": ({ body }) => {
      const dir = path.resolve(body.path ?? process.cwd());
      const allowed = {
        gate: `${CLI} gate`,
        trace: `${CLI} trace --verify`,
        survey: `${CLI} survey --run-checks`,
        collide: `${CLI} collide`,
        graph: `${CLI} graph`,
        contracts: `${CLI} contracts`,
        verify: `${CLI} memory verify`,
      };
      const command = allowed[body.what];
      if (!command) return { status: 400, body: { error: `not a runnable report: ${body.what}` } };
      return { jobId: startJob([{ label: body.what, command }], { cwd: dir, title: `Running ${body.what}` }).id };
    },
  };
}
