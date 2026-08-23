<script>
  import { get, post, watchJob } from "$lib/api.js";
  import Stepper from "$lib/Stepper.svelte";
  import Picker from "$lib/Picker.svelte";
  import { page } from "$app/state";

  let state = $state(null);
  let job = $state(null);
  let mode = $state(page.url.searchParams.get("new") ? "project" : "machine");

  let embeddings = $state(true);
  let model = $state(false);

  let chosen = $state(null);
  let bmad = $state(true);
  let gitInit = $state(false);

  $effect(() => {
    if (!state) get("/state").then((s) => { state = s; model = s.model; });
  });

  function follow(jobId) {
    job = { state: "running", steps: [] };
    watchJob(jobId, (u) => (job = u));
    // In the URL so a refresh — or a second window — keeps watching rather
    // than losing a job that is still running.
    const url = new URL(window.location.href);
    url.searchParams.set("job", jobId);
    history.replaceState({}, "", url);
  }

  async function run(endpoint, body) {
    const { jobId } = await post(endpoint, body);
    follow(jobId);
  }

  let followed = $state(false);
  $effect(() => {
    const existing = page.url.searchParams.get("job");
    if (existing && !followed) { followed = true; follow(existing); }
  });

  const done = $derived(job?.state === "done");
</script>

<header class="page">
  <h1>Setup</h1>
  <div class="sub">Everything here is a command you could type. It is shown as it runs.</div>
</header>

<div class="row" style="margin-bottom:1.25rem">
  <button class:primary={mode === "machine"} onclick={() => { mode = "machine"; job = null; }}>This machine</button>
  <button class:primary={mode === "project"} onclick={() => { mode = "project"; job = null; }}>A project</button>
</div>

{#if job}
  <div class="card">
    <h2>{job.title ?? (mode === "machine" ? "Setting up amalgam" : "Setting up the project")}</h2>
    <Stepper steps={job.steps} state={job.state} error={job.error} />
    {#if done}
      <div class="row" style="margin-top:.5rem">
        {#if mode === "machine"}
          <button class="primary" onclick={() => { mode = "project"; job = null; }}>Now set up a project</button>
        {:else}
          <a class="btn" href="/">Back to projects</a>
        {/if}
        <button class="ghost" onclick={() => (job = null)}>Run something else</button>
      </div>
      <p class="tiny faint" style="margin-top:.75rem">
        Restart any open agent session — it is still using the tool list it started with.
      </p>
    {/if}
  </div>

{:else if mode === "machine"}
  <div class="card stack">
    <div>
      <h2>Install and wire</h2>
      <p class="tiny muted">
        Copies amalgam into your home directory, registers it for every project on this machine,
        and puts <code>amalgam</code> on your PATH. Nothing is installed system-wide and nothing
        runs as a service.
      </p>
    </div>

    <label class="opt">
      <input type="checkbox" bind:checked={embeddings} />
      <span>
        <strong>Semantic recall</strong> <span class="pill">~220 MB</span>
        <br /><span class="tiny muted">
          Search memory and code by meaning rather than exact words.
          {#if state?.embeddings}Already installed.{/if}
        </span>
      </span>
    </label>

    <label class="opt">
      <input type="checkbox" bind:checked={model} />
      <span>
        <strong>Local model</strong> <span class="pill">~2.5 GB</span>
        <br /><span class="tiny muted">
          Powers digest, better code-search ranking and session capture. Optional — everything
          else works without it.
          {#if state?.model}Already installed.{/if}
        </span>
      </span>
    </label>

    <div>
      <button class="primary" onclick={() => run("/setup/machine", { embeddings, model })}>Start setup</button>
    </div>
  </div>

{:else}
  <div class="card stack">
    <div>
      <h2>What project do you want to set up?</h2>
      <p class="tiny muted">Pick a folder. It does not need to be a git repository yet.</p>
    </div>

    {#if chosen}
      <div class="spread">
        <span class="mono tiny">{chosen}</span>
        <button class="ghost" onclick={() => (chosen = null)}>Change</button>
      </div>

      <label class="opt">
        <input type="checkbox" bind:checked={bmad} />
        <span>
          <strong>Install BMAD workflows</strong>
          <br /><span class="tiny muted">Planning, story and build workflows for your agent.</span>
        </span>
      </label>

      <label class="opt">
        <input type="checkbox" bind:checked={gitInit} />
        <span>
          <strong>Initialise git if it is not a repository yet</strong>
          <br /><span class="tiny muted">Streams, impact and history all need version control.</span>
        </span>
      </label>

      <div>
        <button class="primary" onclick={() => run("/setup/project", { path: chosen, bmad, git: gitInit })}>
          Set up this project
        </button>
      </div>
    {:else}
      <Picker onpick={(p) => (chosen = p)} />
    {/if}
  </div>
{/if}

<style>
  .opt { display: flex; gap: .7rem; align-items: flex-start; cursor: pointer; }
  .opt input { margin-top: .3rem; }
</style>
