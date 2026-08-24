<script>
  import { get, post, relative } from "$lib/api.js";
  import Picker from "$lib/Picker.svelte";

  let state = $state(null);
  let error = $state(null);
  let picking = $state(false);

  async function load() {
    try { state = await get("/state"); } catch (e) { error = e.message; }
  }
  $effect(() => { if (!state && !error) load(); });

  const ready = $derived(state && state.embeddings !== undefined);
  const needsSetup = $derived(state && state.projects.length === 0);

  async function add(path) {
    picking = false;
    await post("/projects/add", { path });
    state = null;
    load();
  }
</script>

<header class="page">
  <h1>Projects</h1>
  <div class="sub">
    {#if state}
      {state.counts.facts} facts remembered · {state.counts.openTasks} open task(s)
      {#if state.counts.pending > 0}
        · <a href="/memory">{state.counts.pending} fact(s) waiting for review</a>
      {/if}
    {:else}reading local state…{/if}
  </div>
</header>

{#if error}
  <div class="card"><strong>Cannot reach the local API</strong>
    <p class="tiny muted">{error}</p></div>
{:else if state}
  {#if !state.embeddings || !state.model}
    <div class="card" style="margin-bottom:1rem">
      <div class="spread">
        <div>
          <strong>Optional pieces are not installed</strong>
          <p class="tiny muted" style="margin:.25rem 0 0">
            {#if !state.embeddings}Search works by keyword only — semantic recall needs the embedding model (~220 MB).{/if}
            {#if !state.model} Digest, re-ranking and session capture need the local model (~2.5 GB).{/if}
          </p>
        </div>
        <a class="btn" href="/setup">Set up</a>
      </div>
    </div>
  {/if}

  {#if needsSetup && !picking}
    <div class="card empty">
      <p>No projects yet. Point amalgam at a codebase to begin.</p>
      <div class="row" style="justify-content:center">
        <button class="primary" onclick={() => (picking = true)}>Add a project</button>
        <a class="btn" href="/setup?new=1">Start something new</a>
      </div>
    </div>
  {:else}
    <div class="spread" style="margin-bottom:1rem">
      <span class="label">{state.projects.length} project(s)</span>
      <div class="row">
        <button onclick={() => (picking = !picking)}>{picking ? "Cancel" : "Add a project"}</button>
        <a class="btn" href="/setup?new=1">New project</a>
      </div>
    </div>

    {#if picking}
      <div style="margin-bottom:1rem"><Picker onpick={add} /></div>
    {/if}

    <div class="grid">
      {#each state.projects as p}
        <a class="card link" href={`/projects/${p.key}`}>
          <div class="title">
            <strong>{p.name}</strong>
            {#if !p.exists}<span class="pill bad">missing</span>
            {:else if p.dirtyFiles > 0}<span class="pill warn">{p.dirtyFiles} uncommitted</span>
            {:else}<span class="pill good">clean</span>{/if}
          </div>
          <p class="tiny faint mono" style="margin:.35rem 0 .6rem">{p.path}</p>
          <div class="row tiny muted">
            {#if p.branch}<span class="pill">{p.branch}</span>{/if}
            {#if p.hasBmad}<span class="pill">bmad</span>{/if}
            {#if p.workspace}<span class="pill">{p.services.length} services</span>{/if}
            {#if p.graph}<span class="pill">{p.graph.symbols.toLocaleString()} symbols</span>
            {:else}<span class="pill warn">no graph</span>{/if}
            {#if p.checks.length}<span class="pill">{p.checks.join(", ")}</span>
            {:else if p.services?.some((s) => s.checks.length)}
              <span class="pill">checks in {p.services.filter((s) => s.checks.length).length} service(s)</span>
            {:else}<span class="pill warn">no checks</span>{/if}
            {#if p.tasks}<span class="pill">{p.tasks} task(s)</span>{/if}
            {#if p.streams}<span class="pill">{p.streams} stream(s)</span>{/if}
          </div>
        </a>
      {/each}
    </div>
  {/if}

  <div class="card" style="margin-top:1.5rem">
    <div class="spread">
      <div>
        <span class="label">This machine</span>
        <p class="tiny muted" style="margin:.35rem 0 0">
          Node {state.node} · {state.embeddings ? "semantic recall on" : "keyword search only"} ·
          {!state.model ? "no local model"
            : state.modelRunning ? `model running, idle ${Math.floor(state.modelIdleMinutes ?? 0)}m of ${state.modelIdleLimit}m`
            : "local model installed, not running"} ·
          {state.uv ? "graphify available" : "uv missing — no code graphs"}
        </p>
      </div>
      <div class="row tiny faint">
        {#if state.agents.found.length}
          {#each state.agents.found as a}<span class="pill good">{a.label}</span>{/each}
        {:else}
          <span class="pill">no agent CLI — prompts will be copied</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
