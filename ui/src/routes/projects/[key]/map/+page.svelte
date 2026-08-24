<script>
  import { get, post, watchJob } from "$lib/api.js";
  import { page } from "$app/state";

  const key = $derived(page.params.key);

  let map = $state(null);
  let error = $state(null);
  let flow = $state(null);
  let busy = $state(false);
  let filter = $state("");

  async function load() {
    try { map = await get("/map", { key }); } catch (e) { error = e.message; }
  }
  $effect(() => { if (key && !map && !error) load(); });

  async function refresh() {
    busy = true;
    const { jobId } = await post("/run", { what: "contracts", path: map.projectPath ?? "" });
    watchJob(jobId, async (u) => {
      if (u.state === "done" || u.state === "failed") { busy = false; map = null; await load(); }
    });
  }

  async function openFlow(path) {
    flow = { path, loading: true };
    flow = await get("/flow", { key, path });
    const url = new URL(window.location.href);
    url.searchParams.set("flow", path);
    history.replaceState({}, "", url);
  }

  // Opening .../map?flow=/api/state traces it straight away, so a flow can be
  // sent to somebody rather than described.
  let auto = $state(false);
  $effect(() => {
    const wanted = page.url.searchParams.get("flow");
    if (map && wanted && !auto) { auto = true; openFlow(wanted); }
  });

  const endpoints = $derived(
    (map?.endpoints ?? []).filter((e) =>
      !filter || e.path.includes(filter.toLowerCase()) ||
      (e.from.file + e.to.file).toLowerCase().includes(filter.toLowerCase()))
  );

  // --- layout -------------------------------------------------------------
  // Deterministic rather than force-directed: a diagram that settles somewhere
  // different every time it loads cannot be talked about ("the box on the
  // left"), and with a handful of services there is nothing a simulation would
  // work out that arithmetic cannot.
  const W = 760;
  // Height follows the layout: a single service in a 320-tall canvas is mostly
  // empty space, and empty space reads as something failing to load.
  // Room for the self-loop, which is drawn above the node and was reaching off
  // the top of the canvas in the single-service case — the case every project
  // starts in.
  const H = $derived((map?.nodes.length ?? 1) <= 2 ? 200 : 320);
  const positions = $derived.by(() => {
    const nodes = map?.nodes ?? [];
    const pos = new Map();
    if (nodes.length === 1) pos.set(nodes[0].id, { x: W / 2, y: H / 2 + 30 });
    else if (nodes.length === 2) {
      pos.set(nodes[0].id, { x: 170, y: H / 2 + 20 });
      pos.set(nodes[1].id, { x: W - 170, y: H / 2 + 20 });
    } else {
      // An ellipse, not a circle: the boxes are 156 wide and 44 tall, so a
      // radius that fits them vertically leaves them overlapping horizontally.
      // Spreading across the axis with room in it keeps the lines between the
      // boxes rather than under them.
      const rx = W / 2 - 110, ry = H / 2 - 55;
      nodes.forEach((n, i) => {
        const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
        pos.set(n.id, { x: W / 2 + rx * Math.cos(a), y: H / 2 + ry * Math.sin(a) });
      });
    }
    return pos;
  });

  // Boxes are drawn at these half-extents, and the edges need to know: a line
  // that runs to a node's centre puts its arrowhead underneath the box, which
  // loses the one thing the diagram exists to show — which way the call goes.
  const BW = 78, BH = 22;

  /** Where a line aimed at `to` should stop: the edge of the box, not its middle. */
  function clip(from, to, pad = 7) {
    const dx = to.x - from.x, dy = to.y - from.y;
    if (!dx && !dy) return to;
    // Scale the direction until it first leaves the box in x or in y.
    const t = Math.min(
      Math.abs(dx) > 1e-6 ? (BW + pad) / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-6 ? (BH + pad) / Math.abs(dy) : Infinity,
    );
    return { x: to.x - dx * t, y: to.y - dy * t };
  }

  // A self-link is drawn as a loop above the node: a service calling its own
  // routes is the single-repository case and must not vanish.
  function edgePath(link) {
    const a = positions.get(link.from), b = positions.get(link.to);
    if (!a || !b) return "";
    if (link.from === link.to) return `M ${a.x - 26} ${a.y - 22} C ${a.x - 70} ${a.y - 96}, ${a.x + 70} ${a.y - 96}, ${a.x + 26} ${a.y - 22}`;
    const start = clip(b, a), end = clip(a, b);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 30;
    return `M ${start.x} ${start.y} Q ${mx} ${my} ${end.x} ${end.y}`;
  }
</script>

