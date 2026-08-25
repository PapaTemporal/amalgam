<script>
  import { get, post, watchJob } from "$lib/api.js";
  import Stepper from "$lib/Stepper.svelte";
  import { page } from "$app/state";
  import { install, refreshInstall } from "$lib/install.svelte.js";

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
  let job = $state(null);
  let jobTitle = $state("");

  let embeddings = $state(true);
  let model = $state(false);

  // Both reads land before anything renders. Showing the page as soon as one
  // of them arrives is why the checkboxes used to settle a second apart —
  // semantic recall ticking itself, then the local model following, which
  // reads as the page changing its mind rather than as data arriving.
  let ready = $state(false);
  async function load() {
    const [s] = await Promise.all([get("/state"), refreshInstall()]);
    state = s;
    model = s.model;
    embeddings = s.embeddings || embeddings;
    ready = true;
  }
  $effect(() => { if (!state) load(); });

  // What the page shows about the install comes from the store the sidebar
  // chip reads, so the two can never disagree.
  const info = $derived(install.data);

  /**
   * An update replaces the code this page was served from.
   *
   * Re-reading /install fixes the numbers, but the JavaScript running the page
   * is still the old build — and the built pages ship in the repository, so an
   * update usually changes them. Reloading is the only honest end to it. The
   * job id is already in the URL, so the finished steps are still on screen
   * afterwards.
   */
  let reloading = $state(false);
  function reloadAfterUpdate() {
    reloading = true;
    setTimeout(() => location.reload(), 900);
  }

  function follow(jobId, title) {
    jobTitle = title;
    job = { state: "running", steps: [] };
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done") {
        state = null;
        await load();
        if (isUpdate(u)) reloadAfterUpdate();
      }
    });
    // In the URL so a refresh — or a second window — keeps watching rather
    // than losing a job that is still running.
    const url = new URL(window.location.href);
    url.searchParams.set("job", jobId);
    history.replaceState({}, "", url);
  }

  async function runInstall() {
    const { jobId } = await post("/setup/machine", { embeddings, model });
    follow(jobId, info?.installed ? "Reinstalling amalgam" : "Setting up amalgam");
  }

  async function runUpdate() {
    const { jobId } = await post("/update", {});
    follow(jobId, "Updating amalgam");
  }

  // Arriving with a job already in the URL means this page is watching
  // something a previous page instance started — after an update, that is the
  // reload itself, which changes what there is left to say about it.
  let resumed = $state(false);
  let followed = $state(false);
  $effect(() => {
    const existing = page.url.searchParams.get("job");
    if (existing && !followed) { followed = true; resumed = true; follow(existing, "Running"); }
  });

  const done = $derived(job?.state === "done");
  const isUpdate = (j) => (j?.title ?? jobTitle) === "Updating amalgam";
  const updated = $derived(done && isUpdate(job));
</script>

