<script>
  import { get, post, watchJob } from "$lib/api.js";
  import Stepper from "$lib/Stepper.svelte";
  import { page } from "$app/state";

  const key = $derived(page.params.key);

  let data = $state(null);
  let insight = $state(null);
  let error = $state(null);
  let job = $state(null);
  let jobLabel = $state("");
  let flow = $state(null);
  let copied = $state(false);

  async function load() {
    try {
      const q = service ? { key, service } : { key };
      data = await get("/project", q);
      // Stories and risk arrive behind the page rather than holding it up: on a
      // large repository they take hundreds of times longer than everything
      // else, and a dashboard that will not open is worse than one that fills in.
      insight = null;
      get("/insight", q).then((i) => (insight = i)).catch(() => (insight = { failed: true }));
    } catch (e) { error = e.message; }
  }
  $effect(() => { if (key && !data && !error) load(); });

  async function run(what, label) {
    jobLabel = label;
    job = { state: "running", steps: [] };
    const { jobId } = await post("/run", { what, path: data.project.path });
    watchJob(jobId, (u) => {
      job = u;
      // A report that changes the project's state should be reflected without
      // the user having to work out that they need to reload.
      if (u.state === "done" && (what === "graph" || what === "gate")) load();
    });
  }

  // Viewing a service does not add it to anything: it is looked at through the
  // project it belongs to. Adding it silently was how people ended up with
  // list entries they never chose.
  let service = $state(page.url.searchParams.get("service"));

  async function openService(event, svc) {
    event.preventDefault();
    service = svc.name;
    data = null;
    const url = new URL(window.location.href);
    url.searchParams.set("service", svc.name);
    history.replaceState({}, "", url);
    await load();
  }

  async function backToProject() {
    service = null;
    data = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("service");
    history.replaceState({}, "", url);
    await load();
  }

  async function removeProject() {
    if (!confirm(`Remove "${p.name}" from the project list?

Nothing on disk is touched — no files, no graph, no memory. It only stops appearing here.`)) return;
    await post("/projects/remove", { key });
    location.href = "/";
  }

  async function startFlow(kind) {
    flow = await post("/flow/compose", { key, flow: kind });
    copied = false;
    // Deep-linkable, so a composed prompt can be bookmarked or sent to
    // somebody else rather than described to them.
    const url = new URL(window.location.href);
    url.searchParams.set("flow", kind);
    history.replaceState({}, "", url);
  }

  // Opening /projects/<key>?flow=feature composes it immediately.
  let autoFlow = $state(false);
  $effect(() => {
    const wanted = page.url.searchParams.get("flow");
    if (data && wanted && !autoFlow) { autoFlow = true; startFlow(wanted); }
  });

  async function copyPrompt() {
    await navigator.clipboard.writeText(flow.prompt);
    copied = true;
  }

  const p = $derived(data?.project);
  const unproven = $derived(insight?.trace?.summary?.unproven ?? []);
  const servicesWithChecks = $derived((p?.services ?? []).filter((s) => s.checks.length));
</script>

