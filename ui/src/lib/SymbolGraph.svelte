<script>
  /**
   * The neighbourhood of one symbol, drawn as columns rather than a cloud.
   *
   * Force-directed layouts are the usual choice and the usual mistake: they
   * settle somewhere different every time, so nobody can say "the node on the
   * left", and they encode direction only in an arrowhead you have to squint
   * at. Columns encode it in the geometry — callers on the left, the symbol in
   * the middle, callees on the right — which is the one thing you came to the
   * picture for.
   *
   * Edges inferred from route strings are dashed and carry the route, because
   * an HTTP hop is not a function call and drawing it identically would be a
   * lie the picture tells silently.
   */
  let { data, onpick, selected = null } = $props();

  const W = 900;
  const ROW = 34;
  const ORDER = ["far_in", "in", "root", "out", "far_out"];

  /** Which column a node belongs in: by direction first, then by distance. */
  const columns = $derived.by(() => {
    if (!data) return [];
    const root = data.nodes.find((n) => n.isRoot);
    const reaches = new Map(); // id -> "in" | "out"
    for (const l of data.links) {
      if (l.target === root.id) reaches.set(l.source, "in");
      if (l.source === root.id) reaches.set(l.target, "out");
    }
    // Second-hop nodes inherit the direction of whatever pulled them in, so a
    // caller's caller stays on the left where it belongs.
    for (const l of data.links) {
      if (!reaches.has(l.source) && reaches.get(l.target) === "in") reaches.set(l.source, "in");
      if (!reaches.has(l.target) && reaches.get(l.source) === "out") reaches.set(l.target, "out");
    }

    const bucket = (n) => {
      if (n.isRoot) return "root";
      const dir = reaches.get(n.id) ?? "out";
      if (n.distance >= 2) return dir === "in" ? "far_in" : "far_out";
      return dir;
    };
    const groups = { far_in: [], in: [], root: [], out: [], far_out: [] };
    for (const n of data.nodes) groups[bucket(n)].push(n);
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  });

  const H = $derived(Math.max(
    200,
    Math.max(...Object.values(columns).map((c) => c.length)) * ROW + 60,
  ));

  /**
   * Only the columns that have something in them.
   *
   * A symbol that calls nothing would otherwise be drawn hard against the left
   * edge with half the canvas empty, which reads as a rendering failure rather
   * than as "this calls nothing".
   */
  const used = $derived(ORDER.filter((k) => (columns[k] ?? []).length));

  const positions = $derived.by(() => {
    const pos = new Map();
    const n = used.length;
    // Evenly spaced across the canvas, inset far enough that a 148-wide box
    // and its arrowhead both fit.
    const step = n > 1 ? (W - 200) / (n - 1) : 0;
    used.forEach((key, ci) => {
      const x = n === 1 ? W / 2 : 100 + ci * step;
      const list = columns[key];
      const top = (H - list.length * ROW) / 2 + ROW / 2;
      list.forEach((node, i) => pos.set(node.id, { x, y: top + i * ROW, col: key }));
    });
    return pos;
  });

  function edge(link) {
    const a = positions.get(link.source), b = positions.get(link.target);
    if (!a || !b) return null;
    // Leave the label room in the middle, and bow the line so parallel edges
    // between the same columns stay distinguishable.
    const x1 = a.x + 74, x2 = b.x - 74;
    const mid = (x1 + x2) / 2;
    return { d: `M ${x1} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${x2} ${b.y}`, mx: mid, my: (a.y + b.y) / 2 };
  }

  const short = (name) => (name.length > 20 ? `${name.slice(0, 18)}…` : name);
</script>

{#if data}
  <svg viewBox={`0 0 ${W} ${H}`} class="sym">
    <defs>
      <marker id="a-call" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
      </marker>
      <marker id="a-wire" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--warn)" />
      </marker>
    </defs>

    {#each data.links as link}
      {@const e = edge(link)}
      {#if e}
        <path d={e.d} class="link" class:wire={link.viaContract}
              marker-end={link.viaContract ? "url(#a-wire)" : "url(#a-call)"} />
        {#if link.viaContract}
          <text class="wire-label" x={e.mx} y={e.my - 6}>{link.method ?? ""} {link.route}</text>
        {/if}
      {/if}
    {/each}

    {#each data.nodes as node}
      {@const p = positions.get(node.id)}
      {#if p}
        <g class="node" class:root={node.isRoot} class:on={node.id === selected}
           onclick={() => onpick?.(node)} role="button" tabindex="0"
           onkeydown={(e) => e.key === "Enter" && onpick?.(node)}>
          <title>{node.name} — {node.file}:{node.line}</title>
          <rect x={p.x - 74} y={p.y - 13} width="148" height="26" rx="6" />
          <text x={p.x} y={p.y + 4}>{short(node.name)}</text>
        </g>
      {/if}
    {/each}
  </svg>

  <div class="key tiny faint">
    <span><span class="swatch call"></span> parsed call</span>
    <span><span class="swatch wire"></span> inferred from a route string</span>
    {#if data.truncated}<span>· {data.truncated} more not drawn</span>{/if}
  </div>
{/if}

<style>
  svg.sym { width: 100%; min-width: 620px; height: auto; }
  .link { fill: none; stroke: var(--accent); stroke-width: 1.4; opacity: .5; }
  .link.wire { stroke: var(--warn); stroke-dasharray: 5 4; opacity: .8; }
  .wire-label { fill: var(--warn); font-size: 10px; text-anchor: middle;
                paint-order: stroke; stroke: var(--panel); stroke-width: 4px; }
  .node { cursor: pointer; }
  .node rect { fill: var(--panel-2); stroke: var(--line); }
  .node text { fill: var(--ink-dim); font-size: 12px; text-anchor: middle; }
  .node:hover rect { stroke: var(--ink-faint); }
  .node.root rect { fill: color-mix(in srgb, var(--accent) 22%, var(--panel-2)); stroke: var(--accent); }
  .node.root text { fill: var(--ink); font-weight: 600; }
  .node.on rect { stroke: var(--accent); }
  .key { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: .4rem; }
  .swatch { display: inline-block; width: 14px; height: 0; border-top: 2px solid var(--accent);
            vertical-align: middle; margin-right: .3rem; }
  .swatch.wire { border-top-style: dashed; border-color: var(--warn); }
</style>
