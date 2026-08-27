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
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HOME, modelInstalled, llamaHealthy, minutesIdle, IDLE_MINUTES } from "./services.mjs";
import { embeddingsInstalled, embed, toBlob, fromBlob, similarity } from "./embed.mjs";
import { open as openDb } from "./db.mjs";
import { listTasks, resume as resumeTask } from "./tasks.mjs";
import { readStreams, inspectStream, classify, createStream } from "./streams.mjs";
import { detectChecks } from "./gates.mjs";
import { findSpecs, parseSprintStatus, assess, summarise } from "./trace.mjs";
import { rank as rankRisk, coupling } from "./survey.mjs";
import { isIndexed, graphFromDb, indexStatus, forgetIndex } from "./graphdb.mjs";
import { isWorkspace, services as workspaceServices, serviceGraphs, graphSummary, graphFor as graphForAny, searchWorkspace } from "./workspace.mjs";
import { loadGraph } from "./graph.mjs";
import { countPending, listPending, acceptPending, rejectPending, supersede } from "./capture.mjs";
import { verifyFact } from "./verify.mjs";
import { readRegistry, writeRegistry, projectKey, browse, startJob } from "./uiserver.mjs";
import { compose, launch } from "./uiflows.mjs";
import { builtGraphs, visVendored } from "./graphpage.mjs";
import { workflows } from "./workflows.mjs";
import { machineGaps } from "./readiness.mjs";
import { scenarios, roles } from "./scenarios.mjs";
import { agentCli, rescanAgent, startSession, send as sessionSend, stopSession,
         forgetSession, getSession, listSessions, view as sessionView,
         PERMISSION_MODES } from "./session.mjs";
import { loadContracts, forgetContracts } from "./contracts.mjs";
import { symbolSpans, findSymbols } from "./graph.mjs";
import { overview as exploreOverview, symbol as exploreSymbol, neighbourhood as exploreNeighbourhood,
         shortestPath as explorePath, impact as exploreImpact, tree as exploreTree } from "./explore.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = `node "${path.join(PKG, "bin", "amalgam.mjs")}"`;

const git = (repo, args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

/**
 * The same thing, without blocking the event loop.
 *
 * Spawning a process costs about 100ms on Windows whatever it does, and the
 * projects list was making nineteen of them one after another: two seconds to
 * answer a question about four folders. They do not depend on each other, so
 * they should not wait for each other.
 */
const gitAsync = (repo, args) => new Promise((resolve) => {
  let out = "";
  try {
    const child = spawn("git", ["-C", repo, ...args], { windowsHide: true });
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve({ ok: false, out: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
  } catch { resolve({ ok: false, out: "" }); }
});

/**
 * Where a command lives, asked once.
 *
 * `where` costs the same ~130ms as any other process on Windows, and the
 * projects list was asking whether `uv` exists once per project — half a
 * second of the two it took, to answer a question whose answer cannot change
 * while the interface is open. PATH does not move under a running process, so
 * the answer is kept.
 */
const whichCache = new Map();
const has = (cmd) => {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
  const at = r.status === 0 ? (r.stdout ?? "").split(/\r?\n/)[0].trim() : null;
  whichCache.set(cmd, at);
  return at;
};

// One entry point that handles a service or a whole project.
const graphFor = (repo) => { try { return graphForAny(repo); } catch { return null; } };

/** Recursive size, for telling someone how much a deletion would reclaim. */
function dirBytes(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      try { total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; } catch { /* raced */ }
    }
  } catch { /* unreadable */ }
  return total;
}

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

/**
 * One project, as much of it as the caller asked for.
 *
 * `deep` is the difference between a card in a list and the page about one
 * project. The card never shows a service's branch, so computing it cost a
 * process spawn per service for something nobody reads. Everything git-related
 * runs concurrently either way.
 */
async function projectSummary(dir, { deep = false } = {}) {
  const repo = path.resolve(dir);
  const exists = fs.existsSync(repo);
  const [branch, dirty] = exists
    ? await Promise.all([
        gitAsync(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
        gitAsync(repo, ["status", "--porcelain"]),
      ])
    : [{ ok: false }, { ok: false, out: "" }];
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

  // Per-service branches, in parallel, and only when somebody will see them.
  const branches = deep
    ? Object.fromEntries(await Promise.all(serviceList.map(async (svc) =>
        [svc.name, (await gitAsync(svc.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out || null])))
    : {};

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
          branch: branches[svc.name] ?? null,
        }))
      : [],
    streams: streams.length,
    tasks: exists ? listTasks({ repo, state: "open" }).length : 0,
  };
}

