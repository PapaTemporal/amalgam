/**
 * The edges a parser structurally cannot see.
 *
 * A code graph is built from syntax, so it only knows about connections
 * expressed as symbols. When one component talks to another through a *string*
 * — an HTTP route, a queue topic, an RPC name — the parser sees a function
 * calling `fetch` with an argument, and nothing more. The link is real, the
 * evidence is right there in both files, and no amount of merging indexes will
 * produce it, because it was never extracted in the first place.
 *
 * This repository demonstrates it against itself: ui/src/lib/api.js calls
 * "/api/state" and lib/uiapi.mjs defines it, and the graph contains exactly
 * zero edges between them.
 *
 * So this is a second pass, over the merged project graph, that infers those
 * edges from evidence. Two rules keep it honest:
 *
 *   inferred is not extracted   contract edges are stored and reported as
 *                               their own kind, never mixed into the `calls`
 *                               edges a parser produced. One is a fact about
 *                               syntax; the other is a match between strings.
 *
 *   confidence is stated        a literal path meeting a literal route is
 *                               strong. A URL built from variables is a guess,
 *                               and says so rather than being quietly counted.
 */
import fs from "node:fs";
import path from "node:path";

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

/**
 * Routes a service declares it will answer.
 *
 * Deliberately several shapes rather than one framework's: a project is a
 * workspace and its services rarely agree on a stack. Anything unmatched is
 * simply not found, which is the safe direction to fail in.
 */
