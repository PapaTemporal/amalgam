/**
 * The local http server behind `amalgam ui`.
 *
 * Everything amalgam does is available from a terminal, and for a lot of
 * people that is the wrong shape: setting up a project means running four
 * commands in the right order, and knowing where a piece of work stands means
 * reading five outputs and holding them in your head. A screen is better at
 * both. So this exposes the same capabilities as a small JSON API, and serves
 * a compiled Svelte application beside it.
 *
 * Three rules it keeps:
 *
 *   local only    bound to 127.0.0.1, no authentication because there is no
 *                 network surface to authenticate — and refusing to bind
 *                 elsewhere is what makes that true rather than assumed;
 *   no build      the UI ships compiled. Nobody running amalgam should need
 *                 npm, a bundler, or a toolchain to open a page;
 *   no new truth  every number here comes from the same functions the CLI
 *                 uses. A dashboard that computes its own version of the
 *                 truth is a dashboard that disagrees with the tool.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { HOME } from "./services.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(PKG, "ui", "build");
const REGISTRY = path.join(HOME, "ui.json");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".map": "application/json",
};

// ------------------------------------------------------------------ registry
export function readRegistry() {
  // Sanitised on the way out. This file is plain JSON in the user's home
  // directory and is entirely hand-editable, so it can contain anything; a
  // single malformed entry must not be able to take down every route in the
  // interface, which is exactly what an unchecked path.resolve() does.
  let raw;
  try { raw = JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { return { projects: [] }; }
  const projects = Array.isArray(raw?.projects)
    ? raw.projects.filter((p) => typeof p === "string" && p.trim())
    : [];
  return { ...raw, projects };
}
export function writeRegistry(reg) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}
export const projectKey = (p) => Buffer.from(path.resolve(p)).toString("base64url");

// ---------------------------------------------------------------------- jobs
/**
 * A job is a sequence of named steps run in order, each streamed as it goes.
 *
 * This is what makes setup legible: a wizard that says "installing…" for two
 * minutes is indistinguishable from one that has hung, so every step reports
 * when it starts, what it printed, and how it ended. Output is kept per step
 * and capped — the point is progress, not a log viewer.
 */
const jobs = new Map();
let nextJob = 1;

export function startJob(steps, { cwd = process.cwd(), title = "Running" } = {}) {
  const id = String(nextJob++);
  const job = {
    id,
    cwd,
    title,
    steps: steps.map((s) => ({ ...s, state: "waiting", output: [], code: null })),
    state: "running",
    listeners: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(id, job);
  runJob(job).catch((e) => {
    job.state = "failed";
    job.error = e.message;
    emit(job);
  });
  return job;
}

export const getJob = (id) => jobs.get(id);

function emit(job) {
  const payload = JSON.stringify({
    id: job.id, title: job.title, state: job.state, error: job.error ?? null,
    steps: job.steps.map((s) => ({ label: s.label, state: s.state, code: s.code, output: s.output.slice(-12) })),
  });
  for (const res of job.listeners) {
    try { res.write(`data: ${payload}\n\n`); } catch { job.listeners.delete(res); }
  }
}

async function runJob(job) {
  for (const step of job.steps) {
    step.state = "running";
    emit(job);
    const code = await runStep(job, step);
    step.code = code;
    step.state = code === 0 ? "done" : (step.optional ? "skipped" : "failed");
    emit(job);
    // A failed required step stops the sequence: continuing would report
    // success for work that was built on something that did not happen.
    if (code !== 0 && !step.optional) {
      job.state = "failed";
      emit(job);
      return;
    }
  }
  job.state = "done";
  emit(job);
}

function runStep(job, step) {
  return new Promise((resolve) => {
    const child = spawn(step.command, {
      cwd: step.cwd ?? job.cwd, shell: true, windowsHide: true,
      env: { ...process.env, ...(step.env ?? {}) },
    });
    const take = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        step.output.push(line.slice(0, 300));
        if (step.output.length > 200) step.output.shift();
      }
      emit(job);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => { step.output.push(e.message); resolve(-1); });
    child.on("close", (code) => resolve(code ?? -1));
  });
}

// ------------------------------------------------------------------- helpers
const send = (res, status, body, type = "application/json; charset=utf-8") => {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
});

