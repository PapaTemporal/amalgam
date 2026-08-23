<script>
  import { get } from "./api.js";

  /**
   * A directory chooser that returns real paths.
   *
   * A browser file input cannot give a usable absolute path, and typing one by
   * hand is where setup wizards lose people. The server is on this machine, so
   * it can simply list directories — and it marks which are already git
   * repositories or already have BMAD, which is usually the thing being
   * looked for.
   */
  let { onpick } = $props();

  let cwd = $state(null);
  let listing = $state({ entries: [], parent: null, path: "" });
  let loading = $state(true);
  let error = $state(null);

  async function load(p) {
    loading = true;
    error = null;
    try {
      listing = await get("/browse", p ? { path: p } : undefined);
      cwd = listing.path;
    } catch (e) { error = e.message; }
    loading = false;
  }

  $effect(() => { if (cwd === null) load(null); });
</script>

<div class="picker">
  <div class="spread head">
    <span class="mono tiny">{listing.path}</span>
    <div class="row">
      {#if listing.parent}
        <button class="ghost" onclick={() => load(listing.parent)}>↑ up</button>
      {/if}
      <button class="primary" onclick={() => onpick(listing.path)}>Use this folder</button>
    </div>
  </div>

  {#if error}
    <p class="tiny" style="color:var(--bad)">{error}</p>
  {:else if loading}
    <p class="tiny faint">reading…</p>
  {:else if listing.entries.length === 0}
    <p class="tiny faint">No sub-folders here. “Use this folder” selects it.</p>
  {:else}
    <ul>
      {#each listing.entries as e}
        <li>
          <button class="ghost entry" onclick={() => load(e.path)}>
            <span>{e.name}</span>
            <span class="row">
              {#if e.hasBmad}<span class="pill good">bmad</span>{/if}
              {#if e.isRepo}<span class="pill">git</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .picker { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
  .head { padding: .6rem .75rem; border-bottom: 1px solid var(--line); }
  ul { list-style: none; margin: 0; padding: .35rem; max-height: 300px; overflow-y: auto; }
  .entry { display: flex; justify-content: space-between; align-items: center; width: 100%;
           border: none; background: none; padding: .35rem .5rem; border-radius: 6px; }
  .entry:hover { background: var(--panel-2); }
</style>
