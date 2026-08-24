<script>
  import { get, post, watchJob } from "$lib/api.js";
  import Stepper from "$lib/Stepper.svelte";
  import Picker from "$lib/Picker.svelte";
  import { page } from "$app/state";

  /**
   * Setting up a project, whether or not it exists yet.
   *
   * One flow rather than two, because the difference between "new" and
   * "existing" is only what the folder already contains. A new project needs an
   * empty one and repositories put into it; an existing project needs the
   * repositories it already has. Everything after that — planning workflows,
   * graph, contracts — is identical, so it is written once.
   */
  const isNew = $derived(page.url.searchParams.get("new") !== null);

  // Opening the wizard on a folder it already knows skips the question it can
  // already answer, and lands on the step that adds repositories — which is
  // where you are going when a project exists and needs another service.
  const wanted = page.url.searchParams.get("path");

  let step = $state("folder");        // folder -> services -> running -> done
  let chosen = $state(null);
  let info = $state(null);
  let job = $state(null);
  let busy = $state(false);
  let error = $state(null);

  // adding repositories
  let cloneUrl = $state("");
  let newName = $state("");
  let adding = $state(null);

  // options for the final run
  let bmad = $state(true);

  async function inspect(dir) {
    error = null;
    info = await get("/project/inspect", { path: dir });
    chosen = info.path;
  }

  let jumped = $state(false);
  $effect(() => {
    if (wanted && !jumped) {
      jumped = true;
      inspect(wanted).then(() => { step = "services"; });
    }
  });

  async function useFolder() {
    if (isNew && info.exists && !info.empty) {
      error = `That folder already has ${info.entryCount} item(s) in it. A new project starts empty — or add it as an existing project instead.`;
      return;
    }
    busy = true;
    try {
      if (isNew) await post("/project/create", { path: chosen });
      else await post("/projects/add", { path: chosen });
      await inspect(chosen);
      step = "services";
    } catch (e) { error = e.message; }
    busy = false;
  }

  function follow(jobId, onDone) {
    job = { state: "running", steps: [] };
    watchJob(jobId, async (u) => {
      job = u;
      if (u.state === "done" || u.state === "failed") await onDone(u);
    });
  }

  async function addRepo(kind) {
    error = null;
    const body = kind === "clone"
      ? { project: chosen, url: cloneUrl.trim() }
      : { project: chosen, name: newName.trim() };
    if (kind === "clone" && !body.url) return;
    if (kind === "create" && !body.name) return;
    try {
      const { jobId } = await post("/service/add", body);
      adding = kind;
      follow(jobId, async () => {
        adding = null;
        cloneUrl = "";
        newName = "";
        await inspect(chosen);
        job = null;
      });
    } catch (e) { error = e.message; }
  }

  async function finish() {
    step = "running";
    const { jobId } = await post("/setup/project", { path: chosen, bmad, git: false });
    follow(jobId, async () => { step = "done"; await inspect(chosen); });
  }

  const projectKey = $derived(info?.registered || step === "done" ? info?.path : null);
</script>

