<script>
  import { get, post } from "$lib/api.js";
  import { bytes } from "$lib/api.js";

  /**
   * Removing a project, with the consequences on screen.
   *
   * "Delete project" means different things to different people, and the
   * expensive misunderstanding only runs one way — nobody is upset that a code
   * graph survived. So the default removes the list entry and nothing else,
   * every extra is opt-in and named with its size, and the one sentence that
   * never moves is that repositories are never touched.
   */
  let { projectKey, name, ondone, oncancel } = $props();

  let detail = $state(null);
  let busy = $state(false);
  let error = $state(null);

  let graph = $state(false);
  let bmad = $state(false);
  let wiring = $state(false);
  let tasks = $state(false);

  $effect(() => {
    if (!detail) get("/projects/removable", { key: projectKey }).then((d) => (detail = d)).catch((e) => (error = e.message));
  });

  async function confirm() {
    busy = true;
    try {
      const res = await post("/projects/remove", { key: projectKey, also: { graph, bmad, wiring, tasks } });
      ondone(res);
    } catch (e) { error = e.message; busy = false; }
  }

  const anything = $derived(graph || bmad || wiring || tasks);
</script>

<div class="remove">
  {#if error}
    <p class="tiny" style="color:var(--bad)">{error}</p>
  {:else if !detail}
    <p class="tiny faint">checking what is here…</p>
  {:else}
    <p class="tiny muted">
      It comes off your project list. Your repositories — {detail.services.length
        ? detail.services.join(", ")
        : "everything under this folder"} — are never touched, whatever you tick below.
    </p>

    <div class="opts">
      <label class="opt" class:disabled={!detail.graph.dirs.length && !detail.graph.indexed}>
        <input type="checkbox" bind:checked={graph} disabled={!detail.graph.dirs.length && !detail.graph.indexed} />
        <span>
          <strong>Also delete the code graph</strong>
          <br /><span class="tiny muted">
            {#if detail.graph.dirs.length || detail.graph.indexed}
              {detail.graph.dirs.length} graphify-out folder(s){detail.graph.bytes ? `, ${bytes(detail.graph.bytes)}` : ""},
              {detail.graph.indexed} indexed repositor{detail.graph.indexed === 1 ? "y" : "ies"}, and the contracts between them. Rebuildable.
            {:else}nothing built yet{/if}
          </span>
        </span>
      </label>

      <label class="opt" class:disabled={!detail.bmad.dirs.length}>
        <input type="checkbox" bind:checked={bmad} disabled={!detail.bmad.dirs.length} />
        <span>
          <strong>Also delete the planning workflows and their output</strong>
          <br /><span class="tiny muted">
            {#if detail.bmad.dirs.length}
              {detail.bmad.dirs.join(", ")}{detail.bmad.bytes ? ` · ${bytes(detail.bmad.bytes)}` : ""} —
              this includes written PRDs, specs and stories.
            {:else}none installed{/if}
          </span>
        </span>
      </label>

      <label class="opt" class:disabled={!detail.wiring.files.length}>
        <input type="checkbox" bind:checked={wiring} disabled={!detail.wiring.files.length} />
        <span>
          <strong>Also remove the agent wiring</strong>
          <br /><span class="tiny muted">
            {detail.wiring.files.length ? detail.wiring.files.join(", ") : "not wired"}
          </span>
        </span>
      </label>

      <label class="opt" class:disabled={!detail.tasks}>
        <input type="checkbox" bind:checked={tasks} disabled={!detail.tasks} />
        <span>
          <strong>Also delete work items</strong>
          <br /><span class="tiny muted">
            {#if detail.tasks}
              {detail.tasks} item(s) and their history — the decisions and blockers recorded
              against this project.
            {:else}none recorded{/if}
          </span>
        </span>
      </label>
    </div>

    <div class="row actions">
      <button class="ghost" onclick={oncancel} disabled={busy}>Cancel</button>
      <button class="danger primary" onclick={confirm} disabled={busy}>
        {busy ? "Removing…" : anything ? "Remove and delete the ticked items" : "Remove from list only"}
      </button>
    </div>
  {/if}
</div>

<style>
  /* Cancel first, then the destructive action on the right, where the eye
     lands last and the hand has to travel. */
  .actions { justify-content: flex-end; margin-top: .25rem; }
  .opts { display: flex; flex-direction: column; gap: .7rem; margin: 1rem 0; }
  .opt { display: flex; gap: .7rem; align-items: flex-start; cursor: pointer; }
  .opt input { margin-top: .3rem; }
  .opt.disabled { opacity: .45; cursor: default; }
  button.danger.primary { background: var(--bad); border-color: var(--bad); color: #1a0808; }
</style>
