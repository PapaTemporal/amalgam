<script>
  import { get } from "$lib/api.js";
  import { page } from "$app/state";
  import SymbolGraph from "$lib/SymbolGraph.svelte";
  import CodeTree from "$lib/CodeTree.svelte";

  /**
   * The code graph, explorable.
   *
   * Three panes because there are three questions and they are asked together:
   * where is it (find), what is around it (draw), and what does it actually
   * say (read). Splitting them across pages would mean losing your place every
   * time you followed a caller.
   */
  const key = $derived(page.params.key);

  let mode = $state("search");            // search | tree | architecture
  let query = $state(page.url.searchParams.get("q") ?? "");
  let results = $state(null);
  let tree = $state(null);
  let arch = $state(null);
  let error = $state(null);

  let selected = $state(null);            // symbol id
  let detail = $state(null);              // the inspector's subject
  let graph = $state(null);               // the neighbourhood being drawn
  let depth = $state(1);
  let panel = $state(page.url.searchParams.get("panel") ?? "source");   // source | impact | path

  let impact = $state(null);
  let pathFrom = $state(null);
  let pathResult = $state(null);

  // The page can be opened straight at a symbol, so a finding can be sent to
  // somebody rather than described.
  let opened = $state(false);
  $effect(() => {
    const want = page.url.searchParams.get("id");
    if (want && !opened) { opened = true; select(want); }
  });

  $effect(() => { if (mode === "tree" && !tree) get("/explore/tree", { key }).then((t) => (tree = t)).catch(fail); });
  // The overview is what the header counts come from, so it is fetched on
  // arrival rather than when the Shape tab is opened.
  $effect(() => { if (key && !arch) get("/explore/overview", { key }).then((a) => (arch = a)).catch(fail); });

  const fail = (e) => (error = e.message);

  let searching = $state(false);
  async function search() {
    if (!query.trim()) return;
    searching = true;
    // In the URL, so a search that found the thing can be sent to somebody
    // rather than retyped from memory.
    const url = new URL(window.location.href);
    url.searchParams.set("q", query);
    history.replaceState({}, "", url);
    try { results = await get("/explore/search", { key, q: query }); } catch (e) { fail(e); }
    searching = false;
  }

  // A query in the URL runs itself; arriving at a search that has not run is
  // an empty pane where the answer should be.
  let searched = $state(false);
  $effect(() => { if (query && !searched) { searched = true; search(); } });

  async function select(id) {
    selected = id;
    detail = null;
    graph = null;
    impact = null;
    pathResult = null;
    const url = new URL(window.location.href);
    url.searchParams.set("id", id);
    history.replaceState({}, "", url);
    try {
      // Both at once: the picture and the reading matter are the same thought.
      const [d, g] = await Promise.all([
        get("/explore/symbol", { key, id }),
        get("/explore/neighbourhood", { key, id, depth }),
      ]);
      detail = d;
      graph = g;
      // Impact is per-symbol, so following an edge with the panel open should
      // re-answer the question for where you have arrived.
      if (panel === "impact") await showImpact();
    } catch (e) { fail(e); }
  }

  async function redraw() {
    if (!selected) return;
    graph = await get("/explore/neighbourhood", { key, id: selected, depth });
  }

  /** Keep the open panel in the URL alongside the symbol. */
  function show(which) {
    panel = which;
    const url = new URL(window.location.href);
    url.searchParams.set("panel", which);
    history.replaceState({}, "", url);
  }

  async function showImpact() {
    show("impact");
    if (!impact || impact.root !== selected) impact = await get("/explore/impact", { key, id: selected, depth: 3 });
  }

  async function tracePath() {
    show("path");
    if (!pathFrom || !selected) return;
    pathResult = await get("/explore/path", { key, from: pathFrom.id, to: selected });
  }

  const place = (n) => `${n.file}:${n.line}`;
  /** Enough of a path to tell two files apart, in the width a rail has. */
  const leaf = (f) => String(f ?? "").split("/").pop();
</script>

