/**
 * Reading a built code graph, so an agent can be handed evidence instead of
 * files.
 *
 * The usual way an agent understands code is to read whole files, which is the
 * most expensive possible way to learn two things: where a symbol is defined,
 * and who depends on it. A graph already knows both. What it does not know is
 * the current text — a graph is a snapshot, and snapshots rot.
 *
 * So the division of labour here is deliberate: the graph decides WHICH lines
 * matter, and the working tree provides WHAT they say. Selection can go stale
 * without the answer becoming wrong — a symbol that moved is located by name,
 * and a symbol that vanished is reported missing rather than quoted from a
 * stale cache. That keeps a slightly outdated graph useful, which matters,
 * because a graph nobody trusts sends the agent back to reading files.
 */
import fs from "node:fs";
import path from "node:path";

export const graphPath = (repo) => path.join(repo, "graphify-out", "graph.json");
export const hasGraph = (repo) => fs.existsSync(graphPath(repo));

/** Load a graph and build the indexes every query below needs. */
export function loadGraph(repo) {
  const file = graphPath(repo);
  if (!fs.existsSync(file)) return null;
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  const nodes = new Map();
  for (const n of g.nodes ?? []) {
    nodes.set(n.id, {
      id: n.id,
      label: n.label ?? n.id,
      name: bareName(n.label ?? n.id),
      file: n.source_file ?? "",
      line: lineOf(n.source_location),
      callable: !!n._callable,
    });
  }
  // Edges keep the call site that produced them. Without it an edge can only
  // be believed or not; with it, the working tree can be asked whether the
  // call is really there — which is what separates a stale graph from a wrong
  // one, and a real call from a name that merely looks like one.
  const callers = new Map();  // id -> [{ id, file, line }] of callers
  const callees = new Map();  // id -> [{ id, file, line }] of callees
  for (const l of g.links ?? []) {
    if (!nodes.has(l.source) || !nodes.has(l.target)) continue;
    const site = { file: l.source_file ?? nodes.get(l.source).file, line: lineOf(l.source_location) };
    (callers.get(l.target) ?? callers.set(l.target, []).get(l.target)).push({ id: l.source, ...site });
    (callees.get(l.source) ?? callees.set(l.source, []).get(l.source)).push({ id: l.target, ...site });
  }
  return { repo, nodes, callers, callees, builtAt: g.built_at_commit ?? null };
}

/**
 * Ask the working tree whether an edge is real.
 *
 * A call graph built by name has one blind spot: it cannot see scope. `resolve`
 * inside `new Promise((resolve, reject) => …)` is a parameter, not the exported
 * function of that name, and `x.parse()` is somebody else's method. Both get
 * bound to whatever top-level symbol shares the name.
 *
 * The call site is recorded, and the source is right there, so read it:
 *
 *   confirmed — a bare call to the name sits on the recorded line
 *   moved     — not there, but the call exists elsewhere in the file; the
 *               graph is behind, the relationship is real
 *   shadowed  — the name is a parameter in scope, or the call is a method on
 *               something else: the edge is a false positive
 *   absent    — no such call anywhere in the file; the edge is dead
 *
 * Cheap enough to run per query: it reads files already being read, and each
 * one is cached for the length of the call.
 */
