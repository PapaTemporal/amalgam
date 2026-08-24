<script>
  import { get, post, watchJob } from "$lib/api.js";
  import Stepper from "$lib/Stepper.svelte";
  import { page } from "$app/state";

  /**
   * The machine, not the projects.
   *
   * Projects have their own wizard and their own page, so this one stopped
   * asking which you meant. What it is for is the install itself: what is
   * deployed, what is missing, and the two commands that change that —
   * installing and updating. Both are `amalgam` commands run as jobs, so
   * nothing here can be done from the UI that could not be typed.
   */
  let state = $state(null);
  let install = $state(null);
  let job = $state(null);
  let jobTitle = $state("");

  let embeddings = $state(true);
  let model = $state(false);

  async function load() {
    const [s, i] = await Promise.all([get("/state"), get("/install")]);
    state = s;
    install = i;
    model = s.model;
    embeddings = s.embeddings || embeddings;
  }
  $effect(() => { if (!state) load(); });

  function follow(jobId, title) {
    jobTitle = title;
    job = { state: "running", steps: [] };
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done") { install = null; state = null; await load(); }
    });
    // In the URL so a refresh — or a second window — keeps watching rather
    // than losing a job that is still running.
    const url = new URL(window.location.href);
    url.searchParams.set("job", jobId);
    history.replaceState({}, "", url);
  }

  async function runInstall() {
    const { jobId } = await post("/setup/machine", { embeddings, model });
    follow(jobId, install?.installed ? "Reinstalling amalgam" : "Setting up amalgam");
  }

  async function runUpdate() {
    const { jobId } = await post("/update", {});
    follow(jobId, "Updating amalgam");
  }

  let followed = $state(false);
  $effect(() => {
    const existing = page.url.searchParams.get("job");
    if (existing && !followed) { followed = true; follow(existing, "Running"); }
  });

  const done = $derived(job?.state === "done");
  const updated = $derived(done && jobTitle === "Updating amalgam");
</script>