/** Directories only, and never above the root the user is browsing from. */
export function browse(dir) {
  const target = path.resolve(dir || os.homedir());
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => {
        const full = path.join(target, e.name);
        return {
          name: e.name,
          path: full,
          isRepo: fs.existsSync(path.join(full, ".git")),
          hasBmad: fs.existsSync(path.join(full, "_bmad")),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* unreadable directory is simply empty */ }
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries };
}

// --------------------------------------------------------------------- serve
function serveStatic(req, res, url) {
  if (!fs.existsSync(UI_DIR)) {
    return send(res, 200, `<!doctype html><meta charset="utf-8">
      <style>body{font:15px/1.6 system-ui;margin:3rem auto;max-width:44rem;padding:0 1.5rem;background:#0b0d10;color:#e6e9ef}
      code{background:#171a20;padding:.15rem .4rem;border-radius:4px}</style>
      <h1>The interface has not been built</h1>
      <p>The API is running, but the compiled UI is missing from <code>ui/build</code>.
      A release ships it prebuilt; from a source checkout, build it once:</p>
      <pre><code>cd ui && npm install && npm run build</code></pre>`, "text/html; charset=utf-8");
  }
  let file = path.join(UI_DIR, decodeURIComponent(url.pathname));
  if (!file.startsWith(UI_DIR)) return send(res, 403, { error: "outside the ui directory" });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  // Client-side routing: any unknown path is the app, not a 404.
  if (!fs.existsSync(file)) file = path.join(UI_DIR, "index.html");
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  // Caching, because an update replaces these files underneath a running
  // browser. Assets under _app/immutable carry a content hash in the name, so
  // a given URL can never mean two different things and may be kept forever.
  // Everything else — index.html above all — must revalidate: a cached
  // index.html points at chunk names the update has just deleted, and the app
  // fails to load with nothing on screen to explain why.
  const immutable = url.pathname.startsWith("/_app/immutable/");
  res.writeHead(200, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer({ api }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // graphify's own interactive graph, served from inside the project it
    // describes. It is a good page and there is no reason to rebuild it — but
    // it lives on disk beside the code, and a browser will not open a file://
    // page from an http:// one, so it is proxied here. Checked before the
    // static handler, which otherwise answers every unknown path with the
    // application shell.
    // A workflow's own chooser page, served from the project's skills so the
    // interface can embed it rather than asking somebody to open a file and
    // carry a prompt back by hand.
    const chooser = /^\/workflow\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (chooser) {
      const { serveChooser } = await import("./workflowpage.mjs");
      return serveChooser(res, decodeURIComponent(chooser[1]), decodeURIComponent(chooser[2]));
    }

    const builtGraph = /^\/graph\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (builtGraph) {
      const { serveBuiltGraph } = await import("./graphpage.mjs");
      return serveBuiltGraph(res, decodeURIComponent(builtGraph[1]), builtGraph[2] ?? "");
    }

    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url);


    // Server-sent events for a live agent session. Same shape as job
    // progress, different lifetime: a session stays open across many turns.
    const sessionStream = /^\/api\/sessions\/([^/]+)\/stream$/.exec(url.pathname);
    if (sessionStream) {
      const { getSession, view } = await import("./session.mjs");
      const session = getSession(sessionStream[1]);
      if (!session) return send(res, 404, { error: "no such session" });
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
      });
      session.listeners.add(res);
      res.write(`data: ${JSON.stringify(view(session))}\n\n`);
      req.on("close", () => session.listeners.delete(res));
      return;
    }

    // Server-sent events for job progress: one long-lived response per client.
    const jobStream = /^\/api\/jobs\/([^/]+)\/stream$/.exec(url.pathname);
    if (jobStream) {
      const job = getJob(jobStream[1]);
      if (!job) return send(res, 404, { error: "no such job" });
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
      });
      job.listeners.add(res);
      emit(job);
      req.on("close", () => job.listeners.delete(res));
      return;
    }

    const route = api[`${req.method} ${url.pathname}`] ?? api[url.pathname];
    if (!route) return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const out = await route({ url, body, req });
      send(res, out?.status ?? 200, out?.body ?? out ?? {});
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
}

export { UI_DIR, REGISTRY };