export function verifyEdge(repo, site, name, targetFile = "", cache = new Map()) {
  if (!site.file || site.line == null) return "absent";
  const abs = path.join(repo, site.file);
  if (!cache.has(site.file)) {
    cache.set(site.file, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").split(/\r?\n/) : []);
  }
  const lines = cache.get(site.file);
  if (!lines.length) return "absent";

  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bare = new RegExp(`(^|[^.\\w$])${esc}\\s*\\(`);
  const member = new RegExp(`[\\w$)\\]]\\s*\\.\\s*${esc}\\s*\\(`);
  const line = lines[site.line - 1] ?? "";

  // `x.name()` is somebody else's method that happens to share the name.
  if (member.test(line) && !bare.test(line)) return "shadowed";

  let at = site.line;
  if (!bare.test(line)) {
    const elsewhere = lines.findIndex((l) => bare.test(l) && !member.test(l));
    if (elsewhere < 0) return "absent";
    at = elsewhere + 1;
  }

  // Across files, the call only reaches the target if the name is not already
  // bound locally. A parameter (`new Promise((resolve) => …)`), a local const,
  // or an import from a different module all win over a same-named export
  // somewhere else in the project — which name-based extraction cannot see.
  if (targetFile && site.file !== targetFile && boundLocally(lines, at, esc, targetFile)) return "shadowed";

  return at === site.line ? "confirmed" : "moved";
}

/** Does this file bind the name itself, rather than getting it from the target? */
function boundLocally(lines, at, esc, targetFile) {
  const stem = targetFile.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  const declaration = new RegExp(`\\b(?:const|let|var|function|class)\\s+${esc}\\b`);
  const param = new RegExp(`\\(\\s*(?:\\w+\\s*,\\s*)*${esc}\\s*(?:,\\s*\\w+\\s*)*\\)\\s*=>`);
  const fnParam = new RegExp(`function\\s*\\w*\\s*\\([^)]*\\b${esc}\\b`);
  const namedImport = new RegExp(`(?:import\\s*\\{|=\\s*require\\()`);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    // An import of this name FROM the target module is what a correct edge
    // looks like — that settles it in the target's favour.
    if (namedImport.test(l) && new RegExp(`\\b${esc}\\b`).test(l)) {
      if (l.includes(stem)) return false;
      return true;
    }
    // Declarations anywhere above the call shadow it; parameters only within
    // the enclosing signature, which in practice is a few lines up.
    if (i < at && declaration.test(l)) return true;
    if (i < at && i >= at - 13 && (param.test(l) || fnParam.test(l))) return true;
  }
  return false;
}

