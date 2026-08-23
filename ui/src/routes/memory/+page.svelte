<script>
  import { get } from "$lib/api.js";

  let data = $state(null);
  let q = $state("");
  let searching = $state(false);

  async function load() {
    searching = true;
    data = await get("/memory", q ? { q } : undefined);
    searching = false;
  }
  $effect(() => { if (!data) load(); });

  const kindClass = (k) =>
    k === "constraint" ? "warn" : k === "decision" ? "good" : "";
</script>

<header class="page">
  <h1>Memory</h1>
  <div class="sub">
    What survives between sessions. Nothing here was written automatically — a session proposes,
    a person accepts.
  </div>
</header>

{#if data}
  {#if data.pending.length}
    <div class="card" style="margin-bottom:1.25rem">
      <div class="spread">
        <h2 style="margin:0">{data.pending.length} waiting for review</h2>
        <span class="tiny faint">from a finished session</span>
      </div>
      <ul class="plain" style="margin-top:.75rem">
        {#each data.pending as p}
          <li class="pend">
            <span class="pill {kindClass(p.kind)}">{p.kind}</span>
            <span>{p.content}</span>
          </li>
        {/each}
      </ul>
      <p class="tiny faint" style="margin:.75rem 0 0">
        Accept or reject them with <code>amalgam memory accept &lt;id&gt;</code> —
        accepting checks the paths they name and reports anything they may replace.
      </p>
    </div>
  {/if}

  <div class="card">
    <div class="spread" style="margin-bottom:.75rem">
      <h2 style="margin:0">{data.facts.length} fact(s)</h2>
      <form class="row" style="flex:1;max-width:340px" onsubmit={(e) => { e.preventDefault(); load(); }}>
        <input type="search" bind:value={q} placeholder="filter…" />
        <button disabled={searching}>Search</button>
      </form>
    </div>

    {#if data.facts.length === 0}
      <p class="empty">Nothing stored yet. Facts appear as sessions save them.</p>
    {:else}
      <ul class="plain">
        {#each data.facts as f}
          <li class="fact">
            <div class="row" style="gap:.4rem">
              <span class="pill {kindClass(f.kind)}">{f.kind}</span>
              {#if f.context}<span class="pill">{f.context}</span>{/if}
              {#if f.verify_state === "stale"}<span class="pill bad">stale</span>{/if}
              <span class="tiny faint mono">L1:{f.id}</span>
            </div>
            <p style="margin:.3rem 0 0">{f.content}</p>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{:else}
  <p class="faint">reading memory…</p>
{/if}

<style>
  ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .9rem; }
  .fact { border-bottom: 1px solid var(--line); padding-bottom: .9rem; }
  .fact:last-child { border-bottom: none; padding-bottom: 0; }
  .pend { display: flex; gap: .6rem; align-items: baseline; }
</style>
