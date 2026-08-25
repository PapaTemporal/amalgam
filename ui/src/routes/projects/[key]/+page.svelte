<script>
  import { get, post, watchJob } from "$lib/api.js";
  import Stepper from "$lib/Stepper.svelte";
import RemoveProject from "$lib/RemoveProject.svelte";
  import Modal from "$lib/Modal.svelte";
  import Session from "$lib/Session.svelte";
  import StartWork from "$lib/StartWork.svelte";
  import { page } from "$app/state";

  const key = $derived(page.params.key);

  let data = $state(null);
  let insight = $state(null);
  let error = $state(null);
  let job = $state(null);
  let jobLabel = $state("");

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

  // Deep-linkable the same way the map's flows are, so "here is what removing
  // this would delete" can be sent to somebody rather than described.
  let removing = $state(page.url.searchParams.get("remove") !== null);

  // Running the work here, rather than handing over a prompt to run elsewhere.
  let agent = $state(null);            // what this machine can drive
  let sessionId = $state(page.url.searchParams.get("session"));
  let permissionMode = $state("read");
  let starting = $state(false);
  let startError = $state(null);

  $effect(() => { if (!agent) get("/agent").then((a) => (agent = a)).catch(() => {}); });

  // graphify's own interactive graph, if it has been built. Served rather than
  // rebuilt: it is a good page and there is no reason to compete with it.
  let pages = $state(null);
  $effect(() => { if (key && !pages) get("/graphpages", { key }).then((g) => (pages = g)).catch(() => {}); });
  const drawn = $derived((pages?.services ?? []).filter((s) => s.hasPage));
  let showDiagrams = $state(false);
  const undrawn = $derived((pages?.services ?? []).filter((s) => !s.hasPage));

  /**
   * Draw the graph that is already built.
   *
   * Only the clustering pass, not a rebuild: the nodes and edges exist, and
   * re-extracting a large repository to produce a picture would cost minutes
   * for something that takes seconds.
   */
  async function drawDiagram() {
    jobLabel = "Drawing the graph";
    job = { state: "running", steps: [] };
    const { jobId } = await post("/run", { what: "diagram", path: p.path });
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done") pages = await get("/graphpages", { key });
    });
  }

  async function vendorGraph() {
    jobLabel = "Making the graph work offline";
    job = { state: "running", steps: [] };
    const { jobId } = await post("/graphpages/vendor", {});
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done") pages = await get("/graphpages", { key });
    });
  }

  /**
   * Run something, whatever picked it.
   *
   * A task, a chooser's prompt, or BMAD's own help all arrive here the same
   * way: a line of text and a name for the session. There is no composing step
   * left, because the thing that runs is the thing you read.
   */
  let sessionTitle = $state("Session");
  async function startWith(prompt, title) {
    starting = true;
    startError = null;
    try {
      const out = await post("/session/start", { cwd: p.path, prompt, title, permissionMode });
      sessionTitle = title ?? "Session";
      sessionId = out.id;
      const url = new URL(window.location.href);
      url.searchParams.set("session", out.id);
      history.replaceState({}, "", url);
    } catch (e) { startError = e.message; }
    starting = false;
  }


  function closeSession() {
    sessionId = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    history.replaceState({}, "", url);
  }

  // Adding repositories to a project that already exists: the same two ways as
  // the wizard, because a project grows after it is created.
  let addKind = $state(null);
  let cloneUrl = $state("");
  let newName = $state("");

  async function addRepo() {
    const body = addKind === "clone"
      ? { project: p.path, url: cloneUrl.trim() }
      : { project: p.path, name: newName.trim() };
    jobLabel = "Adding a repository";
    job = { state: "running", steps: [] };
    const { jobId } = await post("/service/add", body);
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done") {
        // A new repository is not part of the project until it has been
        // graphed and the links re-checked, so that follows immediately.
        addKind = null; cloneUrl = ""; newName = "";
        await refreshEverything();
      }
    });
  }

  // Taking a repository out of a project, without touching the repository.
  let detaching = $state(null);
  let detachDelete = $state(false);

  async function detach() {
    const svc = detaching;
    detaching = null;
    jobLabel = `Removing ${svc.name}`;
    job = { state: "running", steps: [] };
    const { jobId } = await post("/service/remove", { project: p.path, name: svc.name, deleteFiles: detachDelete });
    detachDelete = false;
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done") { data = null; await load(); }
    });
  }

  async function refreshEverything() {
    jobLabel = "Bringing the project up to date";
    job = { state: "running", steps: [] };
    const { jobId } = await post("/run", { what: "refresh", path: p.path });
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done" || u.state === "failed") {
        data = null;
        // Rebuilding is what creates the diagram in the first place, so what
        // the page knows about built diagrams is stale the moment it finishes.
        pages = null;
        await load();
      }
    });
  }




  const p = $derived(data?.project);
  const unproven = $derived(insight?.trace?.summary?.unproven ?? []);
  const servicesWithChecks = $derived((p?.services ?? []).filter((s) => s.checks.length));