const bareName = (label) => String(label).replace(/\(.*$/, "").trim();
const lineOf = (loc) => {
  const m = /L(\d+)/.exec(String(loc ?? ""));
  return m ? Number(m[1]) : null;
};

/**
 * Neighbours of a symbol.
 *
 * With a `repo`, every edge is checked against the source before it is
 * reported, and false positives are dropped rather than shown with a caveat —
 * a caller list is read as a list of things to go and look at, so a wrong
 * entry costs a wasted read, which is the exact expense this is meant to
 * avoid. The count of what was dropped is returned for the caller to mention.
 */
function neighbours(g, id, which, repo, cache) {
  const edges = g[which].get(id) ?? [];
  const seen = new Set();
  const out = [];
  let rejected = 0;
  for (const e of edges) {
    const node = g.nodes.get(e.id);
    if (!node || seen.has(e.id)) continue;
    if (repo) {
      // For callers the call to THIS symbol is written at the call site; for
      // callees it is the neighbour's own name that appears there.
      const self = g.nodes.get(id);
      const name = which === "callers" ? self.name : node.name;
      const targetFile = which === "callers" ? self.file : node.file;
      const verdict = verifyEdge(repo, e, name, targetFile, cache);
      if (verdict === "shadowed" || verdict === "absent") { rejected++; continue; }
    }
    seen.add(e.id);
    out.push(node);
  }
  out.rejected = rejected;
  return out;
}

export const callersOf = (g, id, repo = null, cache = new Map()) => neighbours(g, id, "callers", repo, cache);
export const calleesOf = (g, id, repo = null, cache = new Map()) => neighbours(g, id, "callees", repo, cache);

/**
 * Rank symbols against a plain-language task description.
 *
 * Deliberately simple: token overlap against the symbol name and its file
 * path, with well-connected symbols winning ties. Anything cleverer would need
 * a model, and the point of this path is to spend no tokens at all.
 */
export function findSymbols(g, task, max = 6) {
  const terms = (String(task).toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 2);
  if (!terms.length) return [];
  const scored = [];
  for (const n of g.nodes.values()) {
    const name = n.name.toLowerCase();
    const file = n.file.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name === t) score += 10;
      else if (name.includes(t)) score += 4;
      if (file.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ n, score: score + Math.min((g.callers.get(n.id) ?? []).length, 5) * 0.1 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.n);
}

/**
 * Pull a symbol's actual text out of the working tree.
 *
 * The graph's line number is a hint, not an authority: it was true when the
 * graph was built. If the name is not on that line, the file is searched for
 * it, and only if that fails does this report the symbol as missing.
 */
export function sliceSymbol(repo, node, maxLines = 14) {
  const abs = path.join(repo, node.file);
  if (!node.file || !fs.existsSync(abs)) return { ...node, missing: "file not found", text: "" };
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);

  // A graph has nodes for whole files as well as for symbols inside them. A
  // file's own name is not written inside it, so searching for it would report
  // the file missing; its opening lines are the useful thing instead.
  if (node.name === path.basename(node.file)) {
    const head = lines.slice(0, maxLines);
    while (head.length && head[head.length - 1].trim() === "") head.pop();
    return { ...node, line: 1, isFile: true, text: head.join("\n") };
  }

  const nameRe = new RegExp(`\\b${node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

  let idx = node.line ? node.line - 1 : -1;
  const onHint = idx >= 0 && idx < lines.length && nameRe.test(lines[idx]);
  if (!onHint) {
    idx = lines.findIndex((l) => nameRe.test(l));
    if (idx < 0) return { ...node, missing: "symbol not found in file", text: "" };
  }

  const slice = lines.slice(idx, idx + maxLines);
  while (slice.length && slice[slice.length - 1].trim() === "") slice.pop();
  return {
    ...node,
    line: idx + 1,
    moved: !onHint && node.line != null,
    text: slice.join("\n"),
  };
}

/** Files changed between a git revision and the working tree. */
export function changedFiles(repo, rev, git) {
  const out = git(repo, ["diff", "--name-only", rev]);
  if (!out.ok) return null;
  return out.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Line ranges touched on the new side of a diff, per file. Line-precise impact
 * beats file-precise impact: one edited helper in a 2000-line file should not
 * drag every symbol in that file into the blast radius.
 */
export function changedRanges(repo, rev, git) {
  const out = git(repo, ["diff", "-U0", rev]);
  if (!out.ok) return new Map();
  const byFile = new Map();
  let file = null;
  for (const line of out.stdout.split(/\r?\n/)) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { file = f[1]; if (!byFile.has(file)) byFile.set(file, []); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) byFile.get(file).push([Number(h[1]), Number(h[1]) + (h[2] === undefined ? 1 : Number(h[2])) - 1]);
  }
  return byFile;
}

/**
 * Give every symbol the line span it owns: from its own definition to just
 * before the next definition in the same file.
 *
 * Matching a diff against definition lines alone would answer the wrong
 * question. Edits usually land in the middle of a function, not on its
 * signature, so line-by-line matching reports "no symbols changed" for the
 * most ordinary change there is. A span turns a hunk anywhere inside a
 * function into that function. It is an approximation — the graph records
 * where a symbol starts, not where it ends — but it errs by attributing a
 * change to the symbol above it, which is nearly always the right one.
 *
 * File-level nodes are excluded: a node covering the whole file would swallow
 * every hunk and make the answer useless.
 */
export function symbolSpans(g) {
  const byFile = new Map();
  for (const n of g.nodes.values()) {
    if (n.line == null || !n.file) continue;
    if (n.name === n.file.split(/[\\/]/).pop()) continue;
    const key = n.file.split("\\").join("/");
    (byFile.get(key) ?? byFile.set(key, []).get(key)).push(n);
  }
  const spans = new Map();
  for (const [file, nodes] of byFile) {
    nodes.sort((a, b) => a.line - b.line);
    spans.set(file, nodes.map((n, i) => ({
      node: n,
      from: n.line,
      to: i + 1 < nodes.length ? nodes[i + 1].line - 1 : Infinity,
    })));
  }
  return spans;
}

/** Symbols owning a line that the diff touched. */
export function symbolsInRanges(g, ranges) {
  const spans = symbolSpans(g);
  const hit = [];
  for (const [file, changed] of ranges) {
    for (const s of spans.get(file) ?? []) {
      if (changed.some(([a, b]) => b >= s.from && a <= s.to) && !hit.includes(s.node)) hit.push(s.node);
    }
  }
  return hit;
}