const PROVIDERS = [
  // Object-literal route tables: "POST /api/x": handler   |   "/api/x": handler
  { re: new RegExp(`["'\`](?:(${METHODS})\\s+)?(/[\\w\\-./:{}$\\[\\]]*)["'\`]\\s*:`, "gi"), method: 1, path: 2 },
  // Express, Koa, Fastify, chi: app.get("/x", ...) | router.post('/x') | r.Get("/x"
  { re: new RegExp(`\\b(?:app|router|r|mux|server|api)\\.(${METHODS})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi"), method: 1, path: 2 },
  // Decorators: @app.get("/x") | @router.post('/x') | @GetMapping("/x")
  { re: new RegExp(`@\\w*\\.?(${METHODS})\\w*\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi"), method: 1, path: 2 },
  // Flask/Django style: @app.route("/x", methods=["POST"])
  { re: /@\w+\.route\s*\(\s*["'`]([^"'`]+)["'`]([^)]*)\)/gi, method: null, path: 1, methodsIn: 2 },
  // Go: http.HandleFunc("/x", handler)
  { re: /\bHandleFunc\s*\(\s*["'`]([^"'`]+)["'`]/gi, method: null, path: 1 },
];

/** Call sites that name a route rather than a function. */
const CONSUMERS = [
  // fetch("/x") | fetch(`${base}/x`) | new EventSource("/x") | new WebSocket("/x")
  { re: /\b(?:fetch|EventSource|WebSocket)\s*\(\s*["'`]([^"'`]+)["'`]/gi, method: null, path: 1 },
  // axios.post("/x") | http.get("/x") | client.put(`/x`)
  { re: new RegExp(`\\b(?:axios|http|https|client|api|requests|session)\\.(${METHODS})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi"), method: 1, path: 2 },
  // A method named in the options object: fetch(url, { method: "POST" }) is
  // handled by pairing below; this catches request("POST", "/x")
  { re: new RegExp(`\\brequest\\s*\\(\\s*["'\`](${METHODS})["'\`]\\s*,\\s*["'\`]([^"'\`]+)["'\`]`, "gi"), method: 1, path: 2 },
  // A thin client wrapper called with the tail of a path: get("/state"),
  // post("/projects/add"). Extremely common, and invisible to everything above
  // because the wrapper is what holds the literal fetch — the caller only
  // knows the suffix. Paired by suffix below and labelled as the weakest
  // evidence here, since a bare get("/x") could be anything.
  { re: /\b(?:get|post|put|patch|del|delete|send|call)\s*\(\s*["'`](\/[^"'`]*)["'`]/gi, method: null, path: 1, viaWrapper: true },
];

const SKIP_DIR = /(^|[\\/])(node_modules|\.git|dist|build|out|target|vendor|third_party|graphify-out|\.venv|\.svelte-kit)([\\/]|$)/;
const CODE = /\.(m?[jt]sx?|py|rb|go|rs|java|kt|cs|php|scala|svelte|vue)$/i;

/**
 * Reduce a URL or route to something both sides can be compared on.
 *
 * The two halves of a contract are almost never written identically: a client
 * builds `${base}/api/jobs/${id}/stream` and a server declares
 * `/api/jobs/:id/stream`. Both become `/api/jobs/:_/stream`, which is the
 * thing they actually agree about.
 */
export function normalisePath(raw) {
  let p = String(raw).trim();
  p = p.replace(/^[a-z]+:\/\/[^/]+/i, "");          // drop scheme and host
  p = p.replace(/\?.*$/, "");                       // drop query string
  p = p.replace(/\$\{[^}]*\}/g, ":_");              // template expressions
  p = p.replace(/:[A-Za-z_]\w*/g, ":_");            // :id
  p = p.replace(/\{[^}]*\}/g, ":_");                // {id}
  p = p.replace(/<[^>]*>/g, ":_");                  // <int:id>
  p = p.replace(/\/+$/g, "");                       // trailing slash
  if (!p.startsWith("/")) p = `/${p}`;
  return p.toLowerCase();
}

const isRoutish = (p) => /^\/[\w\-./:{}$\[\]]*$/.test(p) && p.length > 1 && !/\.(js|ts|css|png|svg|json|html)$/i.test(p);

/**
 * Strip a base-URL prefix from a call site's literal.
 *
 * The commonest shape in service-to-service code is a configured host joined
 * to a path: fetch(`${INVENTORY}/api/inventory/${sku}`). What the two services
 * agree about is the path, and the leading expression is the deployment
 * detail that varies per environment — so it comes off before matching, which
 * is the difference between finding those edges and reporting the callee as a
 * route nobody calls.
 *
 * Only a prefix that is entirely an expression is removed. A literal like
 * `/api/v2${suffix}` keeps its shape, because there the expression is part of
 * the path rather than in front of it.
 */
function stripBase(raw) {
  const t = String(raw).trim();
  const m = /^(\$\{[^}]*\}|\{\{[^}]*\}\}|%s|\{\})(\/.*)$/.exec(t);
  return m ? { path: m[2], base: m[1] } : { path: t, base: null };
}

/**
 * What a stripped base expression is calling the thing it points at.
 *
 * `${INVENTORY}` and `${process.env.BILLING_URL}` are how a service names the
 * service it talks to, and it is the only name available once the host has
 * been configured out of the code. Reducing it to a word gives a real
 * identity for something outside this project, which beats grouping calls by
 * URL prefix and hoping.
 */
export function baseName(base) {
  if (!base) return null;
  const inner = String(base).replace(/^[${{%]+|[}%]+$/g, "");
  const word = inner.split(/[.\[\]]/).filter(Boolean).pop() ?? inner;
  return word
    .replace(/_?(URL|URI|HOST|ENDPOINT|BASE|API|SERVICE|SVC)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase() || null;
}

function filesToScan(root, { maxBytes = 400_000, limit = 4000 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8 || out.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (SKIP_DIR.test(full)) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (CODE.test(e.name)) {
        try { if (fs.statSync(full).size <= maxBytes) out.push(full); } catch { /* unreadable */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Both halves of every contract this tree mentions. */
export function scan(root, { service = null } = {}) {
  const provides = [];
  const consumes = [];

  for (const file of filesToScan(root)) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    // Cheap pre-filter: a file with no route-shaped literal cannot contribute.
    // The prefix is optional because the commonest service-to-service call
    // puts a configured host in front of the path — `${BASE}/api/x` — and a
    // filter anchored on quote-then-slash skipped those files entirely,
    // silently, before any pattern ran.
    if (!/["'`](?:\$\{[^}]*\}|\{\{[^}]*\}\})?\/[\w\-]/.test(text)
        && !/HandleFunc|@\w+\.route/.test(text)) continue;

    const lines = text.split(/\r?\n/);
    const rel = path.relative(root, file).split("\\").join("/");
    const at = (index) => text.slice(0, index).split(/\r?\n/).length;

    // A route named in a comment is documentation, not a contract. Skipping
    // them is not a nicety: without it, this module's own regex examples were
    // reported as live endpoints of this project.
    const isComment = (n) => /^\s*(\/\/|\*|\/\*|#)/.test(lines[n - 1] ?? "");

    const collect = (patterns, sink, side) => {
      for (const spec of patterns) {
        const re = new RegExp(spec.re.source, spec.re.flags);
        let m;
        while ((m = re.exec(text))) {
          const stripped = side === "consumes" ? stripBase(m[spec.path] ?? "") : { path: m[spec.path], base: null };
          const rawPath = stripped.path;
          if (!rawPath || !isRoutish(rawPath)) continue;
          let method = spec.method ? (m[spec.method] ?? "").toUpperCase() : "";
          if (spec.methodsIn && m[spec.methodsIn]) {
            const found = new RegExp(`(${METHODS})`, "i").exec(m[spec.methodsIn]);
            if (found) method = found[1].toUpperCase();
          }
          const line = at(m.index);
          if (isComment(line)) continue;
          sink.push({
            side, service, file: rel, line,
            method: method || null,
            path: normalisePath(rawPath),
            raw: rawPath,
            // How this call names the host it is going to, when it names one.
            base: stripped.base ?? null,
            baseName: baseName(stripped.base),
            // A path assembled from variables is a weaker claim than a literal.
            dynamic: /\$\{|\+\s*\w|%s|f["']/.test(rawPath),
            viaWrapper: !!spec.viaWrapper,
            text: (lines[line - 1] ?? "").trim().slice(0, 160),
          });
        }
      }
    };

    collect(PROVIDERS, provides, "provides");
    collect(CONSUMERS, consumes, "consumes");
  }

  // A declaration cannot also be a call to itself.
  //
  // `app.post("/api/orders", handler)` registers a route, but the loose
  // wrapper pattern that catches `post("/api/orders")` in a client sees the
  // same text and reads it as a caller — which produced edges from a route to
  // itself, on its own line, in every express-style service. Nothing is
  // dropped that a stricter regex would have kept: the provider matched the
  // very same characters, so the consumer match was never a second fact.
  const declared = new Set(provides.map((p) => `${p.service}:${p.file}:${p.line}`));
  const calls = consumes.filter((c) => !(c.viaWrapper && declared.has(`${c.service}:${c.file}:${c.line}`)));

  // A route table entry also looks like a consumer to nothing, and a fetch
  // inside a server file is a real consumer: no side is excluded by location.
  return { provides: dedupe(provides), consumes: dedupe(calls) };
}

const dedupe = (rows) => {
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.service}|${r.file}|${r.line}|${r.method}|${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Pair consumers with the routes that answer them.
 *
 * A consumer with no method matches on path alone and is marked lower
 * confidence, because `fetch(url, { method: "POST" })` puts the verb somewhere
 * this pass does not read. Being explicit about that is better than guessing
 * GET and being wrong half the time.
 */
export function match({ provides, consumes }) {
  const byPath = new Map();
  for (const p of provides) {
    if (!byPath.has(p.path)) byPath.set(p.path, []);
    byPath.get(p.path).push(p);
  }

  const edges = [];
  const usedProviders = new Set();

  for (const c of consumes) {
    let candidates = byPath.get(c.path) ?? [];
    let bySuffix = false;
    if (!candidates.length && c.viaWrapper) {
      // The wrapper holds the prefix, the caller holds the tail: get("/state")
      // and a route declared at "/api/state" are one contract. Reporting both
      // as orphans would be technically defensible and practically useless.
      candidates = provides.filter((p) => p.path.endsWith(c.path) && p.path !== c.path);
      bySuffix = candidates.length > 0;
    }
    if (!candidates.length) continue;
    const exact = c.method ? candidates.filter((p) => p.method === c.method) : [];
    const chosen = exact.length ? exact : candidates;

    for (const p of chosen) {
      // A call to your own service's route is still a contract, but the
      // interesting ones cross a service boundary.
      const crossService = !!(c.service && p.service && c.service !== p.service);
      usedProviders.add(`${p.service}|${p.file}|${p.line}`);
      edges.push({
        kind: "http",
        method: p.method ?? c.method ?? null,
        path: p.path,
        from: { service: c.service, file: c.file, line: c.line, text: c.text },
        to: { service: p.service, file: p.file, line: p.line, text: p.text },
        crossService,
        confidence: bySuffix ? "suffix match"
          : !c.method && !exact.length ? "path only"
            : c.dynamic || p.dynamic ? "pattern match"
              : "literal match",
      });
    }
  }

  const orphanRoutes = provides.filter((p) => !usedProviders.has(`${p.service}|${p.file}|${p.line}`));
  // Orphaned means nothing paired with it, including by suffix.
  const paired = new Set(edges.map((e) => e.from.file + "|" + e.from.line));
  const orphanCalls = consumes.filter((c) => !paired.has(c.file + "|" + c.line));
  return { edges, orphanRoutes, orphanCalls };
}

/**
 * Re-read the source before believing any of it.
 *
 * The same rule the rest of this project follows: an inferred edge is a claim
 * about two lines of code, so those lines are checked. A match whose literal
 * has since moved or changed is dropped rather than reported, because a
 * confident wrong edge is worse than a missing one.
 */
export function verifyEdges(root, edges) {
  const cache = new Map();
  const stillThere = (side) => {
    const abs = path.join(root, side.file);
    if (!cache.has(side.file)) {
      try { cache.set(side.file, fs.readFileSync(abs, "utf8").split(/\r?\n/)); } catch { cache.set(side.file, []); }
    }
    const line = cache.get(side.file)[side.line - 1] ?? "";
    return line.trim().slice(0, 160) === side.text;
  };
  return edges.filter((e) => stillThere(e.from) && stillThere(e.to));
}

/** Everything, for one project. */
export function contracts(projectRoot, services) {
  const provides = [];
  const consumes = [];
  for (const svc of services.length ? services : [{ name: null, path: projectRoot }]) {
    const found = scan(svc.path, { service: svc.name });
    for (const p of found.provides) provides.push({ ...p, file: svc.name ? `${svc.name}/${p.file}` : p.file });
    for (const c of found.consumes) consumes.push({ ...c, file: svc.name ? `${svc.name}/${c.file}` : c.file });
  }
  const result = match({ provides, consumes });
  result.edges = verifyEdges(projectRoot, result.edges);
  return { ...result, provides, consumes };
}

export function render(result, { limit = 25 } = {}) {
  const { edges, orphanRoutes, orphanCalls, provides, consumes } = result;
  const lines = [`${provides.length} route(s) declared, ${consumes.length} call site(s) naming a route`];

  if (!edges.length) {
    lines.push("");
    lines.push("No contracts matched. Either the two halves disagree, or the frameworks here are not recognised.");
  } else {
    const cross = edges.filter((e) => e.crossService);
    lines.push("");
    lines.push(`${edges.length} contract edge(s)${cross.length ? `, ${cross.length} crossing a service boundary` : ""}:`);
    for (const e of edges.slice(0, limit)) {
      lines.push(`  ${(e.method ?? "ANY").padEnd(6)} ${e.path}   [${e.confidence}]`);
      lines.push(`     calls  ${e.from.file}:${e.from.line}`);
      lines.push(`     serves ${e.to.file}:${e.to.line}`);
    }
    if (edges.length > limit) lines.push(`  (${edges.length - limit} more)`);
  }

  if (orphanCalls.length) {
    lines.push("");
    lines.push(`${orphanCalls.length} call(s) to a route nothing here declares:`);
    for (const c of orphanCalls.slice(0, 8)) lines.push(`  ${c.path}  ${c.file}:${c.line}`);
  }
  if (orphanRoutes.length) {
    lines.push("");
    lines.push(`${orphanRoutes.length} route(s) nothing here calls:`);
    for (const p of orphanRoutes.slice(0, 8)) lines.push(`  ${(p.method ?? "ANY").padEnd(6)} ${p.path}  ${p.file}:${p.line}`);
  }

  lines.push("");
  lines.push("These are inferred from string literals, not parsed from syntax. An external caller or a URL built at run time will not appear.");
  return lines.join("\n");
}

// ------------------------------------------------------------------ storage
/**
 * Contracts are computed once and stored, not inferred per question.
 *
 * Scanning a large workspace means reading thousands of files; doing that
 * every time a page loads would make the interface feel broken. They are
 * refreshed with the graph, which is the moment the code was already being
 * read anyway.
 */
const STORE = `
CREATE TABLE IF NOT EXISTS contract_edges (
  id         INTEGER PRIMARY KEY,
  project    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'http',
  method     TEXT,
  path       TEXT NOT NULL,
  from_service TEXT, from_file TEXT NOT NULL, from_line INTEGER, from_text TEXT,
  to_service   TEXT, to_file   TEXT NOT NULL, to_line   INTEGER, to_text   TEXT,
  cross_service INTEGER NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT '',
  found_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contract_orphans (
  id       INTEGER PRIMARY KEY,
  project  TEXT NOT NULL,
  side     TEXT NOT NULL,
  method   TEXT,
  path     TEXT NOT NULL,
  service  TEXT, file TEXT NOT NULL, line INTEGER,
  -- How a call names the host it is going to, when it names one. The only
  -- identity available for a service outside this project.
  base_name TEXT
);
CREATE INDEX IF NOT EXISTS contract_edges_project ON contract_edges(project);
`;

async function store() {
  const { open } = await import("./db.mjs");
  const db = open();
  db.exec(STORE);
  // `CREATE TABLE IF NOT EXISTS` does nothing for a table that already exists,
  // so a column added later has to be added on its own. Adding it twice is an
  // error rather than a no-op, hence the check.
  const columns = db.prepare(`PRAGMA table_info(contract_orphans)`).all().map((c) => c.name);
  if (!columns.includes("base_name")) {
    db.exec(`ALTER TABLE contract_orphans ADD COLUMN base_name TEXT`);
  }
  return db;
}

export async function saveContracts(projectRoot, result) {
  const db = await store();
  const P = path.resolve(projectRoot);
  db.prepare(`DELETE FROM contract_edges WHERE project = ?`).run(P);
  db.prepare(`DELETE FROM contract_orphans WHERE project = ?`).run(P);

  const edge = db.prepare(
    `INSERT INTO contract_edges (project, kind, method, path, from_service, from_file, from_line, from_text,
                                 to_service, to_file, to_line, to_text, cross_service, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of result.edges) {
    edge.run(P, e.kind, e.method, e.path, e.from.service, e.from.file, e.from.line, e.from.text,
      e.to.service, e.to.file, e.to.line, e.to.text, e.crossService ? 1 : 0, e.confidence);
  }
  const orphan = db.prepare(
    `INSERT INTO contract_orphans (project, side, method, path, service, file, line, base_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const o of result.orphanRoutes) orphan.run(P, "route", o.method, o.path, o.service, o.file, o.line, null);
  for (const o of result.orphanCalls) orphan.run(P, "call", o.method, o.path, o.service, o.file, o.line, o.baseName ?? null);
  return { edges: result.edges.length, orphans: result.orphanRoutes.length + result.orphanCalls.length };
}

export async function loadContracts(projectRoot) {
  const db = await store();
  const P = path.resolve(projectRoot);
  const edges = db.prepare(`SELECT * FROM contract_edges WHERE project = ? ORDER BY path`).all(P)
    .map((r) => ({
      kind: r.kind, method: r.method, path: r.path, confidence: r.confidence,
      crossService: !!r.cross_service,
      from: { service: r.from_service, file: r.from_file, line: r.from_line, text: r.from_text },
      to: { service: r.to_service, file: r.to_file, line: r.to_line, text: r.to_text },
    }));
  const orphans = db.prepare(`SELECT * FROM contract_orphans WHERE project = ?`).all(P);
  return {
    edges,
    orphanRoutes: orphans.filter((o) => o.side === "route"),
    // Renamed on the way out so callers see one spelling; the column keeps
    // SQL's.
    orphanCalls: orphans.filter((o) => o.side === "call")
      .map((o) => ({ ...o, baseName: o.base_name ?? null })),
  };
}

/** Drop the contracts inferred for a project. */
export async function forgetContracts(projectRoot) {
  const db = await store();
  const P = path.resolve(projectRoot);
  db.prepare(`DELETE FROM contract_edges WHERE project = ?`).run(P);
  db.prepare(`DELETE FROM contract_orphans WHERE project = ?`).run(P);
}