<header class="page">
  <div class="spread">
    <div>
      <h1>Map</h1>
      <div class="sub">
        {#if map}
          {map.nodes.length} service(s), {map.endpoints.length} contract(s) between code that calls a route and code that serves it
        {:else}reading…{/if}
      </div>
    </div>
    <div class="row">
      <a class="btn" href={`/projects/${key}`}>Back to project</a>
      <button onclick={refresh} disabled={busy}>{busy ? "Scanning…" : "Rescan"}</button>
    </div>
  </div>
</header>

{#if error}
  <div class="card"><strong>{error}</strong></div>
{:else if map}
  <div class="card" style="margin-bottom:1.25rem">
    <h2>Services</h2>
    <svg viewBox={`0 0 ${W} ${H}`} class="map">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
      </defs>

      {#each map.links as link}
        <path d={edgePath(link)} class="link" marker-end="url(#arrow)" />
        {#if positions.get(link.from) && positions.get(link.to)}
          {@const a = positions.get(link.from)}
          {@const b = positions.get(link.to)}
          <text class="link-label"
                x={link.from === link.to ? a.x : (a.x + b.x) / 2}
                y={link.from === link.to ? a.y - 78 : (a.y + b.y) / 2 - 20}>
            {link.count} route{link.count === 1 ? "" : "s"}
          </text>
        {/if}
      {/each}

      {#each map.nodes as node}
        {@const p = positions.get(node.id)}
        <g class="node">
          <rect x={p.x - 78} y={p.y - 22} width="156" height="44" rx="8" />
          <text class="name" x={p.x} y={p.y - 2}>{node.label}</text>
          <text class="meta" x={p.x} y={p.y + 14}>
            {node.symbols ? `${node.symbols.toLocaleString()} symbols` : "no graph"}
          </text>
        </g>
      {/each}
    </svg>
    <p class="tiny faint" style="margin:0">
      Lines are inferred from route strings, not parsed from syntax — see the confidence on each contract below.
    </p>
  </div>

  {#if flow}
    <div class="card" style="margin-bottom:1.25rem">
      <div class="spread">
        <h2 style="margin:0">Flow · <span class="mono">{flow.path}</span></h2>
        <button class="ghost" onclick={() => (flow = null)}>Close</button>
      </div>
      {#if flow.loading}
        <p class="faint tiny">tracing…</p>
      {:else}
        {#each flow.steps as step}
          <div class="flowrow">
            <div class="stage">
              <span class="label">calls</span>
              <strong>{step.caller?.name ?? "—"}</strong>
              <span class="tiny faint mono">{step.from.file}:{step.from.line}</span>
            </div>
            <div class="arrow">
              <span class="pill">{step.method ?? "ANY"} {step.path}</span>
              <span class="tiny faint">{step.confidence}</span>
            </div>
            <div class="stage">
              <span class="label">serves</span>
              <strong>{step.handler?.name ?? "—"}</strong>
              <span class="tiny faint mono">{step.to.file}:{step.to.line}</span>
            </div>
            <div class="stage">
              <span class="label">then calls</span>
              {#if step.downstream.length}
                <div class="chips">
                  {#each step.downstream as d}<span class="pill">{d.name}</span>{/each}
                </div>
              {:else}<span class="tiny faint">nothing the graph can see</span>{/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  <div class="card" style="margin-bottom:1.25rem">
    <div class="spread" style="margin-bottom:.5rem">
      <h2 style="margin:0">Contracts</h2>
      <input type="search" bind:value={filter} placeholder="filter by path or file…" style="max-width:280px" />
    </div>
    {#if endpoints.length === 0}
      <p class="empty">Nothing matched.</p>
    {:else}
      <table>
        <thead><tr><th>Route</th><th>Calls</th><th>Serves</th><th>Evidence</th></tr></thead>
        <tbody>
          {#each endpoints as e}
            <tr class="clickable" onclick={() => openFlow(e.path)}>
              <td><span class="pill">{e.method ?? "ANY"}</span> <span class="mono">{e.path}</span></td>
              <td class="tiny muted mono">{e.from.file}:{e.from.line}</td>
              <td class="tiny muted mono">{e.to.file}:{e.to.line}</td>
              <td class="tiny faint">{e.confidence}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="grid">
    {#if map.orphanRoutes.length}
      <div class="card">
        <h2>Routes nothing calls</h2>
        <p class="tiny faint" style="margin-top:-.4rem">Dead, or called from outside this project.</p>
        <ul class="plain tiny mono">
          {#each map.orphanRoutes.slice(0, 12) as o}
            <li>{o.method ?? "ANY"} {o.path} <span class="faint">· {o.file}:{o.line}</span></li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if map.orphanCalls.length}
      <div class="card">
        <h2>Calls to nothing here</h2>
        <p class="tiny faint" style="margin-top:-.4rem">An external service, or a route built at run time.</p>
        <ul class="plain tiny mono">
          {#each map.orphanCalls.slice(0, 12) as o}
            <li>{o.path} <span class="faint">· {o.file}:{o.line}</span></li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}

<style>
  svg.map { width: 100%; height: auto; margin-bottom: .5rem; }
  .link { fill: none; stroke: var(--accent); stroke-width: 1.5; opacity: .55; }
  .link-label { fill: var(--ink-faint); font-size: 11px; text-anchor: middle;
                paint-order: stroke; stroke: var(--panel); stroke-width: 4px; stroke-linejoin: round; }
  .node rect { fill: var(--panel-2); stroke: var(--line); }
  .node .name { fill: var(--ink); font-size: 13px; font-weight: 600; text-anchor: middle; }
  .node .meta { fill: var(--ink-faint); font-size: 10px; text-anchor: middle; }

  .flowrow { display: grid; grid-template-columns: 1fr auto 1fr 1fr; gap: 1rem;
             align-items: center; padding: .9rem 0; border-top: 1px solid var(--line); }
  .flowrow:first-of-type { border-top: none; }
  .stage { display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
  .stage strong { overflow-wrap: anywhere; }
  .arrow { display: flex; flex-direction: column; align-items: center; gap: .25rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .25rem; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: var(--panel-2); }
  ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
</style>
