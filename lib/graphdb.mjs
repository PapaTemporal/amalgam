/**
 * The code graph as an index, next to memory, instead of a file re-read on
 * every question.
 *
 * graphify stays the extractor — it is good at what it does and this project
 * has no business owning a tree-sitter pipeline. What it produces is a JSON
 * document, and a document has three problems as a query surface: it is parsed
 * in full for every question, it can only be searched by the words already in
 * it, and it has nowhere to keep anything learned about it.
 *
 * Importing it into the same SQLite file as memory fixes all three. Symbols get
 * vectors from the same local embedding model that memory uses, so
 * "where is authentication handled" finds `validateSession` without sharing a
 * word with it. Re-importing preserves the vectors of symbols that did not
 * change, so a rebuild costs embeddings only for what moved.
 *
 * The graph shape handed to callers is deliberately identical to the one
 * lib/graph.mjs builds from JSON, so everything downstream — slicing, edge
 * verification, impact — works the same either way, and a repo that has never
 * been indexed keeps working exactly as before.
 */
import fs from "node:fs";
import path from "node:path";
import { open } from "./db.mjs";
import { graphPath } from "./graph.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_repos (
  repo            TEXT PRIMARY KEY,
  built_at_commit TEXT,
  imported_at     TEXT NOT NULL DEFAULT (datetime('now')),
  symbols         INTEGER NOT NULL DEFAULT 0,
  edges           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
  id        INTEGER PRIMARY KEY,
  repo      TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  name      TEXT NOT NULL,
  label     TEXT NOT NULL,
  file      TEXT NOT NULL DEFAULT '',
  line      INTEGER,
  callable  INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL DEFAULT '',
  doc       TEXT NOT NULL DEFAULT '',
  context   TEXT NOT NULL DEFAULT '',
  embedding BLOB,
  UNIQUE(repo, node_id)
);
CREATE TABLE IF NOT EXISTS symbol_edges (
  id       INTEGER PRIMARY KEY,
  repo     TEXT NOT NULL,
  src      TEXT NOT NULL,
  dst      TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'calls',
  file     TEXT NOT NULL DEFAULT '',
  line     INTEGER
);
CREATE INDEX IF NOT EXISTS symbol_edges_dst ON symbol_edges(repo, dst);
CREATE INDEX IF NOT EXISTS symbol_edges_src ON symbol_edges(repo, src);
CREATE INDEX IF NOT EXISTS symbols_repo ON symbols(repo);
`;

function d() {
  const db = open();
  db.exec(SCHEMA);
  // Added after the first index shipped, so an existing one picks it up
  // instead of needing a rebuild.
  const have = db.prepare(`PRAGMA table_info(symbols)`).all().map((c) => c.name);
  if (!have.includes("doc")) db.exec(`ALTER TABLE symbols ADD COLUMN doc TEXT NOT NULL DEFAULT ''`);
  if (!have.includes("context")) db.exec(`ALTER TABLE symbols ADD COLUMN context TEXT NOT NULL DEFAULT ''`);
  return db;
}

const bareName = (label) => String(label).replace(/\(.*$/, "").trim();
const lineOf = (loc) => {
  const m = /L(\d+)/.exec(String(loc ?? ""));
  return m ? Number(m[1]) : null;
};
const key = (repo) => path.resolve(repo);

function linesOf(repo, file, cache) {
  if (!cache.has(file)) {
    const abs = path.join(repo, file);
    cache.set(file, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").split(/\r?\n/) : []);
  }
  return cache.get(file);
}

/** The definition line as written, which carries the signature and its types. */
function signatureOf(repo, file, line, cache) {
  if (!file || !line) return "";
  return (linesOf(repo, file, cache)[line - 1] ?? "").trim().slice(0, 200);
}

/**
 * The comment block immediately above a definition.
 *
 * This is the richest thing available about a symbol and it costs a few lines
 * of reading. A name and a signature say what something is called; the
 * sentences above it say what it is FOR, which is what a question phrased as
 * intent is really matching against. Symbols without a comment simply embed on
 * less.
 */
function docOf(repo, file, line, cache, max = 600) {
  if (!file || !line) return "";
  const lines = linesOf(repo, file, cache);
  const out = [];
  for (let i = line - 2; i >= 0 && out.length < 30; i--) {
    const t = (lines[i] ?? "").trim();
    if (t === "") { if (out.length) break; else continue; }
    if (!/^(\/\*|\*|\/\/|#)/.test(t)) break;
    out.push(t.replace(/^(\/\*+|\*+\/?|\/\/+|#+)\s?/, "").replace(/\*\/$/, "").trim());
  }
  return out.reverse().join(" ").replace(/\s+/g, " ").slice(0, max);
}

export function isIndexed(repo) {
  try {
    return !!d().prepare(`SELECT 1 FROM graph_repos WHERE repo = ?`).get(key(repo));
  } catch { return false; }
}

/**
 * The file's own header comment, as context for the symbols inside it.
 *
 * Plenty of functions carry no comment because the file above them already
 * explains the job — `addEvent` says nothing about work items because
 * lib/tasks.mjs spent a paragraph on it. Embedding a symbol on its name alone
 * throws that away, so a short slice of the module's purpose rides along with
 * every symbol in it. Short on purpose: it is context, and it must never
 * outweigh what the symbol itself says, or every symbol in a file becomes the
 * same vector.
 */
function moduleDoc(repo, file, cache, max = 220) {
  const lines = linesOf(repo, file, cache);
  const out = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const t = (lines[i] ?? "").trim();
    if (t === "" || t.startsWith("#!")) continue;
    if (!/^(\/\*|\*|\/\/|#)/.test(t)) break;
    const cleaned = t.replace(/^(\/\*+|\*+\/?|\/\/+|#+)\s?/, "").replace(/\*\/$/, "").trim();
    if (cleaned) out.push(cleaned);
  }
  return out.join(" ").replace(/\s+/g, " ").slice(0, max);
}

/**
 * Import a built graph.
 *
 * `embed` is optional and injected rather than imported, so this module never
 * decides whether the machine has an embedding model — the caller knows.
 */
export async function importGraph(repo, { embed = null, batch = 32, moduleContext = true } = {}) {
  const file = graphPath(repo);
  if (!fs.existsSync(file)) return { ok: false, error: `no graph at ${file}` };
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  const db = d();
  const R = key(repo);
  const sigCache = new Map();

  // Vectors already computed are worth keeping: a rebuild usually moves a few
  // symbols and leaves hundreds untouched, and re-embedding all of them is the
  // slowest thing this index could do.
  const previous = new Map();
  for (const row of db.prepare(`SELECT node_id, label, file, signature, doc, context, embedding FROM symbols WHERE repo = ?`).all(R)) {
    previous.set(row.node_id, row);
  }

  const upsert = db.prepare(
    `INSERT INTO symbols (repo, node_id, name, label, file, line, callable, signature, doc, context, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, node_id) DO UPDATE SET
       name = excluded.name, label = excluded.label, file = excluded.file,
       line = excluded.line, callable = excluded.callable,
       signature = excluded.signature, doc = excluded.doc, context = excluded.context,
       embedding = excluded.embedding`);

  const seen = new Set();
  const needVector = [];
  const modDocs = new Map();
  for (const n of g.nodes ?? []) {
    const label = n.label ?? n.id;
    const fileOf = n.source_file ?? "";
    const line = lineOf(n.source_location);
    const signature = signatureOf(repo, fileOf, line, sigCache);
    const doc = docOf(repo, fileOf, line, sigCache);
    // moduleContext is a knob because it is a trade rather than a win: it
    // lifts symbols that carry no comment of their own, and it makes every
    // symbol in a file more like every other one. bench/ measures which way
    // that lands.
    if (!modDocs.has(fileOf)) modDocs.set(fileOf, moduleContext ? moduleDoc(repo, fileOf, sigCache) : "");
    const context = modDocs.get(fileOf);
    const prev = previous.get(n.id);
    // Reuse the old vector only if what it was computed from is unchanged.
    const keepVector = prev && prev.label === label && prev.file === fileOf
      && prev.signature === signature && prev.doc === doc && prev.context === context
      ? prev.embedding : null;
    upsert.run(R, n.id, bareName(label), label, fileOf, line, n._callable ? 1 : 0, signature, doc, context, keepVector);
    seen.add(n.id);
    if (!keepVector) needVector.push({ node_id: n.id, text: embedText(label, fileOf, signature, doc, context) });
  }

  // Symbols that no longer exist, and every edge: edges are cheap and have no
  // identity worth preserving, so they are simply replaced.
  const gone = [...previous.keys()].filter((id) => !seen.has(id));
  const del = db.prepare(`DELETE FROM symbols WHERE repo = ? AND node_id = ?`);
  for (const id of gone) del.run(R, id);

  db.prepare(`DELETE FROM symbol_edges WHERE repo = ?`).run(R);
  const addEdge = db.prepare(
    `INSERT INTO symbol_edges (repo, src, dst, relation, file, line) VALUES (?, ?, ?, ?, ?, ?)`);
  let edges = 0;
  for (const l of g.links ?? []) {
    if (!seen.has(l.source) || !seen.has(l.target)) continue;
    addEdge.run(R, l.source, l.target, l.relation ?? "calls", l.source_file ?? "", lineOf(l.source_location));
    edges++;
  }

  let embedded = 0;
  if (embed && needVector.length) {
    const setVec = db.prepare(`UPDATE symbols SET embedding = ? WHERE repo = ? AND node_id = ?`);
    for (let i = 0; i < needVector.length; i += batch) {
      const slice = needVector.slice(i, i + batch);
      const vecs = await embed(slice.map((s) => s.text));
      if (!vecs) break;
      slice.forEach((s, j) => {
        if (!vecs[j]) return;
        setVec.run(vecs[j], R, s.node_id);
        embedded++;
      });
    }
  }

  db.prepare(
    `INSERT INTO graph_repos (repo, built_at_commit, imported_at, symbols, edges)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT(repo) DO UPDATE SET built_at_commit = excluded.built_at_commit,
       imported_at = excluded.imported_at, symbols = excluded.symbols, edges = excluded.edges`
  ).run(R, g.built_at_commit ?? null, seen.size, edges);

  return { ok: true, symbols: seen.size, edges, embedded, reused: seen.size - needVector.length, removed: gone.length };
}

/** What a symbol is embedded as: what it is called, then what it is for. */
const embedText = (label, file, signature, doc, context) =>
  `${label} in ${file}${signature && signature !== label ? `. ${signature}` : ""}` +
  `${doc ? `. ${doc}` : ""}${context ? `. Part of: ${context}` : ""}`;

/**
 * Rebuild the in-memory graph shape from the index.
 *
 * Same structure lib/graph.mjs returns, so every consumer is indifferent to
 * where it came from.
 */
export function graphFromDb(repo) {
  const db = d();
  const R = key(repo);
  const meta = db.prepare(`SELECT built_at_commit FROM graph_repos WHERE repo = ?`).get(R);
  if (!meta) return null;

  const nodes = new Map();
  for (const r of db.prepare(
    `SELECT node_id, name, label, file, line, callable FROM symbols WHERE repo = ?`).all(R)) {
    nodes.set(r.node_id, { id: r.node_id, label: r.label, name: r.name, file: r.file, line: r.line, callable: !!r.callable });
  }
  const callers = new Map();
  const callees = new Map();
  for (const e of db.prepare(`SELECT src, dst, file, line FROM symbol_edges WHERE repo = ?`).all(R)) {
    if (!nodes.has(e.src) || !nodes.has(e.dst)) continue;
    const site = { file: e.file || nodes.get(e.src).file, line: e.line };
    (callers.get(e.dst) ?? callers.set(e.dst, []).get(e.dst)).push({ id: e.src, ...site });
    (callees.get(e.src) ?? callees.set(e.src, []).get(e.src)).push({ id: e.dst, ...site });
  }
  return { repo, nodes, callers, callees, builtAt: meta.built_at_commit ?? null, indexed: true };
}

/**
 * Find symbols by meaning when a vector is available, by name when it is not.
 *
 * The two are combined the way memory combines them, and for the same reason:
 * cosine is a calibrated score and lexical overlap is not, so meaning decides
 * the order and names only add candidates meaning missed — which is where
 * exact identifiers live.
 */
export function searchSymbols(repo, task, { vec = null, limit = 6, similarity = null, fromBlob = null, expand = true } = {}) {
  const db = d();
  const R = key(repo);
  const rows = db.prepare(
    `SELECT node_id, name, label, file, line, callable, doc, context, embedding FROM symbols WHERE repo = ?`).all(R);
  if (!rows.length) return [];

  const node = (r, score = null) => ({
    id: r.node_id, label: r.label, name: r.name, file: r.file, line: r.line,
    callable: !!r.callable, doc: r.doc ?? "", context: r.context ?? "",
    // Kept so a caller merging results from several indexes has something
    // comparable to sort by. Within one index the order alone is enough.
    score,
  });

  // How connected each symbol is. A constant nobody references is a poor
  // answer to "how does X work" however close its vector lands, while a
  // function several things depend on is usually the place to start reading.
  const degree = new Map();
  for (const e of db.prepare(
    `SELECT src, dst FROM symbol_edges WHERE repo = ?`).all(R)) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  const semantic = [];
  if (vec && similarity && fromBlob) {
    for (const r of rows) {
      if (!r.embedding) continue;
      // Similarity decides, then two mild corrections: a question about
      // behaviour is answered by something callable, and by something other
      // code actually reaches. Both are small enough that a clearly better
      // match still wins.
      const base = similarity(vec, fromBlob(r.embedding));
      const kind = r.callable ? 1 : 0.88;
      const reach = Math.min(degree.get(r.node_id) ?? 0, 6) * 0.004;
      semantic.push({ score: base * kind + reach, r });
    }
    semantic.sort((a, b) => b.score - a.score);

    // Vector search on short text lands in the right neighbourhood far more
    // reliably than on the right symbol: asking where a work item's history is
    // written returns resume() and cmdTask(), which both sit one edge away
    // from addEvent(). The graph is exactly the thing that knows about "one
    // edge away", so let the best matches vouch for their neighbours. A
    // vouched symbol scores below the seed that reached it, so it can only
    // displace weaker direct matches, never a strong one.
    if (expand && semantic.length) {
      const scoreOf = new Map(semantic.map((s) => [s.r.node_id, s.score]));
      const rowOf = new Map(rows.map((r) => [r.node_id, r]));
      const neighbours = new Map();
      for (const e of db.prepare(`SELECT src, dst FROM symbol_edges WHERE repo = ?`).all(R)) {
        (neighbours.get(e.src) ?? neighbours.set(e.src, []).get(e.src)).push(e.dst);
        (neighbours.get(e.dst) ?? neighbours.set(e.dst, []).get(e.dst)).push(e.src);
      }
      // Arithmetic on these scores does not work: cosine over short code text
      // bunches everything into a narrow band — the top five here sit within
      // 0.02 of each other — so any decay factor pushes a vouched symbol below
      // the entire field, and any bonus big enough to matter drowns out
      // meaning altogether. Rank is the honest unit instead: each of the top
      // seeds may pull its single best-matching neighbour in behind it. The
      // seeds keep their order, and at most a few positions are spent on
      // symbols the graph says are one edge from a good answer.
      const ordered = [];
      const placed = new Set();
      for (const seed of semantic.slice(0, 6)) {
        if (!placed.has(seed.r.node_id)) { ordered.push(seed); placed.add(seed.r.node_id); }
        let best = null;
        for (const id of neighbours.get(seed.r.node_id) ?? []) {
          const r = rowOf.get(id);
          if (!r || !r.callable || placed.has(id)) continue;
          const s = scoreOf.get(id) ?? 0;
          if (!best || s > best.score) best = { score: s, r };
        }
        if (best) { ordered.push(best); placed.add(best.r.node_id); }
      }
      for (const s of semantic) if (!placed.has(s.r.node_id)) { ordered.push(s); placed.add(s.r.node_id); }
      semantic.length = 0;
      semantic.push(...ordered);
    }
  }

  const terms = (String(task).toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 2);
  const lexical = [];
  for (const r of rows) {
    const name = r.name.toLowerCase();
    const file = r.file.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name === t) score += 10;
      else if (name.includes(t)) score += 4;
      if (file.includes(t)) score += 1;
    }
    if (score > 0) lexical.push({ score, r });
  }
  lexical.sort((a, b) => b.score - a.score);

  const out = [];
  const seen = new Set();
  for (const s of semantic.slice(0, limit)) {
    if (seen.has(s.r.node_id)) continue;
    seen.add(s.r.node_id);
    out.push(node(s.r, s.score));
  }
  for (const s of lexical) {
    if (out.length >= limit) break;
    if (seen.has(s.r.node_id)) continue;
    seen.add(s.r.node_id);
    // Lexical hits have no calibrated score; they rank after semantic ones,
    // which is exactly what a null sorts to below.
    out.push(node(s.r, null));
  }
  return out.slice(0, limit);
}

export function indexStatus(repo) {
  return d().prepare(`SELECT * FROM graph_repos WHERE repo = ?`).get(key(repo)) ?? null;
}

/** Drop everything the index holds about a repository. */
export function forgetIndex(repo) {
  const db = d();
  const R = key(repo);
  db.prepare(`DELETE FROM symbols WHERE repo = ?`).run(R);
  db.prepare(`DELETE FROM symbol_edges WHERE repo = ?`).run(R);
  db.prepare(`DELETE FROM graph_repos WHERE repo = ?`).run(R);
}