export function buildApi() {
  /** The registered project a request is about, or null. */
  const projectRoot = (url) => {
    const dir = readRegistry().projects.find((p) => projectKey(p) === url.searchParams.get("key"));
    return dir ? path.resolve(dir) : null;
  };

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
        // Concurrently: these are separate folders and nothing about one
        // informs another.
        projects: await Promise.all(readRegistry().projects.map((p) => projectSummary(p))),
      };
    },

    "/api/model/health": async () => ({ running: await llamaHealthy() }),

    /**
     * What amalgam does on its own, and what it would do next.
     *
     * The one thing here that spends the machine without being asked, so it
     * is the one thing that should not be invisible or environment-only.
     */
    "/api/refresh": async () => {
      const { refreshPlan, autoRefreshEnabled, autoRefreshForced, lastRun, BUDGET_MS, COOLDOWN_MS } =
        await import("./refresh.mjs");
      return {
        on: autoRefreshEnabled(),
        forced: autoRefreshForced(),
        budgetMs: BUDGET_MS,
        cooldownMs: COOLDOWN_MS,
        // What it did, not what it intended. Reporting only the plan is how
        // this spent its whole life broken while every screen looked right.
        last: lastRun(),
        plan: refreshPlan(),
      };
    },

    "POST /api/refresh/auto": async ({ body }) => {
      const { setAutoRefresh, autoRefreshForced } = await import("./refresh.mjs");
      if (autoRefreshForced()) {
        return { status: 409, body: { error: "AMALGAM_AUTO_REFRESH is set in this environment and wins" } };
      }
      return { on: setAutoRefresh(!!body.on) };
    },

    // ------------------------------------------------------------- browsing
    "/api/browse": ({ url }) => browse(url.searchParams.get("path")),

    // ------------------------------------------------------------- projects
    "POST /api/projects/add": async ({ body }) => {
      const dir = path.resolve(body.path ?? "");
      if (!fs.existsSync(dir)) return { status: 400, body: { error: `no such directory: ${dir}` } };
      const reg = readRegistry();
      if (!reg.projects.some((p) => path.resolve(p) === dir)) reg.projects.push(dir);
      writeRegistry(reg);
      return { project: await projectSummary(dir, { deep: true }) };
    },

    /**
     * What removal would delete, before anybody agrees to it.
     *
     * Generated things are safe to lose and can be rebuilt; a repository is
     * somebody's work. Nothing in this list is ever a repository, and the
     * interface shows the list before the button does anything.
     */
    "/api/projects/removable": ({ url }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === url.searchParams.get("key"));
      if (!dir) return { status: 404, body: { error: "project not registered" } };
      const root = path.resolve(dir);
      const svcs = workspaceServices(root);

      const size = (p) => { try { return fs.statSync(p).isDirectory() ? dirBytes(p) : fs.statSync(p).size; } catch { return 0; } };
      const graphDirs = [root, ...svcs.map((sv) => sv.path)]
        .map((d) => path.join(d, "graphify-out")).filter((d) => fs.existsSync(d));
      const bmadDirs = ["_bmad", "_bmad-output"].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
      const wiring = [".mcp.json", path.join(".vscode", "mcp.json"), path.join(".claude", "settings.json")]
        .map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));

      const db = openDb();
      const indexed = [root, ...svcs.map((sv) => sv.path)].filter((d) => isIndexed(d)).length;
      const tasks = db.prepare(`SELECT count(*) AS n FROM tasks WHERE repo = ?`).get(root).n;

      return {
        project: path.basename(root), path: root,
        services: svcs.map((sv) => sv.name),
        graph: { dirs: graphDirs.map((d) => path.relative(root, d).split("\\").join("/")), indexed,
                 bytes: graphDirs.reduce((n, d) => n + size(d), 0) },
        bmad: { dirs: bmadDirs.map((d) => path.basename(d)), bytes: bmadDirs.reduce((n, d) => n + size(d), 0) },
        wiring: { files: wiring.map((f) => path.relative(root, f).split("\\").join("/")) },
        tasks,
      };
    },

    /**
     * Take a project off the list, and optionally the things amalgam generated.
     *
     * The default removes nothing but the list entry. Each extra is opt-in and
     * named, because "delete project" means different things to different
     * people and the expensive misunderstanding is only ever in one direction.
     * Repositories are never touched, whatever is ticked.
     */
    "POST /api/projects/remove": ({ body }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === body.key);
      const root = dir ? path.resolve(dir) : null;
      const also = body.also ?? {};
      const removed = [];

      if (root) {
        const svcs = workspaceServices(root);
        const gone = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } };

        if (also.graph) {
          for (const d of [root, ...svcs.map((sv) => sv.path)]) {
            const g = path.join(d, "graphify-out");
            if (fs.existsSync(g) && gone(g)) removed.push(path.relative(root, g).split("\\").join("/"));
            forgetIndex(d);
          }
          forgetContracts(root);
          removed.push("code index and contracts");
        }
        if (also.bmad) {
          for (const name of ["_bmad", "_bmad-output"]) {
            const d = path.join(root, name);
            if (fs.existsSync(d) && gone(d)) removed.push(name);
          }
        }
        if (also.wiring) {
          for (const rel of [".mcp.json", path.join(".vscode", "mcp.json"), path.join(".claude", "settings.json")]) {
            const f = path.join(root, rel);
            if (fs.existsSync(f) && gone(f)) removed.push(rel.split("\\").join("/"));
          }
        }
        if (also.tasks) {
          const db = openDb();
          const ids = db.prepare(`SELECT id FROM tasks WHERE repo = ?`).all(root).map((r) => r.id);
          for (const id of ids) db.prepare(`DELETE FROM task_events WHERE task_id = ?`).run(id);
          db.prepare(`DELETE FROM tasks WHERE repo = ?`).run(root);
          if (ids.length) removed.push(`${ids.length} work item(s)`);
        }
      }

      reg.projects = reg.projects.filter((p) => projectKey(p) !== body.key);
      writeRegistry(reg);
      return { ok: true, removed };
    },

    /**
     * One project, in as much depth as a dashboard can show without running
     * anything. Everything expensive — checks, verification, a fresh graph —
     * is a job the user starts deliberately.
     */
    "/api/project": async ({ url }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === url.searchParams.get("key"));
      if (!dir) return { status: 404, body: { error: "project not registered" } };

      // A service is viewed THROUGH its project rather than registered as one
      // of its own. Opening a repository to look at it should not change what
      // is on the list, and the previous behaviour left people with entries
      // they had never meant to add and no way to take them off.
      const wanted = url.searchParams.get("service");
      const parent = path.resolve(dir);
      const repo = wanted
        ? (workspaceServices(parent).find((sv) => sv.name === wanted)?.path ?? parent)
        : parent;
      if (wanted && !path.resolve(repo).startsWith(parent)) {
        return { status: 400, body: { error: "not a service of this project" } };
      }
      const summary = { ...(await projectSummary(repo, { deep: true })), viewingService: wanted ?? null, parentKey: wanted ? projectKey(parent) : null, parentName: wanted ? path.basename(parent) : null };
      if (!summary.exists) return { project: summary };

      // A workspace's streams belong to its services, not to the folder that
      // contains them, so matching only the root hid every stream a
      // multi-repository project had. The path travels with the record
      // because a stream is somewhere to work, and work needs a directory.
      const owners = new Set([repo, ...(summary.services ?? []).map((sv) => path.resolve(sv.path))]);
      const streamRecords = Object.values(readStreams().streams ?? {})
        .filter((sv) => owners.has(path.resolve(sv.repo)))
        .map((sv) => {
          const st = inspectStream(sv, { sizes: false });
          return {
            name: sv.name, branch: sv.branch, path: sv.path, repo: sv.repo,
            of: path.basename(sv.repo), purpose: sv.purpose || null,
            ...classify(st, 14), dirty: st.dirty, pinned: !!sv.pinned,
          };
        });

      return {
        project: summary,
        streams: streamRecords,
        tasks: listTasks({ repo, state: "all", limit: 12 }),
      };
    },

    /**
     * The expensive half, asked for separately.
     *
     * Reading a year of history and walking a tree for specs takes
     * milliseconds on a small repository and minutes on a large one. Doing it
     * inside the detail request meant a big service simply never opened — so
     * the page renders on what is cheap, and this fills in behind it.
     */
    "/api/insight": ({ url }) => {
      const reg = readRegistry();
      const dir = reg.projects.find((p) => projectKey(p) === url.searchParams.get("key"));
      if (!dir) return { status: 404, body: { error: "project not registered" } };
      const parent = path.resolve(dir);
      const wanted = url.searchParams.get("service");
      const repo = wanted
        ? (workspaceServices(parent).find((sv) => sv.name === wanted)?.path ?? parent)
        : parent;

      const specs = findSpecs(repo).map((sp) => assess(sp, { repo, sprintStatus: parseSprintStatus(repo) }));
      let risk = null;
      try {
        const survey = rankRisk(repo, { graph: graphFor(repo), limit: 8, days: Number(url.searchParams.get("days") ?? 365) });
        if (survey) {
          risk = {
            commits: survey.commits,
            rows: survey.rows.map((r) => ({ file: r.file, why: r.why, tested: r.tested, commits: r.commits, fan: r.fan })),
            coupling: coupling(survey.pairs, { keep: survey.isCode }).slice(0, 5),
          };
        }
      } catch { /* a repo with no history simply has no risk view */ }

      return {
        trace: { summary: summarise(specs), stories: specs.map((sp) => ({
          id: sp.id, title: sp.title, state: sp.state, criteria: sp.criteria.length,
          commands: sp.commands.length, missingFiles: sp.missingFiles.length,
        })) },
        risk,
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

    /**
     * Accept proposals, from the screen that shows them.
     *
     * This lived only in a terminal, which meant the page listing what was
     * waiting could do nothing about it — the same split that had adding a
     * project filed under Setup. Twenty-four proposals had accumulated behind
     * that gap, which is a fair measure of what it cost.
     *
     * The interesting half is what comes back. Accepting reports anything the
     * new fact may replace, and the store never decides that on its own: a
     * near-duplicate is a question for a person, because "replaces" and
     * "coexists with" look identical to a similarity score.
     */
    "POST /api/memory/accept": async ({ body }) => {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isFinite);
      if (!ids.length) return { status: 400, body: { error: "nothing selected" } };

      let vectors = {};
      try {
        const { embed, similarity, fromBlob, toBlob, embeddingsInstalled } = await import("./embed.mjs");
        if (embeddingsInstalled()) vectors = { embed, toBlob, similarity, fromBlob };
      } catch { /* a fact with no vector is still a fact */ }

      return { saved: await acceptPending(ids, { verifyFact, ...vectors }), pending: listPending(20) };
    },

    "POST /api/memory/reject": ({ body }) => {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isFinite);
      if (!ids.length) return { status: 400, body: { error: "nothing selected" } };
      return { rejected: rejectPending(ids), pending: listPending(20) };
    },

    /** Retire the fact a newly accepted one replaces. Never automatic. */
    "POST /api/memory/supersede": ({ body }) => {
      const newId = Number(body.newId);
      const oldIds = (Array.isArray(body.oldIds) ? body.oldIds : []).map(Number).filter(Number.isFinite);
      if (!Number.isFinite(newId) || !oldIds.length) return { status: 400, body: { error: "need both ids" } };
      const n = supersede(newId, oldIds);
      if (n < 0) return { status: 404, body: { error: `no fact L1:${newId}` } };
      return { superseded: n };
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
    /**
     * Is amalgam actually installed on this machine, and is it current?
     *
     * The UI can run from a clone that was never installed — the pages load
     * either way — so "you are looking at it" is not evidence that the parts
     * agents use are in place. This answers the two questions that matter
     * without doing anything: what is deployed, and what is available.
     */
    "/api/install": () => {
      const stamp = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(HOME, "installed.json"), "utf8")); } catch { return null; }
      })();
      const source = git(PKG, ["rev-parse", "--short", "HEAD"]);
      const version = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version; } catch { return null; }
      })();
      const wired = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(HOME, "wired.json"), "utf8")); } catch { return { user: false, projects: [] }; }
      })();
      // Uncommitted work in the clone means `amalgam update` will decline to
      // pull, which is the right behaviour but a confusing one to discover
      // from a spinner, so it is said in advance.
      const dirty = git(PKG, ["status", "--porcelain"]).out;
      return {
        installed: !!stamp && fs.existsSync(path.join(HOME, "lib")),
        home: HOME,
        source: PKG,
        isClone: source.ok,
        dirty: source.ok ? dirty.split("\n").filter(Boolean).length : 0,
        deployedCommit: stamp?.commit ?? null,
        sourceCommit: source.ok ? source.out : null,
        // Stale means the clone has moved on from what was deployed — a git
        // pull without an update, which is exactly what the update button is
        // for.
        stale: !!(stamp?.commit && source.ok && stamp.commit !== source.out),
        version: stamp?.version ?? version,
        installedAt: stamp?.installedAt ?? null,
        wiredUser: !!wired.user,
        wiredProjects: (wired.projects ?? []).length,
      };
    },

    /**
     * Update in place: pull, re-deploy, re-wire.
     *
     * Everything amalgam does is a command, and until now this was the one
     * command you had to leave the UI to run — which meant the UI was the
     * only part of amalgam that could not keep itself current. `amalgam
     * update` already pulls before it deploys, and the built pages are
     * committed, so pulling updates the UI too. The page reloads afterwards
     * because it is serving itself from what just changed.
     */
    "POST /api/update": ({ body }) => {
      // The same flag the command line takes. Offered rather than assumed:
      // building every graph a machine still needs can be minutes of its time.
      const build = body?.build ? " --build" : "";
      const steps = [
        { label: build ? "Pull, re-deploy, re-wire and build" : "Pull, re-deploy and re-wire",
          command: `${CLI} update${build}` },
        { label: "Check the result", command: `${CLI} status` },
      ];
      return { jobId: startJob(steps, { cwd: PKG, title: "Updating amalgam" }).id };
    },

    /**
     * Moving a machine, from the interface.
     *
     * The commands existed and the screen that talks about machines did not
     * offer them, which is the split that had adding a project under Setup and
     * the review queue behind a terminal. Both directions are one folder.
     */
    "POST /api/transfer/export": async ({ body }) => {
      const dir = String(body.dir ?? "").trim();
      if (!dir) return { status: 400, body: { error: "no folder chosen" } };
      const { exportBundle } = await import("./transfer.mjs");
      try {
        const carried = await exportBundle(dir);
        return { dir: path.resolve(dir), carried };
      } catch (e) { return { status: 400, body: { error: e.message } }; }
    },

    "POST /api/transfer/import": async ({ body }) => {
      const dir = String(body.dir ?? "").trim();
      if (!dir) return { status: 400, body: { error: "no folder chosen" } };
      let vectors = {};
      try {
        const { embed, similarity, embeddingsInstalled } = await import("./embed.mjs");
        if (embeddingsInstalled()) vectors = { embed, similarity };
      } catch { /* text comparison is enough */ }

      const { importFrom } = await import("./transfer.mjs");
      const r = await importFrom(dir, { replace: !!body.replace, ...vectors });
      if (r.error) return { status: 400, body: { error: r.error } };
      return r;
    },

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
     * What a directory is, before anything is done to it.
     *
     * A new project needs an empty folder — dropping a workspace on top of an
     * existing tree produces something nobody can reason about later. An
     * existing project needs the opposite: whatever repositories are already
     * there. Same question, so it is answered once and the wizard decides what
     * to do with the answer.
     */
    "/api/project/inspect": ({ url }) => {
      const dir = path.resolve(url.searchParams.get("path") ?? "");
      const exists = fs.existsSync(dir);
      let entries = [];
      try { entries = exists ? fs.readdirSync(dir).filter((e) => e !== ".DS_Store") : []; } catch { /* unreadable */ }
      const svcs = exists ? workspaceServices(dir) : [];
      return {
        path: dir,
        exists,
        empty: exists && entries.length === 0,
        entries: entries.slice(0, 12),
        entryCount: entries.length,
        isRepo: exists && fs.existsSync(path.join(dir, ".git")),
        hasBmad: exists && fs.existsSync(path.join(dir, "_bmad")),
        services: svcs.map((sv) => ({ name: sv.name, path: sv.path })),
        registered: readRegistry().projects.some((p) => path.resolve(p) === dir),
      };
    },

    /** Create the folder for a new project. Refuses to reuse a full one. */
    "POST /api/project/create": async ({ body }) => {
      const dir = path.resolve(body.path ?? "");
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir).filter((e) => e !== ".DS_Store");
        if (entries.length) {
          return { status: 400, body: { error: `${dir} is not empty. Start a new project in an empty folder, or add this one as an existing project.` } };
        }
      } else {
        fs.mkdirSync(dir, { recursive: true });
      }
      const reg = readRegistry();
      if (!reg.projects.some((p) => path.resolve(p) === dir)) { reg.projects.push(dir); writeRegistry(reg); }
      return { project: await projectSummary(dir, { deep: true }) };
    },

    /**
     * Put a repository into a project.
     *
     * Two ways, because a project starts one of two ways: code that already
     * exists somewhere, or code that does not exist yet. Cloning reaches the
     * network — the only thing here that does — and it is the user's own
     * remote, asked for explicitly.
     */
    "POST /api/service/add": ({ body }) => {
      const project = path.resolve(body.project ?? "");
      if (!fs.existsSync(project)) return { status: 400, body: { error: "project folder does not exist" } };

      const name = (body.name ?? "").trim() || (body.url ?? "").split("/").pop()?.replace(/\.git$/, "") || "";
      if (!/^[\w.-]+$/.test(name)) return { status: 400, body: { error: "give the repository a simple name" } };
      const target = path.join(project, name);
      if (fs.existsSync(target)) return { status: 400, body: { error: `${name} already exists in this project` } };

      const steps = body.url
        ? [{ label: `Clone ${name}`, command: `git clone ${JSON.stringify(body.url)} ${JSON.stringify(name)}` }]
        : [
            { label: `Create ${name}`, command: process.platform === "win32" ? `mkdir ${JSON.stringify(name)}` : `mkdir -p ${JSON.stringify(name)}` },
            { label: `Initialise git in ${name}`, command: `git init -b main`, cwd: target },
          ];
      return { jobId: startJob(steps, { cwd: project, title: `Adding ${name}` }).id, name };
    },

    /**
     * Taking a repository out of a project.
     *
     * A service belongs to a project by sitting inside its folder, so removing
     * one means either moving it out or deleting it — there is no list to edit.
     * Moving it out is the default and the safe one: the repository survives
     * intact next to the project, and only its contribution to the project's
     * graph goes away. Deleting is possible because sometimes a clone really
     * was a mistake, but it is opt-in and says so.
     */
    "POST /api/service/remove": async ({ body }) => {
      const project = path.resolve(body.project ?? "");
      const name = (body.name ?? "").trim();
      if (!/^[\w.-]+$/.test(name)) return { status: 400, body: { error: "which repository?" } };

      const target = path.join(project, name);
      if (!target.startsWith(project + path.sep)) {
        return { status: 400, body: { error: "not a repository of this project" } };
      }
      if (!fs.existsSync(target)) return { status: 400, body: { error: `${name} is not in this project` } };

      // Whichever way it goes, the index and the contracts must stop claiming
      // this code is part of the project — otherwise the totals keep counting
      // a service that is no longer there.
      forgetIndex(target);
      await forgetContracts(project).catch(() => {});

      const steps = [];
      if (body.deleteFiles) {
        steps.push({
          label: `Delete ${name}`,
          command: process.platform === "win32"
            ? `rmdir /s /q ${JSON.stringify(name)}`
            : `rm -rf ${JSON.stringify(name)}`,
        });
      } else {
        // Beside the project, not inside it: it stops being a service and
        // stays a repository. A name that is already taken gets a suffix
        // rather than overwriting somebody's work.
        const parent = path.dirname(project);
        let dest = path.join(parent, name);
        for (let n = 2; fs.existsSync(dest); n++) dest = path.join(parent, `${name}-${n}`);
        steps.push({
          label: `Move ${name} out of the project`,
          command: process.platform === "win32"
            ? `move ${JSON.stringify(target)} ${JSON.stringify(dest)}`
            : `mv ${JSON.stringify(target)} ${JSON.stringify(dest)}`,
        });
      }
      steps.push({ label: "Re-check the links between services", command: `${CLI} contracts`, optional: true });

      return { jobId: startJob(steps, { cwd: project, title: `Removing ${name}` }).id };
    },

    /**
     * Setting a project up: BMAD if asked for, then a code graph, then wiring.
     * Graph last of the three because it is the slow one, and a user watching
     * a tracker should see the quick wins land first.
     */
    "POST /api/project/setup": async ({ body }) => {
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
      // A project is not ready until the links between its services are known:
      // the graph alone stops at each repository's edge.
      steps.push({ label: "Find the links between services", command: `${CLI} contracts`, optional: true });
      const reg = readRegistry();
      if (!reg.projects.some((p) => path.resolve(p) === dir)) { reg.projects.push(dir); writeRegistry(reg); }
      return { jobId: startJob(steps, { cwd: dir, title: `Setting up ${path.basename(dir)}` }).id, project: await projectSummary(dir, { deep: true }) };
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

      // Services this project does not contain, drawn because they are part of
      // the picture even though nothing here can be said about their insides.
      // The name comes from how the calling code addresses them — `${BILLING}`
      // is the only identity a configured host leaves behind.
      const externals = new Map();
      for (const o of contracts.orphanCalls) {
        const name = o.baseName || "outside this project";
        if (!externals.has(name)) externals.set(name, { id: name, label: name, kind: "external", calls: [] });
        externals.get(name).calls.push({ from: o.service ?? path.basename(root), method: o.method, path: o.path, file: o.file, line: o.line });
      }

      // One line per pair, carrying the routes that justify it.
      const links = new Map();
      const link = (from, to, route, kind) => {
        const key = `${from}->${to}`;
        if (!links.has(key)) links.set(key, { from, to, count: 0, routes: [], kind });
        const l = links.get(key);
        l.count++;
        if (l.routes.length < 12) l.routes.push(route);
      };
      for (const e of contracts.edges) {
        link(owner(e.from), owner(e.to), { method: e.method, path: e.path, confidence: e.confidence }, "internal");
      }
      for (const ext of externals.values()) {
        for (const c of ext.calls) link(c.from, ext.id, { method: c.method, path: c.path, confidence: "outside" }, "external");
      }

      /**
       * Viewing one service means viewing its neighbourhood, not the project.
       *
       * The whole-project picture is the same picture whichever service you
       * came from, which makes opening a service feel like it did nothing.
       * What is wanted is this service in the middle, whatever calls into it
       * on one side, and whatever it calls on the other — including the things
       * outside this project that only it talks to.
       */
      const focus = url.searchParams.get("service");
      let shownNodes = [...nodes.values(), ...externals.values()];
      let shownLinks = [...links.values()];

      if (focus && shownNodes.some((n) => n.id === focus)) {
        const upstream = shownLinks.filter((l) => l.to === focus).map((l) => l.from);
        const downstream = shownLinks.filter((l) => l.from === focus).map((l) => l.to);
        const keep = new Set([focus, ...upstream, ...downstream]);
        shownNodes = shownNodes.filter((n) => keep.has(n.id)).map((n) => ({
          ...n,
          // Which side of the middle it sits on, so the drawing can place it
          // without guessing.
          role: n.id === focus ? "focus" : upstream.includes(n.id) ? "upstream" : "downstream",
        }));
        // Only the edges that touch it: a link between two of its neighbours
        // is true, but it is not what you opened this to see.
        shownLinks = shownLinks.filter((l) => l.from === focus || l.to === focus);
      }

      const inScope = (side) => !focus || owner(side) === focus;

      return {
        project: path.basename(root),
        projectPath: root,
        focus: focus ?? null,
        services: svcs.map((x) => x.name),
        nodes: shownNodes,
        links: shownLinks,
        endpoints: contracts.edges
          .filter((e) => !focus || inScope(e.from) || inScope(e.to))
          .map((e) => ({
            method: e.method, path: e.path, confidence: e.confidence,
            from: e.from, to: e.to,
          })),
        orphanRoutes: contracts.orphanRoutes.filter((o) => !focus || (o.service ?? path.basename(root)) === focus),
        orphanCalls: contracts.orphanCalls.filter((o) => !focus || (o.service ?? path.basename(root)) === focus),
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

    /**
     * Which services have graphify's interactive page built, and whether it
     * can be opened without the network.
     */
    "/api/graphpages": ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      return { vendored: visVendored(), services: builtGraphs(root) };
    },

    /**
     * What this machine still needs.
     *
     * Neither Reinstall nor Update covers all of it — reinstalling deploys
     * amalgam, updating brings new code, and neither signs an agent in,
     * fetches a drawing library, or rebuilds an index that failed on an older
     * version. Asking somebody to know which button covers which part is a
     * question the page should answer rather than pose.
     */
    "/api/machine/gaps": () => ({ gaps: machineGaps() }),

    /** Fetch the drawing library once, so the page works offline. */
    "POST /api/graphpages/vendor": () => ({
      jobId: startJob([{ label: "Fetch the drawing library", command: `${CLI} vendor-graph` }],
        { cwd: PKG, title: "Making the graph work offline" }).id,
    }),

    /**
     * The planning workflows this project has installed.
     *
     * Read from disk rather than listed here, so a BMAD upgrade that adds one
     * shows up without amalgam being taught about it. Most people want the
     * one that answers questions; the rest are worth having findable and not
     * worth putting in anybody's way.
     */
    "/api/workflows": ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const all = workflows(root);
      return {
        // What somebody sitting down actually wants to do, and what each one
        // runs. The command is carried but is not the headline.
        tasks: scenarios(all),
        // The same tasks ordered for who is asking. A lens, not a filter:
        // nothing here is missing from `tasks`.
        roles: roles(all),
        // BMAD ships its own help. Exposing it beats reimplementing it.
        help: all.find((w) => w.name === "bmad-help") ?? null,
        choosers: all.filter((w) => w.chooser)
          .map((w) => ({ name: w.name, command: w.command, title: w.chooser.title, description: w.description })),
        all: all.map((w) => ({ name: w.name, command: w.command, description: w.description, group: w.group })),
      };
    },

    // -------------------------------------------------------------- sessions
    //
    // The interface driving the agent rather than describing what you could
    // type at it. Everything here is one long-lived child process per session,
    // spoken to in the agent's own streaming protocol.

    /** Can this machine drive an agent at all, and how. */
    "/api/agent": () => ({
      cli: agentCli(),
      modes: PERMISSION_MODES,
      sessions: listSessions(),
    }),

    /**
     * Install the agent CLI.
     *
     * The one thing amalgam installs that is not its own: without it the
     * interface can only ever compose a prompt for somebody to paste, which
     * is the half-a-tool this whole section exists to end.
     */
    "POST /api/agent/install": () => ({
      jobId: startJob([
        { label: "Install the Claude Code CLI", command: `npm install -g @anthropic-ai/claude-code` },
        { label: "Check it is on PATH", command: `claude --version` },
      ], { cwd: HOME, title: "Installing the agent CLI" }).id,
    }),

    /** PATH changed under us; look again. */
    "POST /api/agent/rescan": () => { rescanAgent(); return { cli: agentCli() }; },

    "POST /api/session/start": ({ body }) => {
      const cwd = path.resolve(body.cwd ?? "");
      if (!fs.existsSync(cwd)) return { status: 400, body: { error: "that folder does not exist" } };
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) return { status: 400, body: { error: "nothing to send" } };
      if (!PERMISSION_MODES.some((m) => m.id === body.permissionMode)) {
        return { status: 400, body: { error: "unknown permission mode" } };
      }
      const out = startSession({
        cwd, prompt,
        title: body.title || "Session",
        model: body.model || null,
        permissionMode: body.permissionMode,
      });
      if (out.error) return { status: 409, body: { error: `${out.error} — install it from Setup` } };
      return out;
    },

    "POST /api/session/send": ({ body }) => {
      const s = getSession(String(body.id ?? ""));
      if (!s) return { status: 404, body: { error: "no such session" } };
      const text = String(body.text ?? "").trim();
      if (!text) return { status: 400, body: { error: "nothing to send" } };
      if (!sessionSend(s, text)) return { status: 409, body: { error: "that session is not running" } };
      return { ok: true };
    },

    "/api/session": ({ url }) => {
      const s = getSession(url.searchParams.get("id") ?? "");
      return s ? sessionView(s) : { status: 404, body: { error: "no such session" } };
    },

    "POST /api/session/stop": ({ body }) => {
      const s = getSession(String(body.id ?? ""));
      if (!s) return { status: 404, body: { error: "no such session" } };
      stopSession(s);
      return { ok: true };
    },

    "POST /api/session/forget": ({ body }) => ({ ok: forgetSession(String(body.id ?? "")) }),

    /**
     * Which model this task deserves, decided locally.
     *
     * A preview rather than an instruction: the interface shows the answer and
     * the reason before anything runs, and the session start takes whatever
     * model it is given. Nothing here changes a model on somebody's behalf.
     */
    "POST /api/route": async ({ body }) => {
      const { route, routingEnabled } = await import("./router.mjs");
      const task = String(body.task ?? "").trim();
      if (!task) return { status: 400, body: { error: "nothing to size" } };
      if (!routingEnabled()) return { off: true };
      return await route(task, { permissionMode: body.permissionMode ?? null });
    },

    /** The tiers, what each maps to here, and whether routing is on at all. */
    "/api/models": async () => {
      const { TIERS, models, routingEnabled, DEFAULT_TIER } = await import("./router.mjs");
      return {
        enabled: routingEnabled(),
        forced: !!process.env.AMALGAM_ROUTE_MODELS,
        defaultTier: DEFAULT_TIER,
        tiers: TIERS.map((t) => ({
          id: t.id, label: t.label, note: t.note, price: t.price, context: t.context,
        })),
        models: models(),
      };
    },

    "POST /api/models": async ({ body }) => {
      const { setRouting, setModel, models, routingEnabled } = await import("./router.mjs");
      if (process.env.AMALGAM_ROUTE_MODELS) {
        return { status: 409, body: { error: "AMALGAM_ROUTE_MODELS is set in this environment and wins" } };
      }
      if (body.enabled !== undefined) setRouting(!!body.enabled);
      if (body.tier) {
        const r = setModel(String(body.tier), String(body.model ?? ""));
        if (r.error) return { status: 400, body: { error: r.error } };
      }
      return { enabled: routingEnabled(), models: models() };
    },

    /**
     * Every session belonging to one project, running or finished.
     *
     * Without this a session is reachable only through a URL somebody
     * happened to keep: the agent is alive, spending tokens, and there is no
     * way back to it. Membership is by directory, so a session started in a
     * service or in a work stream still belongs to the project it came from.
     */
    "/api/sessions": ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const inside = (dir) => {
        const rel = path.relative(root, dir);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      };
      // A worktree lives beside its repository rather than inside it, so it
      // has to be claimed explicitly or it would look like somebody else's.
      const streams = Object.values(readStreams().streams ?? {})
        .filter((st) => inside(path.resolve(st.repo)));
      const owned = new Map(streams.map((st) => [path.resolve(st.path), st.name]));

      return {
        sessions: listSessions()
          .filter((s) => inside(path.resolve(s.cwd)) || owned.has(path.resolve(s.cwd)))
          .map((s) => ({
            ...s,
            // Where it is working, said the way somebody would say it.
            where: owned.get(path.resolve(s.cwd))
              ?? (path.resolve(s.cwd) === root ? null : path.relative(root, s.cwd) || null),
            stream: owned.get(path.resolve(s.cwd)) ?? null,
          }))
          .sort((a, b) => (a.state === "running" ? -1 : 1) - (b.state === "running" ? -1 : 1)
                          || b.startedAt - a.startedAt),
      };
    },

    /** Start a work stream: a worktree of one repository, on its own branch. */
    "POST /api/stream/new": ({ body }) => {
      const repo = path.resolve(String(body.repo ?? ""));
      const made = createStream({
        repo,
        name: String(body.name ?? "").trim(),
        base: String(body.base ?? "").trim() || "main",
        purpose: String(body.purpose ?? "").trim(),
      });
      if (made.error) return { status: 400, body: { error: made.error } };
      return { stream: made.stream };
    },

    // ------------------------------------------------------------- explorer
    //
    // The structural questions, asked of a whole project. graphify answers
    // most of these per repository from its own generated page; these answer
    // them across services, over the merged graph the agent actually uses,
    // with the HTTP boundaries joined so a path can leave one repository and
    // arrive in another.

    /** Everything about a project's shape, in one read. */
    "/api/explore/overview": async ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const out = await exploreOverview(root);
      return out ?? { status: 409, body: { error: "no code graph yet — build one first" } };
    },

    /**
     * The project as a hierarchy: service, directory, file, symbol.
     *
     * One level at a time. The whole tree of a hundred thousand symbols is
     * eleven megabytes of JSON, which is not something anybody browses — it is
     * a download. `under` asks for one branch, `depth` for how far.
     */
    "/api/explore/tree": ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const under = url.searchParams.get("under") ?? "";
      const depth = Math.max(1, Math.min(4, Number(url.searchParams.get("depth") ?? 1)));
      const out = exploreTree(root, { under, depth });
      if (!out) {
        return under
          ? { status: 404, body: { error: `no such branch: ${under}` } }
          : { status: 409, body: { error: "no code graph yet" } };
      }
      return out;
    },

    /**
     * Finding a symbol by description rather than by exact name.
     *
     * Semantic when the embedding model is installed, lexical when it is not.
     * The distinction is reported rather than hidden, because "nothing matched"
     * means something different in each case.
     */
    "/api/explore/search": async ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return { query: "", semantic: false, hits: [] };

      if (embeddingsInstalled()) {
        // embed() takes a batch and returns one vector per text, and a bge
        // model wants its query prefix — passing the raw call result as a
        // vector scored every symbol NaN, which then serialised as null and
        // looked like an ordinary lexical result.
        const [qv] = (await embed(q, { query: true })) ?? [];
        const hits = qv ? await searchWorkspace(root, q, { vec: qv, limit: 25, similarity, fromBlob }) : [];
        if (hits?.length) {
          return {
            query: q,
            // Reported from the hits, not from what was attempted: some of
            // these can be lexical even when the model is installed.
            semantic: hits.some((h) => Number.isFinite(h.score)),
            hits: hits.map((h) => ({
              id: h.id, name: h.name, file: h.file, line: h.line,
              service: h.service ?? null,
              score: Number.isFinite(h.score) ? h.score : null,
            })),
          };
        }
      }
      // Falling through rather than returning empty: a lexical answer is worth
      // more than a blank page when the vector search finds nothing.
      const g = graphForAny(root);
      const hits = g ? findSymbols(g, q, 25) : [];
      return {
        query: q, semantic: false,
        hits: hits.map((n) => ({ id: n.id, name: n.name, file: n.file, line: n.line, service: n.service ?? null, score: null })),
      };
    },

    /** One symbol: verified callers and callees, and its source from disk. */
    "/api/explore/symbol": ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const out = exploreSymbol(root, url.searchParams.get("id") ?? "");
      return out ?? { status: 404, body: { error: "no such symbol in this project's graph" } };
    },

    /** The graph around one symbol, as something to draw. */
    "/api/explore/neighbourhood": async ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const depth = Math.max(1, Math.min(3, Number(url.searchParams.get("depth") ?? 1)));
      const out = await exploreNeighbourhood(root, url.searchParams.get("id") ?? "", { depth });
      return out ?? { status: 404, body: { error: "no such symbol" } };
    },

    /** How one symbol reaches another, HTTP boundaries included. */
    "/api/explore/path": async ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const out = await explorePath(root, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
      return out ?? { status: 404, body: { error: "one of those symbols is not in the graph" } };
    },

    /** What a change here could reach, across services. */
    "/api/explore/impact": async ({ url }) => {
      const root = projectRoot(url);
      if (!root) return { status: 404, body: { error: "project not registered" } };
      const depth = Math.max(1, Math.min(5, Number(url.searchParams.get("depth") ?? 3)));
      const out = await exploreImpact(root, url.searchParams.get("id") ?? "", { depth });
      return out ?? { status: 404, body: { error: "no such symbol" } };
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

      // Bringing a project up to date is two commands, but one intention: a
      // graph without its contracts is half an answer, and nobody should have
      // to know to run the second one. Kept as separate steps so the progress
      // still says which part is running.
      // Drawing only. The graph is already there; this is the pass that turns
      // it into a page, which is seconds rather than the minutes a re-extract
      // would cost on a large repository.
      if (body.what === "diagram") {
        const named = modelInstalled();
        return {
          jobId: startJob([{
            label: named ? "Draw the graph and name its communities" : "Draw the graph",
            command: `${CLI} diagram${named ? " --label" : ""}`,
          }], { cwd: dir, title: "Drawing the graph" }).id,
        };
      }

      if (body.what === "refresh") {
        // Everything the CLI would do, because a button that does most of it
        // leaves you to work out which flag you were supposed to have typed.
        // Naming the communities is included whenever there is a model to do
        // it with — it costs nothing but time, and it is the difference
        // between a legend reading "Community 0" and one reading "api.js".
        const named = modelInstalled();
        const steps = [
          { label: named ? "Build the code graph and name its communities" : "Build the code graph",
            command: `${CLI} graph${named ? " --label" : ""}` },
          { label: "Find the links between services", command: `${CLI} contracts`, optional: true },
        ];
        return { jobId: startJob(steps, { cwd: dir, title: "Bringing the project up to date" }).id };
      }

      const command = allowed[body.what];
      if (!command) return { status: 400, body: { error: `not a runnable report: ${body.what}` } };
      return { jobId: startJob([{ label: body.what, command }], { cwd: dir, title: `Running ${body.what}` }).id };
    },
  };
}