<header class="page">
  <div class="spread">
    <div>
      <h1>Explore</h1>
      <div class="sub">
        {#if arch}
          {arch.counts.symbols.toLocaleString()} symbols · {arch.counts.edges.toLocaleString()} edges ·
          {arch.counts.contracts} contract(s) across {arch.services.length} service(s)
        {:else}the code graph, across every service in this project{/if}
      </div>
    </div>
    <div class="row">
      <a class="btn" href={`/projects/${key}`}>Back to project</a>
      <a class="btn" href={`/projects/${key}/map`}>Service map</a>
    </div>
  </div>
</header>

{#if error}<div class="card" style="margin-bottom:1rem"><strong>{error}</strong></div>{/if}

<div class="panes">
  <!-- find ---------------------------------------------------------------- -->
  <aside class="card find">
    <div class="tabs">
      <button class:on={mode === "search"} onclick={() => (mode = "search")}>Search</button>
      <button class:on={mode === "tree"} onclick={() => (mode = "tree")}>Tree</button>
      <button class:on={mode === "architecture"} onclick={() => (mode = "architecture")}>Shape</button>
    </div>

    {#if mode === "search"}
      <form onsubmit={(e) => { e.preventDefault(); search(); }} class="row">
        <input type="search" bind:value={query} placeholder="what does it do…" />
        <button class="primary" disabled={searching}>{searching ? "…" : "Find"}</button>
      </form>
      {#if results}
        <p class="tiny faint">
          {results.hits.length} match(es) ·
          {results.semantic ? "ranked by meaning" : "matched on names — install the embedding model for meaning"}
        </p>
        <ul class="hits">
          {#each results.hits as h}
            <li>
              <button class:on={h.id === selected} onclick={() => select(h.id)} title={h.file}>
                <span class="name">{h.name}</span>
                {#if h.score}<span class="score tiny faint">{h.score.toFixed(2)}</span>{/if}
                <span class="tiny faint mono where">{leaf(h.file)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="tiny faint">
          Describe what you are looking for rather than naming it — “where orders get written”
          works better than a function name you are guessing at.
        </p>
      {/if}

    {:else if mode === "tree"}
      {#if tree}
        <div class="tree">
          <CodeTree node={tree} onpick={(n) => select(n.id)} {selected} />
        </div>
      {:else}<p class="tiny faint">reading the graph…</p>{/if}

    {:else if arch}
      <div class="shape">
        <h3>Hubs</h3>
        <p class="tiny faint">Most connected — where a change is felt widest.</p>
        <ul class="hits">
          {#each arch.hubs.slice(0, 10) as h}
            <li><button class:on={h.id === selected} onclick={() => select(h.id)} title={h.file}>
              <span class="name">{h.name}</span>
              <span class="score tiny faint">{h.degree}</span>
              <span class="tiny faint mono where">{leaf(h.file)}</span>
            </button></li>
          {/each}
        </ul>

        <h3>Clusters</h3>
        <p class="tiny faint">Groups that hang together, with how tightly.</p>
        <ul class="clusters">
          {#each arch.communities.slice(0, 12) as c}
            <li>
              <span class="mono tiny">{c.label}</span>
              <span class="tiny faint">{c.size} symbols{c.cohesion != null ? ` · cohesion ${c.cohesion.toFixed(2)}` : ""}</span>
            </li>
          {/each}
        </ul>

        {#if arch.surprises.length}
          <h3>Surprising links</h3>
          <p class="tiny faint">Edges that join otherwise separate clusters.</p>
          <ul class="clusters">
            {#each arch.surprises.slice(0, 8) as s}
              <li><span class="mono tiny">{s.source} → {s.target}</span>
                <span class="tiny faint">{s.why}</span></li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else}<p class="tiny faint">reading the graph…</p>{/if}
  </aside>

  <div class="work">
  <!-- draw ----------------------------------------------------------------- -->
  <section class="card draw">
    {#if graph}
      <div class="spread" style="margin-bottom:.4rem">
        <h2 style="margin:0">{detail?.name ?? "…"}</h2>
        <div class="row tiny">
          <span class="faint">depth</span>
          {#each [1, 2, 3] as d}
            <button class="chip" class:on={depth === d} onclick={() => { depth = d; redraw(); }}>{d}</button>
          {/each}
        </div>
      </div>
      <SymbolGraph data={graph} {selected} onpick={(n) => select(n.id)} />
    {:else}
      <p class="empty">Pick a symbol on the left. Callers appear to its left, callees to its right.</p>
    {/if}
  </section>

  <!-- read ----------------------------------------------------------------- -->
  <section class="card read" class:split={panel === "source"}>
    {#if detail}
      <div class="head spread">
        <div>
          <h2 style="margin:0">{detail.name}</h2>
          <p class="tiny muted mono" style="margin:.2rem 0 0">{place(detail)}</p>
        </div>
        <div class="row">
          {#if detail.service}<span class="pill">{detail.service}</span>{/if}
          {#if !detail.exists}<span class="pill bad">file is gone</span>{/if}
          <div class="tabs" style="margin:0">
            <button class:on={panel === "source"} onclick={() => show("source")}>Source</button>
            <button class:on={panel === "impact"} onclick={showImpact}>Impact</button>
            <button class:on={panel === "path"} onclick={() => show("path")}>Path</button>
          </div>
        </div>
      </div>

      {#if panel === "source"}
        <div class="col">
        {#if detail.source?.text}
          <pre class="code">{detail.source.text}</pre>
          <p class="tiny faint">
            Read from the working tree just now, not from the index.
            {#if detail.source.moved}
              The graph said line {detail.line}; it is actually at {detail.source.line}.
            {/if}
          </p>
        {:else}
          <p class="tiny faint">
            {detail.source?.missing ?? "No source for this symbol"} — the graph is behind the code here.
          </p>
        {/if}
        </div>

        <div class="col">
        <h3 style="margin-top:0">Called by <span class="tiny faint">{detail.callers.length}</span></h3>
        <ul class="hits">
          {#each detail.callers as c}
            <li><button onclick={() => select(c.id)}>
              <span class="name">{c.name}</span>
              <span class="tiny faint mono where">{c.file}:{c.line}</span>
            </button></li>
          {:else}<li class="tiny faint pad">nothing calls this</li>{/each}
        </ul>
        {#if detail.containedBy?.length}
          <p class="tiny faint">Defined in {detail.containedBy.map((c) => c.name).join(", ")}.</p>
        {/if}

        <h3>Calls <span class="tiny faint">{detail.callees.length}</span></h3>
        <ul class="hits">
          {#each detail.callees as c}
            <li><button onclick={() => select(c.id)}>
              <span class="name">{c.name}</span>
              <span class="tiny faint mono where">{c.file}:{c.line}</span>
            </button></li>
          {:else}<li class="tiny faint pad">calls nothing the graph can see</li>{/each}
        </ul>

        {#if detail.dropped.callers + detail.dropped.callees > 0}
          <p class="tiny faint">
            {detail.dropped.callers + detail.dropped.callees} edge(s) in the index were not in the
            source and are not listed.
          </p>
        {/if}
        </div>

      {:else if panel === "impact"}
        {#if impact}
          <p class="tiny muted">
            Changing this could be felt by {impact.reached.length} symbol(s)
            in {impact.files.length} file(s){impact.capped ? ", and more" : ""}.
          </p>
          <div class="row" style="flex-wrap:wrap;gap:.3rem">
            {#each impact.services as s}<span class="pill">{s.service || "this repo"} {s.count}</span>{/each}
          </div>
          <ul class="hits">
            {#each impact.reached as r}
              <li><button onclick={() => select(r.id)}>
                <span class="name">{r.name}</span>
                <span class="score tiny faint">{r.distance}</span>
                <span class="tiny faint mono where">
                  {r.file}{#if r.viaContract}<span class="wire"> · via {r.route ?? "HTTP"}</span>{/if}
                </span>
              </button></li>
            {:else}<li class="tiny faint pad">nothing reaches this</li>{/each}
          </ul>
          <p class="tiny faint">
            Distance is hops. Anything marked <span class="wire">via</span> was reached across a
            service boundary, which is inferred from route strings rather than parsed.
          </p>
        {:else}<p class="tiny faint">tracing…</p>{/if}

      {:else}
        <p class="tiny muted">
          How does one symbol reach this one? Pick a starting point, then trace.
        </p>
        <div class="row">
          <button onclick={() => { pathFrom = detail; pathResult = null; }}>Start here</button>
          <button class="primary" onclick={tracePath} disabled={!pathFrom || pathFrom.id === detail.id}>
            Trace to {detail.name}
          </button>
        </div>
        {#if pathFrom}
          <p class="tiny faint">from <span class="mono">{pathFrom.name}</span> — now select the destination and trace.</p>
        {/if}

        {#if pathResult}
          {#if !pathResult.found}
            <p class="tiny">No route between them, in either direction.</p>
          {:else}
            <p class="tiny muted">
              {pathResult.hops} hop(s){pathResult.directed ? "" : ", and only if direction is ignored"}{pathResult.crossings ? `, crossing ${pathResult.crossings} service boundary(ies)` : ""}.
            </p>
            <ol class="steps">
              {#each pathResult.steps as s}
                <li>
                  {#if s.via?.viaContract}
                    <div class="hop wire">{s.via.method ?? "ANY"} {s.via.route} <span class="tiny">over HTTP</span></div>
                  {/if}
                  <button onclick={() => select(s.id)}>
                    <span class="name">{s.name}</span>
                    <span class="tiny faint mono where">{s.service ? `${s.service} · ` : ""}{s.file}:{s.line}</span>
                  </button>
                </li>
              {/each}
            </ol>
          {/if}
        {/if}
      {/if}
    {:else}
      <p class="empty">Nothing selected.</p>
    {/if}
  </section>
  </div>
</div>

<style>
  /* Two columns, not three. The finder is a rail; everything else shares the
     rest, because the drawing is the point of the page and a third of the
     width is not enough to read one. */
  .panes { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 1rem; align-items: start; }
  .work { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  /* Below its minimum the diagram scrolls sideways rather than shrinking into
     illegibility. */
  .draw { overflow-x: auto; }
  /* Source on one side, the lists of what calls what on the other: reading the
     code and following an edge are done together. */
  .read.split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 1.25rem; align-items: start; }
  .read .head { grid-column: 1 / -1; }
  .find { max-height: calc(100vh - 190px); overflow: auto; }
  .tabs { display: flex; gap: .3rem; margin-bottom: .7rem; }
  .tabs button { font-size: .8rem; padding: .3rem .6rem; }
  .tabs button.on { background: var(--panel-2); color: var(--ink); border-color: var(--ink-faint); }
  .sub-tabs { margin-top: .9rem; }

  ul.hits, ol.steps, ul.clusters { list-style: none; margin: .4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
  ul.hits button, ol.steps button { display: flex; align-items: baseline; gap: .4rem; width: 100%;
    background: none; border: none; padding: .3rem; text-align: left; cursor: pointer;
    color: var(--ink-dim); border-radius: 4px; }
  ul.hits button:hover, ol.steps button:hover { background: var(--panel-2); color: var(--ink); }
  ul.hits button.on { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--ink); }
  .name { font-family: var(--mono, monospace); font-size: .84rem; }
  .where { margin-left: auto; text-align: right; max-width: 58%;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* The inspector has room for the whole path; the rail does not. */
  .read .where { max-width: 65%; }
  .score { flex: none; }
  li.pad { padding: .3rem; }

  ul.clusters li { display: flex; flex-direction: column; gap: .1rem; padding: .3rem;
                   border-bottom: 1px solid var(--line); }
  .shape h3, .read h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em;
                        color: var(--ink-faint); margin: 1rem 0 .1rem; }

  pre.code { background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
             padding: .6rem; overflow: auto; font-size: .76rem; max-height: 420px; margin: 0 0 .3rem; }
  .col { min-width: 0; }

  .chip { font-size: .75rem; padding: .15rem .45rem; }
  .chip.on { background: var(--panel-2); color: var(--ink); border-color: var(--accent); }

  .hop { color: var(--warn); font-size: .74rem; padding: .15rem .3rem .15rem 1.1rem; }
  .wire { color: var(--warn); }

  @media (max-width: 1100px) {
    .panes { grid-template-columns: 1fr; }
    .find { max-height: none; }
    .read.split { grid-template-columns: 1fr; }
  }
</style>