<header class="page">
  <div class="spread">
    <div>
      <h1>This machine</h1>
      <div class="sub">Everything here is a command you could type. It is shown as it runs.</div>
    </div>
    {#if install}
      <span class="pill {install.installed ? 'good' : 'warn'}">
        {install.installed ? `v${install.version}${install.sourceCommit ? ` · ${install.sourceCommit}` : ""}` : "not installed"}
      </span>
    {/if}
  </div>
</header>

{#if install && !install.installed}
  <div class="card edge-warn" style="margin-bottom:1.25rem">
    <strong>amalgam is not deployed on this machine.</strong>
    <p class="tiny muted" style="margin:.4rem 0 0">
      The pages load from the clone either way, but the parts agents use — the MCP server, the
      skills, the hooks — live in <span class="mono">{install.home}</span> and are not there yet.
      Install below.
    </p>
  </div>
{:else if install?.stale}
  <div class="card edge-warn" style="margin-bottom:1.25rem">
    <strong>There is a newer version in your clone than the one deployed.</strong>
    <p class="tiny muted" style="margin:.4rem 0 0">
      Deployed <span class="mono">{install.deployedCommit}</span>,
      clone is at <span class="mono">{install.sourceCommit}</span>. Update to deploy it.
    </p>
  </div>
{/if}

{#if job}
  <div class="card {job.state === 'failed' ? 'edge-bad' : ''}" style="margin-bottom:1.25rem">
    <h2>{job.title ?? jobTitle}</h2>
    <Stepper steps={job.steps} state={job.state} error={job.error} />
    {#if done}
      <div class="row" style="margin-top:.5rem">
        <a class="btn primary" href="/">Back to projects</a>
        {#if updated}
          <button onclick={() => location.reload()}>Reload the UI</button>
        {/if}
        <button class="ghost" onclick={() => (job = null)}>Run something else</button>
      </div>
      <p class="tiny faint" style="margin-top:.75rem">
        Restart any open agent session — it is still using the tool list it started with.
        {#if updated}These pages came from the version you just replaced, so reload them too.{/if}
      </p>
    {/if}
  </div>
{/if}

<div class="two">
  <!-- installing, or installing again ------------------------------------- -->
  <div class="card stack">
    <div>
      <h2>{install?.installed ? "Reinstall" : "Install and wire"}</h2>
      <p class="tiny muted">
        Copies amalgam into your home directory, registers it for every project on this machine,
        and puts <code>amalgam</code> on your PATH. Nothing is installed system-wide and nothing
        runs as a service.
        {#if install?.installed}
          Running it again overwrites the deployed copy — safe, and the way to repair one that
          has drifted. Your memory database and projects are untouched.
        {/if}
      </p>
    </div>

    <label class="opt">
      <input type="checkbox" bind:checked={embeddings} />
      <span>
        <strong>Semantic recall</strong> <span class="pill">~220 MB</span>
        <br /><span class="tiny muted">
          Search memory and code by meaning rather than exact words.
          {#if state?.embeddings}Already installed — left alone.{/if}
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
          {#if state?.model}Already installed — left alone.{/if}
        </span>
      </span>
    </label>

    <div>
      <button class="primary" onclick={runInstall} disabled={job?.state === "running"}>
        {install?.installed ? "Reinstall over the top" : "Start setup"}
      </button>
    </div>
  </div>

  <!-- updating ------------------------------------------------------------- -->
  <div class="card stack">
    <div>
      <h2>Update</h2>
      <p class="tiny muted">
        Pulls the latest source, re-deploys it, and refreshes the wiring in every project that
        was wired. The built pages are part of the repository, so this updates the UI as well —
        which is why it can live here rather than in a terminal.
      </p>
    </div>

    {#if install}
      <dl class="facts">
        <div><dt>Source</dt><dd class="mono tiny">{install.source}</dd></div>
        <div><dt>Deployed to</dt><dd class="mono tiny">{install.home}</dd></div>
        <div><dt>Wired</dt><dd class="tiny">
          {install.wiredUser ? "every project on this machine" : "not at machine level"}{install.wiredProjects ? `, ${install.wiredProjects} named project(s)` : ""}
        </dd></div>
        {#if install.installedAt}
          <div><dt>Last deployed</dt><dd class="tiny">{new Date(install.installedAt).toLocaleString()}</dd></div>
        {/if}
      </dl>

      {#if !install.isClone}
        <p class="tiny warn-text">
          This copy is not a git clone, so there is nothing to pull. Update will still re-deploy
          and re-wire what is here.
        </p>
      {:else if install.dirty}
        <p class="tiny warn-text">
          {install.dirty} uncommitted change(s) in the clone — the pull is skipped rather than
          risking your work, and the rest still runs.
        </p>
      {/if}
    {/if}

    <div>
      <button class:primary={install?.stale} onclick={runUpdate} disabled={job?.state === "running"}>
        {install?.stale ? "Update to the newer version" : "Pull and update"}
      </button>
    </div>
  </div>
</div>

<div class="card" style="margin-top:1.25rem">
  <h2>Projects</h2>
  <p class="tiny muted">
    Projects are set up on their own, because that means choosing where one lives and putting
    repositories into it.
  </p>
  <div class="row">
    <a class="btn" href="/setup/project?new">Start a new project</a>
    <a class="btn" href="/setup/project">Add an existing one</a>
  </div>
</div>

<style>
  .opt { display: flex; gap: .7rem; align-items: flex-start; cursor: pointer; }
  .opt input { margin-top: .3rem; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; align-items: start; }
  dl.facts { margin: 0; display: flex; flex-direction: column; gap: .45rem; }
  dl.facts div { display: flex; gap: .6rem; justify-content: space-between; align-items: baseline; }
  dl.facts dt { color: var(--ink-faint); font-size: .78rem; flex: none; }
  dl.facts dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  .edge-warn { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .edge-bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .warn-text { color: var(--warn); }
  @media (max-width: 860px) { .two { grid-template-columns: 1fr; } }
</style>