</script>

{#if error}
  <div class="card"><strong>{error}</strong><p class="tiny muted"><a href="/">Back to projects</a></p></div>
{:else if data}
  <header class="page" class:service={p.viewingService}>
    <div class="spread">
      <div>
        {#if p.viewingService}
          <!-- A breadcrumb, not a footnote. A service page is otherwise
               indistinguishable from a project page, which leaves you unsure
               which of the two you are acting on. -->
          <nav class="crumbs tiny">
            <button class="crumb" onclick={backToProject}>{p.parentName}</button>
            <span class="sep">/</span>
            <span class="here">{p.name}</span>
          </nav>
        {/if}
        <h1>{p.name}</h1>
        <div class="sub mono tiny">{p.path}</div>
      </div>
      <div class="row">
        {#if p.viewingService}<span class="pill accent">one repository</span>{/if}
        {#if p.branch}<span class="pill">{p.branch}</span>{/if}
        {#if p.dirtyFiles > 0}<span class="pill warn">{p.dirtyFiles} uncommitted</span>{/if}
        {#if !p.viewingService}
          <button class="ghost danger" onclick={() => (removing = true)}>Remove…</button>
        {/if}
      </div>
    </div>

    {#if p.viewingService}
      <p class="tiny muted note">
        Everything here is scoped to this repository alone — its graph, its checks, work started
        from it. The project's own totals, the links between its services and its planning
        documents live one level up, in
        <button class="linkish" onclick={backToProject}>{p.parentName}</button>.
        This page is not on your project list and removing it is done from there.
      </p>
    {/if}
  </header>

  <!-- What you sat down to do. Tasks, not command names: which workflow
       serves one is the framework's business, and the same command backs
       several of these. -->
  <div class="card" style="margin-bottom:1.25rem">
    <div class="spread">
      <h2 style="margin:0">Start work</h2>
      {#if agent?.cli}
        <div class="row tiny">
          <span class="faint">it may</span>
          {#each agent.modes as m}
            <button class="chip" class:on={permissionMode === m.id}
                    title={m.note} onclick={() => (permissionMode = m.id)}>{m.label}</button>
          {/each}
        </div>
      {/if}
    </div>

    {#if agent && !agent.cli}
      <div class="noagent">
        <strong class="tiny">No agent CLI on this machine.</strong>
        <p class="tiny muted" style="margin:.3rem 0 .5rem">
          With one installed these run here and you watch them work — questions, tool calls and
          all. Without one there is nothing to drive.
        </p>
        <a class="btn" href="/setup">Install it</a>
      </div>
    {/if}

    <div style="margin-top:.7rem">
      <StartWork projectKey={key} onstart={startWith} disabled={starting || !agent?.cli} />
    </div>

    {#if startError}<p class="tiny" style="color:var(--bad);margin-top:.5rem">{startError}</p>{/if}

    {#if sessionId}
      <div class="flow">
        <div class="spread" style="margin-bottom:.5rem">
          <strong>{sessionTitle}</strong>
          <button class="ghost" onclick={closeSession}>Close</button>
        </div>
        <Session id={sessionId} />
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
      {#if p.graph && pages && !drawn.length}
        <p class="tiny faint" style="margin:.4rem 0 0">
          No picture of it yet — drawing takes seconds, the graph is already built.
        </p>
      {/if}
      <div class="row" style="margin-top:.6rem">
        <button disabled={!!p.graphBlocked} onclick={refreshEverything}>
          {p.graph ? "Rebuild" : "Build"}
        </button>
        <a class="btn" href={`/projects/${key}/map`}>Map</a>
        <a class="btn" href={`/projects/${key}/explore`}>Explore</a>
        <!-- Always offered once a graph exists. Hiding it until the page had
             been generated meant there was no way to learn it existed, or
             that it was one click away. -->
        {#if p.graph && !p.workspace && drawn.length === 1}
          <a class="btn" target="_blank" rel="noreferrer" href={`/graph/${key}`}>Diagram</a>
        {:else if p.graph && pages}
          <button onclick={() => (showDiagrams = !showDiagrams)}>
            Diagram{#if !drawn.length} — not drawn yet{/if}
          </button>
        {/if}
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

  {#if showDiagrams && pages}
    <div class="card" style="margin-bottom:1.25rem">
      <div class="spread">
        <div>
          <span class="label">Diagram</span>
          <p class="tiny muted" style="margin:.35rem 0 0;max-width:70ch">
            graphify's own view: every symbol a node, coloured by the community it belongs to,
            with a sidebar to filter and search. One per repository, because that is how it is
            built.
          </p>
        </div>
        {#if undrawn.length}
          <button class="primary" onclick={drawDiagram} disabled={job?.state === "running"}>
            {job?.state === "running" ? "Drawing…" : drawn.length ? `Draw the other ${undrawn.length}` : "Draw it"}
          </button>
        {/if}
      </div>

      <div class="services" style="margin-top:.7rem">
        {#each pages.services as svc}
          {#if svc.hasPage}
            <a class="btn" target="_blank" rel="noreferrer"
               href={`/graph/${key}${p.workspace ? `/${svc.service}` : ""}`}>{svc.service}</a>
          {:else}
            <span class="pending tiny"
                  title={svc.slow
                    ? `${svc.symbols.toLocaleString()} symbols — drawing this one takes a minute or two`
                    : "No page yet — drawing takes seconds, the graph is already built"}>
              {svc.service} · not drawn{#if svc.slow} · slow{/if}
            </span>
          {/if}
        {/each}
      </div>

      {#if undrawn.length}
        <p class="tiny faint" style="margin:.6rem 0 0">
          Drawing is the clustering pass only — the symbols and edges already exist, so it is
          seconds rather than the minutes a rebuild would cost. A very large repository takes a
          minute or two, and is drawn at the scale of its communities rather than its symbols,
          which is what keeps it openable.
        </p>
      {/if}
    </div>
  {/if}

  {#if pages && drawn.length && !pages.vendored && drawn.some((d) => d.needsNetwork)}
    <div class="card" style="margin-bottom:1.25rem">
      <div class="spread">
        <div>
          <strong class="tiny">The diagram needs the internet to draw itself.</strong>
          <p class="tiny muted" style="margin:.35rem 0 0;max-width:62ch">
            graphify's page fetches its drawing library from a CDN, so it is blank offline. One
            686 KB copy kept here and it never reaches the network again.
          </p>
        </div>
        <button onclick={vendorGraph}>Keep a local copy</button>
      </div>
    </div>
  {/if}

  {#if job}
    <div class="card {job.state === 'failed' ? 'bad-edge' : ''}" style="margin-bottom:1.25rem">
      <h2>{job.title ?? jobLabel}</h2>
      <Stepper steps={job.steps} status={job.state} error={job.error} />
    </div>
  {/if}

  {#if !p.viewingService && (p.services.length || (p.exists && !p.isRepo))}
    <div class="card" style="margin-bottom:1.25rem">
      <div class="spread">
        <h2 style="margin:0">Services</h2>
        <span class="tiny faint">
          {p.services.length ? `${p.services.length} repositories in this project` : "no repositories yet"}
        </span>
      </div>
      {#if !p.services.length}
        <p class="tiny muted" style="margin:.5rem 0 0">
          This project is an empty workspace. Clone a repository into it, or start an empty one.
        </p>
      {/if}
      <table style="margin-top:.5rem" class:hidden={!p.services.length}>
        <tbody>
          {#each p.services as svc}
            <tr>
              <td><a href={`/projects/${svc.key}`} onclick={(e) => openService(e, svc)}>{svc.name}</a></td>
              <td class="tiny muted">
                {#if svc.branch}<span class="pill">{svc.branch}</span>{/if}
                {#if svc.indexed}<span class="pill good">{svc.symbols.toLocaleString()} symbols</span>
                {:else if svc.needsIndex}<span class="pill warn"
                  title="graphify wrote a graph file for this service, but amalgam never read it into its index — and every count, search and context packet reads the index, not the file. That is why this service contributes no symbols. Rebuild to fix it.">not indexed — contributes nothing</span>
                {:else}<span class="pill warn">no graph</span>{/if}
                {#if svc.checks.length}<span class="pill">{svc.checks.join(", ")}</span>
                {:else}<span class="pill warn">no checks</span>{/if}
              </td>
              <td class="row-actions">
                <button class="linky" title={`Remove ${svc.name} from this project`}
                        onclick={() => (detaching = svc)}>Remove…</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <div class="row" style="margin-top:.75rem">
        <button onclick={() => (addKind = addKind ? null : "clone")}>Add a repository</button>
      </div>

      {#if addKind}
        <div class="addrepo">
          <div class="row">
            <button class:primary={addKind === "clone"} onclick={() => (addKind = "clone")}>Clone existing</button>
            <button class:primary={addKind === "create"} onclick={() => (addKind = "create")}>Create empty</button>
          </div>
          {#if addKind === "clone"}
            <div class="row">
              <input type="text" bind:value={cloneUrl} placeholder="https://github.com/you/service.git" />
              <button class="primary" onclick={addRepo} disabled={!cloneUrl.trim()}>Clone</button>
            </div>
          {:else}
            <div class="row">
              <input type="text" bind:value={newName} placeholder="api-server" />
              <button class="primary" onclick={addRepo} disabled={!newName.trim()}>Create</button>
            </div>
          {/if}
          <span class="tiny faint">The graph and the links between services are rebuilt straight after.</span>
        </div>
      {/if}

      {#if p.services.some((s) => s.needsIndex)}
        <p class="tiny" style="margin:.75rem 0 0;color:var(--warn)">
          A service marked <strong>not indexed</strong> has a graph file that amalgam never read
          in. Counts, search and context all come from the index rather than the file, so those
          services add nothing to the totals above until a rebuild succeeds.
        </p>
      {/if}
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

<Modal open={!!detaching} title={detaching ? `Remove “${detaching.name}” from ${p?.name ?? "this project"}?` : ""}
       onclose={() => { detaching = null; detachDelete = false; }}>
  {#if detaching}
    <p class="tiny muted">
      It stops being a service of this project: its code graph and its contracts come out of the
      project's totals. By default the folder stays exactly where it is.
    </p>
    <label class="opt">
      <input type="checkbox" bind:checked={detachDelete} />
      <span>
        <strong>Also delete the folder from disk</strong>
        <br /><span class="tiny muted">
          <span class="mono">{detaching.path}</span> and everything in it, including uncommitted work.
          This cannot be undone.
        </span>
      </span>
    </label>
    <div class="row" style="justify-content:flex-end;margin-top:1rem">
      <button class="ghost" onclick={() => { detaching = null; detachDelete = false; }}>Cancel</button>
      <button class="danger primary" onclick={detach}>
        {detachDelete ? "Remove and delete the folder" : "Remove from this project"}
      </button>
    </div>
  {/if}
</Modal>

<Modal open={removing} title={`Remove “${p?.name ?? ""}”?`} onclose={() => (removing = false)}>
  {#if removing}
    <RemoveProject projectKey={key} name={p.name}
      ondone={() => (location.href = "/")} oncancel={() => (removing = false)} />
  {/if}
</Modal>

<style>
  table.hidden { display: none; }
  .noagent { border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line));
             border-radius: 8px; padding: .7rem .8rem; margin-top: .5rem; }
  .services { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
  .pending { color: var(--ink-faint); border: 1px dashed var(--line); border-radius: 6px;
             padding: .35rem .6rem; }
  .row-actions { text-align: right; width: 1%; white-space: nowrap; }
  .linky { background: none; border: none; color: var(--ink-faint); font-size: .78rem;
           cursor: pointer; padding: .2rem .35rem; border-radius: 4px; }
  .linky:hover { color: var(--bad); background: var(--panel-2); }
  .opt { display: flex; gap: .7rem; align-items: flex-start; cursor: pointer; margin-top: .9rem; }
  .opt input { margin-top: .3rem; }
  button.danger.primary { background: var(--bad); border-color: var(--bad); color: #1a0808; }
  .addrepo { display: flex; flex-direction: column; gap: .5rem; margin-top: .75rem;
             border-top: 1px solid var(--line); padding-top: .75rem; }
  /* A service is a place inside something, and the page should feel like one:
     a rail down the side, a breadcrumb, and a sentence saying where "up" is. */
  header.service { border-left: 3px solid var(--accent); padding-left: .9rem;
                   margin-left: -.9rem; }
  .crumbs { display: flex; align-items: center; gap: .4rem; margin-bottom: .2rem; }
  .crumb { background: none; border: none; padding: 0; cursor: pointer; color: var(--ink-faint);
           font-size: .78rem; }
  .crumb:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
  .crumbs .sep { color: var(--ink-faint); }
  .crumbs .here { color: var(--ink-dim); font-size: .78rem; }
  .pill.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  header .note { margin: .6rem 0 0; max-width: 74ch; }
  .linkish { background: none; border: none; padding: 0; cursor: pointer; color: var(--accent);
             font: inherit; }
  .linkish:hover { text-decoration: underline; text-underline-offset: 3px; }

  .flow { margin-top: .9rem; border-top: 1px solid var(--line); padding-top: .9rem; }
  .bad-edge { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  /* Wrapped rather than scrolled: the whole point of showing the prompt is
     that someone reads it before it runs, and a horizontal scrollbar is where
     reading stops. */
  .flow :global(pre.out) { white-space: pre-wrap; word-break: break-word; max-height: 420px; }
  ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
</style>
