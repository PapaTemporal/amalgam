/**
 * Whether two pieces of parallel work are about to ruin each other.
 *
 * Work streams make parallel development possible: each story gets its own
 * worktree, and nothing orchestrates them. That is fine until two streams are
 * ready at once, and then the interesting failure is not the one git warns
 * about. A textual conflict is loud, local, and gets fixed in a minute. The
 * expensive collision is the one that merges perfectly clean and is wrong:
 * one stream changes what a function returns while another writes new callers
 * of it, and both test green in isolation.
 *
 * Git cannot see that, because git compares text. The code graph can, because
 * it knows who calls what. So this asks two questions of every pair of
 * streams:
 *
 *   overlap    do they change the same symbols? — they will fight, and the
 *              merge being clean is the dangerous case, not the safe one;
 *   dependency does one change a symbol the other's changed code calls? — no
 *              conflict, but an ordering: the changed callee must land first,
 *              so the caller integrates against what will actually be there.
 *
 * The ordering falls out of the second question. Streams nobody depends on can
 * go in any order; a cycle means two streams are entangled and must be
 * integrated together rather than sequenced, which is worth knowing before
 * anyone starts merging rather than after.
 */
import { changedRanges, symbolsInRanges } from "./graph.mjs";

/**
 * What one stream has actually changed relative to its base.
 *
 * `base...branch` rather than `base..branch`: the three-dot form asks what the
 * branch did since it diverged, which is the question. Two dots would also
 * report everything the base gained meanwhile as if this stream had undone it.
 */
export function streamChanges(repo, stream, { graph, git }) {
  const range = `${stream.base}...${stream.branch}`;
  const ranges = changedRanges(repo, range, git);
  const files = [...ranges.keys()];
  const symbols = graph ? symbolsInRanges(graph, ranges) : [];
  return {
    name: stream.name,
    branch: stream.branch,
    base: stream.base,
    files,
    symbols,
    symbolIds: new Set(symbols.map((s) => s.id)),
  };
}

/** Symbols that a set of changed symbols calls, one edge out. */
function calleeIds(graph, symbols) {
  const out = new Set();
  if (!graph) return out;
  for (const s of symbols) {
    for (const e of graph.callees.get(s.id) ?? []) out.add(e.id);
  }
  return out;
}

/**
 * Compare every pair of streams.
 *
 * Both findings are reported even when they coincide: a pair can share a
 * symbol AND have a dependency between other symbols, and collapsing that into
 * one verdict would hide half of what a person needs to decide.
 */
export function compare(changes, graph) {
  const pairs = [];
  for (let i = 0; i < changes.length; i++) {
    for (let j = i + 1; j < changes.length; j++) {
      const a = changes[i], b = changes[j];

      const sharedSymbols = a.symbols.filter((s) => b.symbolIds.has(s.id));
      const sharedFiles = a.files.filter((f) => b.files.includes(f));

      // A depends on B when A's changed code calls something B changed: B's
      // new behaviour has to be in place for A to be integrating against the
      // real thing.
      const aCalls = calleeIds(graph, a.symbols);
      const bCalls = calleeIds(graph, b.symbols);
      const aNeedsB = [...aCalls].filter((id) => b.symbolIds.has(id));
      const bNeedsA = [...bCalls].filter((id) => a.symbolIds.has(id));

      if (!sharedSymbols.length && !sharedFiles.length && !aNeedsB.length && !bNeedsA.length) continue;

      pairs.push({
        a: a.name, b: b.name,
        sharedSymbols: sharedSymbols.map((s) => `${s.name} (${s.file})`),
        // Files shared without symbols shared is the mild case: same file,
        // different functions, which git usually merges correctly.
        sharedFiles: sharedFiles.filter((f) => !sharedSymbols.some((s) => s.file === f)),
        aNeedsB: aNeedsB.map((id) => graph?.nodes.get(id)?.name ?? id),
        bNeedsA: bNeedsA.map((id) => graph?.nodes.get(id)?.name ?? id),
      });
    }
  }
  return pairs;
}

/**
 * An order to merge in, from the dependencies found above.
 *
 * Kahn's algorithm, and what it leaves behind matters as much as what it
 * emits: anything still holding an edge when no node has zero in-degree is
 * part of a cycle, which is the honest answer "these cannot be sequenced,
 * integrate them together".
 */
export function mergeOrder(names, pairs) {
  const before = new Map(names.map((n) => [n, new Set()]));   // n -> must merge after these
  for (const p of pairs) {
    if (p.aNeedsB.length) before.get(p.a).add(p.b);
    if (p.bNeedsA.length) before.get(p.b).add(p.a);
  }

  const order = [];
  const remaining = new Set(names);
  while (remaining.size) {
    const ready = [...remaining].filter((n) => ![...before.get(n)].some((d) => remaining.has(d)));
    if (!ready.length) break;                                  // cycle
    ready.sort();
    for (const n of ready) { order.push(n); remaining.delete(n); }
  }
  return { order, entangled: [...remaining] };
}

export function analyse(repo, streams, { graph, git }) {
  const changes = streams.map((s) => streamChanges(repo, s, { graph, git }));
  const pairs = compare(changes, graph);
  const { order, entangled } = mergeOrder(changes.map((c) => c.name), pairs);
  return { changes, pairs, order, entangled, hasGraph: !!graph };
}

export function render(report) {
  const { changes, pairs, order, entangled, hasGraph } = report;
  if (!changes.length) return "No streams to compare.";

  const lines = [`${changes.length} stream(s) in flight:`];
  for (const c of changes) {
    lines.push(`  ${c.name.padEnd(16)} ${c.files.length} file(s), ${c.symbols.length} symbol(s) changed`
      + `${c.files.length === 0 ? "  — nothing yet" : ""}`);
  }

  if (!hasGraph) {
    lines.push("");
    lines.push("No code graph: only shared files can be detected, not shared behaviour. Run 'amalgam graph'.");
  }

  const fighting = pairs.filter((p) => p.sharedSymbols.length);
  const touching = pairs.filter((p) => !p.sharedSymbols.length && p.sharedFiles.length);
  const ordered = pairs.filter((p) => p.aNeedsB.length || p.bNeedsA.length);

  lines.push("");
  if (!pairs.length) {
    lines.push("No collisions: these streams change disjoint code and can merge in any order.");
    return lines.join("\n");
  }

  for (const p of fighting) {
    lines.push(`COLLISION  ${p.a} + ${p.b} — both change: ${p.sharedSymbols.join(", ")}`);
    lines.push(`           A clean merge here is the dangerous case: both tested green apart.`);
  }
  for (const p of touching) {
    lines.push(`shared     ${p.a} + ${p.b} — same file(s), different symbols: ${p.sharedFiles.join(", ")}`);
  }
  for (const p of ordered) {
    const [first, second, via] = p.aNeedsB.length ? [p.b, p.a, p.aNeedsB] : [p.a, p.b, p.bNeedsA];
    lines.push(`order      ${first} before ${second} — ${second} calls ${via.join(", ")}, which ${first} changes`);
  }

  lines.push("");
  if (order.length) lines.push(`Merge order: ${order.join(" -> ")}`);
  if (entangled.length) {
    lines.push(`Entangled, cannot be sequenced: ${entangled.join(", ")} — integrate them together in one branch.`);
  }
  return lines.join("\n");
}
