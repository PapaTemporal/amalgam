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

  // The agent CLI is the one install that is not amalgam's own, and the one
  // without which the interface can only ever hand you a prompt to paste.
  let agent = $state(null);
  const loadAgent = () => get("/agent").then((a) => (agent = a)).catch(() => {});

  // What is missing here, whichever button somebody was about to press.
  let gaps = $state([]);
  const loadGaps = () => get("/machine/gaps").then((g) => (gaps = g.gaps)).catch(() => {});

  /**
   * The one thing amalgam does without being asked.
   *
   * A stale graph costs precision rather than correctness, so bringing one up
   * to date when a session ends is worth doing — but it is still this
   * machine's time being spent by something nobody pressed, and that should
   * be visible and refusable in the place everything else about the machine
   * lives.
   */
  let refresh = $state(null);
  const loadRefresh = () => get("/refresh").then((r) => (refresh = r)).catch(() => {});
  $effect(() => { if (!refresh) loadRefresh(); });

  async function toggleAuto() {
    try { await post("/refresh/auto", { on: !refresh.on }); } catch (e) { alert(e.message); }
    loadRefresh();
  }

  const seconds = (ms) => `${Math.round(ms / 1000)}s`;
  const minutes = (ms) => `${Math.round(ms / 60000)} minutes`;

  /**
   * Which model runs a task.
   *
   * Off by default and shown before every run, because being quietly moved to
   * a cheaper model is a thing done TO somebody rather than for them.
   */
  let route = $state(null);
  const loadRoute = () => get("/models").then((m) => (route = m)).catch(() => {});
  $effect(() => { if (!route) loadRoute(); });

  async function toggleRouting() {
    try { await post("/models", { enabled: !route.enabled }); } catch (e) { alert(e.message); }
    loadRoute();
  }

  // Not called `model`: this component already has a $state by that name, and
  // shadowing one reads badly even where it compiles.
  async function remap(tier, target) {
    try { await post("/models", { tier, model: target }); } catch (e) { alert(e.message); }
    loadRoute();
  }

  async function fixGap(gap) {
    const { jobId } = await post(gap.action.endpoint, {});
    follow(jobId, gap.action.label);
  }


  // Both reads land before anything renders. Showing the page as soon as one
  // of them arrives is why the checkboxes used to settle a second apart —
  // semantic recall ticking itself, then the local model following, which
  // reads as the page changing its mind rather than as data arriving.
  let ready = $state(false);
  async function load() {
    const [s] = await Promise.all([get("/state"), refreshInstall(), loadAgent(), loadGaps()]);
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
        // PATH may have gained the agent; the cached lookup has to be dropped
        // or it would keep saying "not installed" until a restart.
        await post("/agent/rescan", {}).catch(() => {});
        await load();   // reloads the gaps too
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

<!-- What this machine needs, whichever of the two buttons below you were
     about to press. Neither of them covers all of it: reinstalling deploys
     amalgam, updating brings new code, and neither signs an agent in, fetches
     a drawing library, or rebuilds an index that failed on an older version. -->

{#if gaps.length}
  <div class="card edge-warn" style="margin-bottom:1.25rem">
    <strong>This machine is not finished yet.</strong>
    <p class="tiny muted" style="margin:.35rem 0 .8rem;max-width:72ch">
      None of this arrives with an update or a reinstall — it lives on the machine rather than in
      the repository.
    </p>

    <div class="gaps">
      {#each gaps as gap}
        <div class="gap">
          <div class="spread">
            <div>
              <strong class="tiny">{gap.what}</strong>
              <p class="tiny muted" style="margin:.25rem 0 0;max-width:70ch">{gap.why}</p>
              {#if gap.note}<p class="tiny faint" style="margin:.25rem 0 0">{gap.note}</p>{/if}
              {#if gap.projects}
                <div class="row" style="margin-top:.4rem;flex-wrap:wrap">
                  {#each gap.projects as pr}
                    <a class="btn tiny" href={`/projects/${pr.key}`}>{pr.name}</a>
                  {/each}
                </div>
              {/if}
            </div>
            {#if gap.action}
              <button class="primary" onclick={() => fixGap(gap)} disabled={job?.state === "running"}>
                {gap.action.label}
              </button>
            {/if}
          </div>
          <code class="cmd tiny">{gap.fix}</code>
        </div>
      {/each}
    </div>
  </div>
{:else if agent?.cli}
  <div class="card" style="margin-bottom:1.25rem">
    <div class="spread">
      <div>
        <span class="label">Ready</span>
        <p class="tiny muted" style="margin:.35rem 0 0">
          Agent installed, graphs indexed and drawn, everything optional in place. Workflows run
          here and report back rather than handing you a prompt.
        </p>
      </div>
      <span class="pill good mono tiny">{agent.cli}</span>
    </div>
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

{#if route}
  <div class="card" style="margin-bottom:1.25rem">
    <div class="spread">
      <div>
        <h2 style="margin:0">Which model runs a task</h2>
        <p class="tiny muted" style="margin:.35rem 0 0;max-width:74ch">
          The local model reads what you are about to ask and says how hard it is, before any of
          it leaves the machine. A rename and a redesign do not need the same model, and sizing
          them is a classification — which is what a small local model is good at.
        </p>
      </div>
      <button class:primary={!route.enabled} onclick={toggleRouting} disabled={route.forced}>
        {route.enabled ? "Turn it off" : "Turn it on"}
      </button>
    </div>

    {#if route.forced}
      <p class="tiny faint" style="margin:.5rem 0 0">
        Held <strong>{route.enabled ? "on" : "off"}</strong> by
        <span class="mono">AMALGAM_ROUTE_MODELS</span> in this environment.
      </p>
    {/if}

    <p class="tiny faint" style="margin:.6rem 0 0">
      The choice is shown with its reason before the session starts, and one click overrides it —
      nothing is ever switched silently. Anything the local model is not sure about lands on
      <strong>{route.tiers.find((t) => t.id === route.defaultTier)?.label}</strong>, because sending
      hard work to a weak model wastes the work, while the reverse only wastes money.
    </p>

    <table style="margin-top:.7rem">
      <thead><tr><th>When</th><th>Model</th><th>Per 1M in / out</th></tr></thead>
      <tbody>
        {#each route.tiers as t}
          <tr>
            <td class="tiny">{t.note}</td>
            <td>
              <input type="text" class="mono tiny" value={route.models[t.id]}
                     onchange={(e) => remap(t.id, e.currentTarget.value)} />
              <span class="tiny faint">{t.label} · {t.context} context</span>
            </td>
            <td class="tiny faint">${t.price.in} / ${t.price.out}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <p class="tiny faint" style="margin:.6rem 0 0">
      Prices are first-party API rates, carried so one choice can be compared with another; a
      session billed against a subscription will not see them. Point a row at any model the agent
      accepts — a new one does not need a new version of amalgam.
    </p>

    <p class="tiny faint" style="margin:.4rem 0 0">
      Only models the installed agent can run. amalgam drives Claude Code, so GPT and Copilot are
      not options here: Copilot is a different CLI speaking a different protocol, and routing to
      it would be a session runtime rather than a table.
    </p>
  </div>
{/if}

{#if refresh}
  <div class="card" style="margin-bottom:1.25rem">
    <div class="spread">
      <div>
        <h2 style="margin:0">Keeping graphs current</h2>
        <p class="tiny muted" style="margin:.35rem 0 0;max-width:74ch">
          When a session ends, a graph that has fallen behind its code is rebuilt — the machine is
          idle, nobody is waiting, and the session that benefits is the next one. Only the index is
          rebuilt: drawing and clustering are what make it slow and neither changes what an agent
          can find.
        </p>
      </div>
      <button class:primary={!refresh.on} onclick={toggleAuto} disabled={refresh.forced}>
        {refresh.on ? "Turn it off" : "Turn it on"}
      </button>
    </div>

    {#if refresh.forced}
      <p class="tiny faint" style="margin:.5rem 0 0">
        Held <strong>{refresh.on ? "on" : "off"}</strong> by <span class="mono">AMALGAM_AUTO_REFRESH</span>
        in this environment, which wins over anything chosen here.
      </p>
    {/if}

    <p class="tiny faint" style="margin:.6rem 0 0">
      At most {seconds(refresh.budgetMs)} per repository, and never the same one again inside
      {minutes(refresh.cooldownMs)}. A repository amalgam has not timed here is never started on a
      guess — size predicts build cost badly, so it waits for one deliberate build to learn from.
    </p>

    {#if refresh.plan.length}
      <table style="margin-top:.7rem">
        <thead><tr><th>Repository</th><th>Last build</th><th>What happens when a session ends</th></tr></thead>
        <tbody>
          {#each refresh.plan as r}
            <tr>
              <td class="mono tiny">{r.name}</td>
              <td class="tiny faint">{r.lastBuildMs == null ? "never timed here" : seconds(r.lastBuildMs)}</td>
              <td class="tiny">
                {#if r.refresh}<span style="color:var(--good)">rebuilds</span> — {r.reason}
                {:else}<span class="faint">nothing</span> — {r.reason}{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="tiny faint" style="margin:.6rem 0 0">No projects registered yet.</p>
    {/if}
  </div>
{/if}

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
  .gaps { display: flex; flex-direction: column; gap: .8rem; }
  .gap { border-top: 1px solid var(--line); padding-top: .7rem; }
  .gap:first-child { border-top: none; padding-top: 0; }
  .gap .cmd { display: inline-block; margin-top: .4rem; background: #0a0c10;
              border: 1px solid var(--line); border-radius: 5px; padding: .2rem .45rem;
              color: #b9c2d0; }
  .btn.tiny { font-size: .74rem; padding: .2rem .5rem; }
  .when { font-size: .82rem; color: var(--ink-dim); margin: 0 0 .5rem;
          border-left: 2px solid var(--accent); padding-left: .6rem; }
  .when strong { color: var(--ink); }
  @media (max-width: 860px) { .two { grid-template-columns: 1fr; } }
</style>