<header class="page">
  <h1>{isNew ? "New project" : "Add a project"}</h1>
  <div class="sub">
    A project is a workspace: it holds the repositories you work on together.
    {#if isNew}It starts empty, and you put repositories into it.{/if}
  </div>
</header>

{#if error}
  <div class="card err" style="margin-bottom:1rem">
    <strong>{error}</strong>
    {#if isNew && info && !info.empty}
      <p class="tiny muted" style="margin:.4rem 0 0">
        <a href="/setup/project">Add it as an existing project</a> instead — that works with whatever is already there.
      </p>
    {/if}
  </div>
{/if}

<!-- 1. where it lives ---------------------------------------------------- -->
{#if step === "folder"}
  <div class="card stack">
    <div>
      <h2>{isNew ? "Where should it live?" : "Which folder?"}</h2>
      <p class="tiny muted">
        {#if isNew}
          Pick an empty folder, or type a name to create one inside the folder you are browsing.
        {:else}
          Pick the folder that holds your repositories.
        {/if}
      </p>
    </div>

    <Picker onpick={(p) => inspect(p)} />

    {#if info}
      <div class="chosen">
        <div class="spread">
          <span class="mono tiny">{info.path}</span>
          <button class="primary" onclick={useFolder} disabled={busy}>
            {busy ? "…" : isNew ? "Create project here" : "Use this folder"}
          </button>
        </div>
        <p class="tiny faint" style="margin:.4rem 0 0">
          {#if !info.exists}Does not exist yet — it will be created.
          {:else if info.empty}Empty. Good place for a new project.
          {:else if info.services.length}Holds {info.services.length} repositor{info.services.length === 1 ? "y" : "ies"}: {info.services.map((s) => s.name).join(", ")}
          {:else if info.isRepo}This is itself a repository, not a folder of them. It can still be a project with one service.
          {:else}Holds {info.entryCount} item(s), none of them repositories.{/if}
        </p>
      </div>

      {#if isNew}
        <label class="sub-name">
          <span class="tiny faint">or create a new folder inside it</span>
          <div class="row">
            <input type="text" bind:value={newName} placeholder="my-project" />
            <button onclick={() => inspect(`${info.path}/${newName.trim()}`)} disabled={!newName.trim()}>Use that name</button>
          </div>
        </label>
      {/if}
    {/if}
  </div>
{/if}

<!-- 2. what is in it ------------------------------------------------------ -->
{#if step === "services"}
  <div class="card stack" style="margin-bottom:1.25rem">
    <div class="spread">
      <div>
        <h2 style="margin:0">Repositories</h2>
        <p class="tiny muted" style="margin:.3rem 0 0">{info.path}</p>
      </div>
      <span class="pill">{info.services.length} service(s)</span>
    </div>

    {#if info.services.length}
      <ul class="plain">
        {#each info.services as svc}
          <li class="spread"><span class="mono">{svc.name}</span><span class="pill good">ready</span></li>
        {/each}
      </ul>
    {:else}
      <p class="tiny faint">Nothing here yet. Clone a repository, or create an empty one to start writing in.</p>
    {/if}

    {#if job}
      <Stepper steps={job.steps} state={job.state} error={job.error} />
    {:else}
      <div class="add">
        <div class="stack">
          <span class="label">Clone one you already have</span>
          <div class="row">
            <input type="text" bind:value={cloneUrl} placeholder="https://github.com/you/service.git" />
            <button onclick={() => addRepo("clone")} disabled={!cloneUrl.trim() || adding}>Clone</button>
          </div>
          <span class="tiny faint">Reaches your git remote — the only thing here that uses the network.</span>
        </div>
        <div class="stack">
          <span class="label">Or start an empty one</span>
          <div class="row">
            <input type="text" bind:value={newName} placeholder="api-server" />
            <button onclick={() => addRepo("create")} disabled={!newName.trim() || adding}>Create</button>
          </div>
          <span class="tiny faint">Creates the folder and runs git init.</span>
        </div>
      </div>
    {/if}
  </div>

  <div class="card stack">
    <div>
      <h2>Then set it up</h2>
      <p class="tiny muted">
        Installs the planning workflows, wires amalgam in, builds a code graph for every
        repository, and works out the links between them.
      </p>
    </div>
    <label class="opt">
      <input type="checkbox" bind:checked={bmad} />
      <span><strong>Install BMAD workflows</strong>
        <br /><span class="tiny muted">Planning, story and build workflows, installed at the project level.</span></span>
    </label>
    <div class="row">
      <button class="primary" onclick={finish} disabled={!!adding}>
        {info.services.length ? "Set up this project" : "Set up anyway"}
      </button>
      {#if !info.services.length}
        <span class="tiny faint">With no repositories there is nothing to graph yet — you can add them later.</span>
      {/if}
    </div>
  </div>
{/if}

<!-- 3. doing it ----------------------------------------------------------- -->
{#if step === "running" || step === "done"}
  <div class="card">
    <h2>{job?.title ?? "Setting up"}</h2>
    <Stepper steps={job?.steps ?? []} state={job?.state ?? "running"} error={job?.error} />
    {#if step === "done"}
      <div class="row" style="margin-top:.5rem">
        <a class="btn primary" href="/">Open the project</a>
        <button class="ghost" onclick={() => { step = "services"; job = null; }}>Add more repositories</button>
      </div>
      <p class="tiny faint" style="margin-top:.75rem">
        Restart any open agent session — it is still using the tool list it started with.
      </p>
    {/if}
  </div>
{/if}

<style>
  .chosen { border-top: 1px solid var(--line); padding-top: .75rem; }
  .add { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  .add .row { align-items: stretch; }
  .opt { display: flex; gap: .7rem; align-items: flex-start; cursor: pointer; }
  .opt input { margin-top: .3rem; }
  .err { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
  .sub-name { display: flex; flex-direction: column; gap: .3rem; }
  @media (max-width: 720px) { .add { grid-template-columns: 1fr; } }
</style>
