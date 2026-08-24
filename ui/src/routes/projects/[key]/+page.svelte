<script>
  import { get, post, watchJob } from "$lib/api.js";
  import Stepper from "$lib/Stepper.svelte";
  import { page } from "$app/state";

  const key = $derived(page.params.key);

  let data = $state(null);
  let error = $state(null);
  let job = $state(null);
  let jobLabel = $state("");
  let flow = $state(null);
  let copied = $state(false);

  async function load() {
    try { data = await get("/project", { key }); } catch (e) { error = e.message; }
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

  async function addService(servicePath) {
    const added = await post("/projects/add", { path: servicePath });
    location.href = `/projects/${added.project.key}`;
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
  const unproven = $derived(data?.trace?.summary?.unproven ?? []);
</script>

{#if error}
  <div class="card"><strong>{error}</strong><p class="tiny muted"><a href="/">Back to projects</a></p></div>
{:else if data}
  <header class="page">
    <div class="spread">
      <div>
        <h1>{p.name}</h1>
        <div class="sub mono tiny">{p.path}</div>
      </div>
      <div class="row">
        {#if p.branch}<span class="pill">{p.branch}</span>{/if}
        {#if p.dirtyFiles > 0}<span class="pill warn">{p.dirtyFiles} uncommitted</span>{/if}
      </div>
    </div>
  </header>

  {#if p.isWorkspace}
    <!-- The failure that looks like a bug: a folder holding repositories is
         not a project, so a graph never appears there however many times the
         button is pressed, and no checks are found either. Say it plainly and
         offer the thing that does work. -->
    <div class="card notice" style="margin-bottom:1.25rem">
      <strong>This folder holds {p.services.length} repositories — it is not a project itself.</strong>
      <p class="tiny muted" style="margin:.4rem 0 .75rem">
        A code graph and a set of checks belong to each repository, not to the folder above them.
        That is why building a graph here never changes anything, and why no checks were detected.
        Add the repositories instead:
      </p>
      <div class="row">
        {#each p.services as svc}
          <button onclick={() => addService(svc.path)}>{svc.name}</button>
        {/each}
      </div>
    </div>
  {/if}

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
        <div class="stat small">{p.graph.symbols} symbols</div>
        <span class="tiny faint">{p.graph.edges} edges · indexed {p.graph.importedAt}</span>
      {:else}
        <div class="stat small">none</div>
        <span class="tiny faint">{p.graphBlocked ?? "code search and impact need this"}</span>
      {/if}
      <div style="margin-top:.6rem">
        <button disabled={!!p.graphBlocked} onclick={() => run("graph", "Building the code graph")}>
          {p.graph ? "Rebuild" : "Build"}
        </button>
      </div>
    </div>

    <div class="card">
      <span class="label">Checks</span>
      <div class="stat small">{p.checks.length ? p.checks.join(", ") : "none detected"}</div>
      <span class="tiny faint">
        {p.checks.length ? "run before any review"
          : p.isWorkspace ? "checks live in each repository, not here"
          : "without these, nothing can tell if a change broke something"}
      </span>
      <div style="margin-top:.6rem"><button onclick={() => run("gate", "Running the project checks")}>Run gate</button></div>
    </div>

    <div class="card">
      <span class="label">Stories</span>
      <div class="stat small">{data.trace.summary.stories}</div>
      <span class="tiny faint">
        {#if unproven.length}
          <span style="color:var(--warn)">{unproven.length} done with no way to check them</span>
        {:else if data.trace.summary.stories}all declare a check{:else}no specs found{/if}
      </span>
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

  {#if data.risk}
    <div class="card" style="margin-bottom:1.25rem">
      <h2>Riskiest files</h2>
      <p class="tiny faint" style="margin-top:-.4rem">
        Churn × dependents over {data.risk.commits} commits. Read the reasons, not the order.
      </p>
      <table>
        <tbody>
          {#each data.risk.rows as r}
            <tr>
              <td class="mono">{r.tested ? "" : "!"} {r.file}</td>
              <td class="tiny muted">{r.why.join(", ")}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if data.risk.coupling.length}
        <h3 style="margin-top:1rem">Changes together but lives apart</h3>
        <ul class="tiny muted plain">
          {#each data.risk.coupling as c}<li>{c.n}× &nbsp;{c.a} + {c.b}</li>{/each}
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
  .notice { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .bad-edge { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  /* Wrapped rather than scrolled: the whole point of showing the prompt is
     that someone reads it before it runs, and a horizontal scrollbar is where
     reading stops. */
  .flow :global(pre.out) { white-space: pre-wrap; word-break: break-word; max-height: 420px; }
  ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
</style>