{#if error}
  <div class="card"><strong>{error}</strong><p class="tiny muted"><a href="/">Back to projects</a></p></div>
{:else if data}
  <header class="page">
    {#if p.viewingService}
      <p class="tiny muted" style="margin:0 0 .35rem">
        <button class="ghost tiny" onclick={backToProject}>← {p.parentName}</button>
        <span class="faint">viewing one service — it is not on your project list</span>
      </p>
    {/if}
    <div class="spread">
      <div>
        <h1>{p.name}</h1>
        <div class="sub mono tiny">{p.path}</div>
      </div>
      <div class="row">
        {#if p.branch}<span class="pill">{p.branch}</span>{/if}
        {#if p.dirtyFiles > 0}<span class="pill warn">{p.dirtyFiles} uncommitted</span>{/if}
        {#if !p.viewingService}
          <button class="ghost danger" onclick={removeProject}>Remove from list</button>
        {/if}
      </div>
    </div>
  </header>

  <!-- What the agent can be asked to do. The three shapes of work people
       actually start: something new, something already specified, or a look
       at what is already there. -->
  <div class="card" style="margin-bottom:1.25rem">
    <h2>Start work</h2>
    <div class="row">
      <button class:primary={!flow || flow.id === "feature"} onclick={() => startFlow("feature")}>New feature</button>
      <button class:primary={flow?.id === "story"} onclick={() => startFlow("story")}>Continue a story</button>
      <button class:primary={flow?.id === "fix"} onclick={() => startFlow("fix")}>Fix a bug</button>
      <button class:primary={flow?.id === "explore"} onclick={() => startFlow("explore")}>Understand this code</button>
    </div>

    {#if flow}
      <div class="flow">
        <div class="spread">
          <strong>{flow.title}</strong>
          <div class="row">
            <button onclick={copyPrompt}>{copied ? "Copied" : "Copy prompt"}</button>
            {#if flow.canLaunch}<button class="primary" onclick={() => post("/flow/launch", { key, flow: flow.id })}>
              Open in a session
            </button>{/if}
            <button class="ghost" onclick={() => (flow = null)}>Close</button>
          </div>
        </div>
        <p class="tiny muted" style="margin:.4rem 0">{flow.explain}</p>
        <pre class="out">{flow.prompt}</pre>
      </div>
    {/if}
  </div>

  <div class="grid" style="margin-bottom:1.25rem">
    <div class="card">
      <span class="label">Code graph</span>
      {#if p.graph}
        <div class="stat small">{p.graph.symbols.toLocaleString()} symbols</div>
        <span class="tiny faint">
          {p.graph.edges.toLocaleString()} edges
          {#if p.graph.services}· across {p.graph.services.filter((s) => s.indexed).length} of {p.graph.services.length} services{/if}
        </span>
      {:else}
        <div class="stat small">none</div>
        <span class="tiny faint">{p.graphBlocked ?? "code search and impact need this"}</span>
      {/if}
      <div class="row" style="margin-top:.6rem">
        <button disabled={!!p.graphBlocked} onclick={() => run("graph", "Building the code graph")}>
          {p.graph ? "Rebuild" : "Build"}
        </button>
        <a class="btn" href={`/projects/${key}/map`}>Map</a>
      </div>
    </div>

    <div class="card">
      <span class="label">Checks</span>
      {#if p.checks.length}
        <div class="stat small">{p.checks.join(", ")}</div>
        <span class="tiny faint">run before any review</span>
      {:else if servicesWithChecks.length}
        <div class="stat small">{servicesWithChecks.length} of {p.services.length} services</div>
        <span class="tiny faint">{servicesWithChecks.map((s) => s.name).join(", ")}</span>
      {:else}
        <div class="stat small">none detected</div>
        <span class="tiny faint">without these, nothing can tell if a change broke something</span>
      {/if}
      <div style="margin-top:.6rem"><button onclick={() => run("gate", "Running the project checks")}>Run gate</button></div>
    </div>

    <div class="card">
      <span class="label">Stories</span>
      {#if !insight}
        <div class="stat small faint">…</div>
        <span class="tiny faint">looking for specs</span>
      {:else}
        <div class="stat small">{insight.trace?.summary.stories ?? 0}</div>
        <span class="tiny faint">
          {#if unproven.length}
            <span style="color:var(--warn)">{unproven.length} done with no way to check them</span>
          {:else if insight.trace?.summary.stories}all declare a check{:else}no specs found{/if}
        </span>
      {/if}
      <div style="margin-top:.6rem"><button onclick={() => run("trace", "Verifying stories")}>Verify</button></div>
    </div>

    <div class="card">
      <span class="label">Work streams</span>
      <div class="stat small">{data.streams.length}</div>
      <span class="tiny faint">
        {data.streams.length > 1 ? "check them for collisions before merging" : "isolated worktrees"}
      </span>
      <div style="margin-top:.6rem">
        <button disabled={data.streams.length < 2} onclick={() => run("collide", "Checking for collisions")}>
          Check collisions
        </button>
      </div>
    </div>
  </div>

  {#if job}
    <div class="card {job.state === 'failed' ? 'bad-edge' : ''}" style="margin-bottom:1.25rem">
      <h2>{job.title ?? jobLabel}</h2>
      <Stepper steps={job.steps} state={job.state} error={job.error} />
    </div>
  {/if}

  {#if p.services.length}
    <div class="card" style="margin-bottom:1.25rem">
      <div class="spread">
        <h2 style="margin:0">Services</h2>
        <span class="tiny faint">{p.services.length} repositories in this project</span>
      </div>
      <table style="margin-top:.5rem">
        <tbody>
          {#each p.services as svc}
            <tr>
              <td><a href={`/projects/${svc.key}`} onclick={(e) => openService(e, svc)}>{svc.name}</a></td>
              <td class="tiny muted">
                {#if svc.branch}<span class="pill">{svc.branch}</span>{/if}
                {#if svc.indexed}<span class="pill good">{svc.symbols.toLocaleString()} symbols</span>
                {:else if svc.needsIndex}<span class="pill warn">graph built, not indexed</span>
                {:else}<span class="pill warn">no graph</span>{/if}
                {#if svc.checks.length}<span class="pill">{svc.checks.join(", ")}</span>
                {:else}<span class="pill warn">no checks</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="tiny faint" style="margin:.75rem 0 0">
        Building the graph here builds one per service and the project totals them.
        Open a service to work inside it alone.
      </p>
    </div>
  {/if}

  {#if insight?.risk}
    <div class="card" style="margin-bottom:1.25rem">
      <h2>Riskiest files</h2>
      <p class="tiny faint" style="margin-top:-.4rem">
        Churn × dependents over {insight.risk.commits} commits. Read the reasons, not the order.
      </p>
      <table>
        <tbody>
          {#each insight.risk.rows as r}
            <tr>
              <td class="mono">{r.tested ? "" : "!"} {r.file}</td>
              <td class="tiny muted">{r.why.join(", ")}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if insight.risk.coupling.length}
        <h3 style="margin-top:1rem">Changes together but lives apart</h3>
        <ul class="tiny muted plain">
          {#each insight.risk.coupling as c}<li>{c.n}× &nbsp;{c.a} + {c.b}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="grid">
    {#if data.tasks.length}
      <div class="card">
        <h2>Work items</h2>
        <ul class="plain">
          {#each data.tasks as t}
            <li class="spread">
              <span>{t.title}</span>
              <span class="pill {t.state === 'open' ? '' : 'good'}">{t.state}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if data.streams.length}
      <div class="card">
        <h2>Streams</h2>
        <ul class="plain">
          {#each data.streams as s}
            <li class="spread">
              <span class="mono tiny">{s.name}</span>
              <span class="pill {s.action === 'keep' ? '' : 'warn'}">{s.action}: {s.why}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{:else}
  <p class="faint">reading project…</p>
{/if}

<style>
  .flow { margin-top: .9rem; border-top: 1px solid var(--line); padding-top: .9rem; }
  .bad-edge { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  /* Wrapped rather than scrolled: the whole point of showing the prompt is
     that someone reads it before it runs, and a horizontal scrollbar is where
     reading stops. */
  .flow :global(pre.out) { white-space: pre-wrap; word-break: break-word; max-height: 420px; }
  ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
</style>