<header class="page">
  <div class="spread">
    <div>
      <h1>This machine</h1>
      <div class="sub">Everything here is a command you could type. It is shown as it runs.</div>
    </div>
    {#if info}
      <span class="pill {info.installed ? 'good' : 'warn'}">
        {info.installed ? `v${info.version}${info.sourceCommit ? ` · ${info.sourceCommit}` : ""}` : "not installed"}
      </span>
    {/if}
  </div>
</header>

{#if !ready}
  <div class="card"><p class="tiny faint" style="margin:0">reading what is installed…</p></div>
{:else}

{#if info && !info.installed}
  <div class="card edge-warn" style="margin-bottom:1.25rem">
    <strong>amalgam is not deployed on this machine.</strong>
    <p class="tiny muted" style="margin:.4rem 0 0">
      The pages load from the clone either way, but the parts agents use — the MCP server, the
      skills, the hooks — live in <span class="mono">{info.home}</span> and are not there yet.
      Install below.
    </p>
  </div>
{:else if info?.stale}
  <div class="card edge-warn" style="margin-bottom:1.25rem">
    <strong>There is a newer version in your clone than the one deployed.</strong>
    <p class="tiny muted" style="margin:.4rem 0 0">
      Deployed <span class="mono">{info.deployedCommit}</span>,
      clone is at <span class="mono">{info.sourceCommit}</span>. Update to deploy it.
    </p>
  </div>
{/if}

{#if job}
  <div class="card {job.state === 'failed' ? 'edge-bad' : ''}" style="margin-bottom:1.25rem">
    <h2>{job.title ?? jobTitle}</h2>
    <Stepper steps={job.steps} status={job.state} error={job.error} />
    {#if done}
      <div class="row" style="margin-top:.5rem">
        <a class="btn primary" href="/">Back to projects</a>
        {#if updated && !resumed}
          <button onclick={() => location.reload()}>Reload now</button>
        {/if}
        <button class="ghost" onclick={() => (job = null)}>Run something else</button>
      </div>
      <p class="tiny faint" style="margin-top:.75rem">
        Restart any open agent session — it is still using the tool list it started with.
        {#if updated}
          {#if resumed}
            These pages were reloaded, so what you are looking at is the new version.
          {:else if reloading}
            These pages came from the version you just replaced, so they are reloading.
          {:else}
            These pages came from the version you just replaced — reload them too.
          {/if}
        {/if}
      </p>
    {/if}
  </div>
{/if}

<div class="two">
  <!-- installing, or installing again ------------------------------------- -->
  <div class="card stack">
    <div>
      <h2>{info?.installed ? "Reinstall" : "Install and wire"}</h2>
      {#if info?.installed}
        <p class="when"><strong>Use this when</strong> something is behaving as though it is not
          installed — a missing MCP tool, a skill that never loads, an <code>amalgam</code> command
          the shell cannot find — or when you want to add one of the optional downloads below.
          Not for picking up new code: that is Update.</p>
      {:else}
        <p class="when"><strong>Start here.</strong> Nothing else works until this has run once.</p>
      {/if}
      <p class="tiny muted">
        Copies amalgam into your home directory, registers it for every project on this machine,
        and puts <code>amalgam</code> on your PATH. Nothing is installed system-wide and nothing
        runs as a service.
        {#if info?.installed}
          Running it again overwrites the deployed copy — safe, and the way to repair one that
          has drifted. Your memory database and your projects are untouched.
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
        {info?.installed ? "Reinstall over the top" : "Start setup"}
      </button>
    </div>
  </div>

  <!-- updating ------------------------------------------------------------- -->
  <div class="card stack">
    <div>
      <h2>Update</h2>
      <p class="when">
        <strong>Use this when</strong>
        {#if info?.stale}
          the chip says an update is ready — as it does now. Your clone has moved past what is
          deployed, and until this runs, the agent is still using the old code.
        {:else}
          you want the latest release, or after pulling this repository by hand. It is the only
          thing that makes new code actually take effect.
        {/if}
      </p>
      <p class="tiny muted">
        Pulls the latest source, re-deploys it, and refreshes the wiring in every project that
        was wired. The built pages are part of the repository, so this updates the UI as well —
        which is why it can live here rather than in a terminal.
      </p>
    </div>

    {#if info}
      <dl class="facts">
        <div><dt>Source</dt><dd class="mono tiny">{info.source}</dd></div>
        <div><dt>Deployed to</dt><dd class="mono tiny">{info.home}</dd></div>
        <div><dt>Wired</dt><dd class="tiny">
          {info.wiredUser ? "every project on this machine" : "not at machine level"}{info.wiredProjects ? `, ${info.wiredProjects} named project(s)` : ""}
        </dd></div>
        {#if info.installedAt}
          <div><dt>Last deployed</dt><dd class="tiny">{new Date(info.installedAt).toLocaleString()}</dd></div>
        {/if}
      </dl>

      {#if !info.isClone}
        <p class="tiny warn-text">
          This copy is not a git clone, so there is nothing to pull. Update will still re-deploy
          and re-wire what is here.
        </p>
      {:else if info.dirty}
        <p class="tiny warn-text">
          {info.dirty} uncommitted change(s) in the clone — the pull is skipped rather than
          risking your work, and the rest still runs.
        </p>
      {/if}
    {/if}

    <div>
      <button class:primary={info?.stale} onclick={runUpdate} disabled={job?.state === "running"}>
        {info?.stale ? "Update to the newer version" : "Pull and update"}
      </button>
    </div>
  </div>
</div>

{/if}

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
  .when { font-size: .82rem; color: var(--ink-dim); margin: 0 0 .5rem;
          border-left: 2px solid var(--accent); padding-left: .6rem; }
  .when strong { color: var(--ink); }
  @media (max-width: 860px) { .two { grid-template-columns: 1fr; } }
</style>
