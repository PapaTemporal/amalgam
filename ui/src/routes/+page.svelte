<script>
  import { get, post, relative } from "$lib/api.js";
  import Picker from "$lib/Picker.svelte";
  import RemoveProject from "$lib/RemoveProject.svelte";
  import Modal from "$lib/Modal.svelte";

  let state = $state(null);
  let error = $state(null);
  let picking = $state(false);

  async function load() {
    try { state = await get("/state"); } catch (e) { error = e.message; }
  }
  $effect(() => { if (!state && !error) load(); });

  const ready = $derived(state && state.embeddings !== undefined);
  const needsSetup = $derived(state && state.projects.length === 0);

  // Which project is being removed, if any. The dialog shows what would go
  // before anything does.
  let removing = $state(null);

  function remove(event, project) {
    event.preventDefault();
    event.stopPropagation();
    removing = project;
  }

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
        <a class="btn primary" href="/setup/project">Add a project</a>
        <a class="btn" href="/setup/project?new">Start something new</a>
      </div>
    </div>
  {:else}
    <div class="spread" style="margin-bottom:1rem">
      <span class="label">{state.projects.length} project(s)</span>
      <div class="row">
        <a class="btn" href="/setup/project">Add a project</a>
        <a class="btn" href="/setup/project?new">New project</a>
      </div>
    </div>

    {#if picking}
      <div style="margin-bottom:1rem"><Picker onpick={add} /></div>
    {/if}

    <div class="grid">
      {#each state.projects as p}
        <a class="card link" href={`/projects/${p.key}`}>
          <button class="remove" title={`Remove ${p.name}…`} aria-label={`Remove ${p.name}`}
                  onclick={(e) => remove(e, p)}>
            <!-- A bin, not a cross: a cross beside a title reads as "close
                 this", and this deletes nothing until you say so but is still
                 not a dismissal. -->
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M6 2h4M2.5 4h11M4.5 4l.6 9a1 1 0 0 0 1 1h3.8a1 1 0 0 0 1-1l.6-9M6.6 6.5v5M9.4 6.5v5"
                    fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
          <div class="title">
            <strong>{p.name}</strong>
            {#if !p.exists}<span class="pill bad">missing</span>
            {:else if p.dirtyFiles > 0}<span class="pill warn">{p.dirtyFiles} uncommitted</span>
            {:else}<span class="pill good">clean</span>{/if}
          </div>
          <p class="path tiny faint mono" title={p.path}>{p.path}</p>
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

<Modal open={!!removing} title={removing ? `Remove “${removing.name}”?` : ""} onclose={() => (removing = null)}>
  {#if removing}
    <RemoveProject projectKey={removing.key} name={removing.name}
      ondone={() => { removing = null; state = null; load(); }}
      oncancel={() => (removing = null)} />
  {/if}
</Modal>

<style>
  /* Top right, where a control that acts on the whole card belongs — not
     inline beside the title, where it was competing with the name it removes.
     Quiet until the card is hovered: removing a project is a deliberate act,
     not something to invite. */
  .card.link { position: relative; }
  .remove {
    position: absolute; top: .55rem; right: .55rem;
    display: grid; place-items: center; width: 1.75rem; height: 1.75rem;
    background: none; border: 1px solid transparent; border-radius: 6px;
    color: var(--ink-faint); cursor: pointer; opacity: 0; transition: opacity .12s;
  }
  .card:hover .remove, .remove:focus-visible { opacity: 1; }
  .remove:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }

  /* A path is long and a card is not. It wraps rather than being cut, because
     a truncated path is a path you cannot check — and checking which folder a
     card means is most of what the line is for. Two lines at most, and the
     ellipsis lands mid-path where a break is obvious, not at the end where it
     hides the folder name. */
  .path {
    margin: .35rem 0 .6rem;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.45;
  }
  /* Anything still cut is one click from being whole. */
  .card:hover .path { -webkit-line-clamp: unset; }
  /* Room for the button, so a long name never runs under it. */
  .title { padding-right: 2rem; }
</style>
