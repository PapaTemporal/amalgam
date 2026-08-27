<script>
  import { get, post } from "$lib/api.js";

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

  /**
   * Reviewing, from the screen that shows what is waiting.
   *
   * This used to be a sentence telling you to open a terminal, which is why
   * two dozen proposals had piled up behind it. The queue is not the kind of
   * thing anybody goes somewhere else to clear.
   */
  let busy = $state(false);
  let outcome = $state(null);     // what accepting reported, awaiting a decision

  async function decide(kind, ids) {
    if (busy || !ids.length) return;
    busy = true;
    try {
      const r = await post(`/memory/${kind}`, { ids });
      data = { ...data, pending: r.pending };
      // Only the accepted facts with something to replace are worth stopping
      // for; a clean accept should not make anybody click again.
      outcome = kind === "accept" ? (r.saved ?? []).filter((x) => x.near?.length || x.state === "stale") : null;
      if (kind === "accept" && !outcome.length) outcome = null;
      await load();
    } catch (e) { alert(e.message); }
    busy = false;
  }

  async function replace(newId, oldIds) {
    busy = true;
    try {
      await post("/memory/supersede", { newId, oldIds });
      outcome = (outcome ?? []).filter((x) => x.fact !== newId);
      if (!outcome.length) outcome = null;
      await load();
    } catch (e) { alert(e.message); }
    busy = false;
  }
</script>

<header class="page">
  <h1>Memory</h1>
  <div class="sub">
    What survives between sessions. A fact you asked for is written straight in; what a finished
    session merely inferred waits below until you keep it.
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
            <span class="what">{p.content}</span>
            <span class="row acts">
              <button class="tiny" disabled={busy} onclick={() => decide("accept", [p.id])}>Keep</button>
              <button class="tiny ghost" disabled={busy} onclick={() => decide("reject", [p.id])}>Discard</button>
            </span>
          </li>
        {/each}
      </ul>

      <div class="spread" style="margin-top:.9rem">
        <span class="tiny faint">
          Keeping one checks the paths it names and says if it may replace something.
        </span>
        <span class="row">
          <button class="tiny" disabled={busy}
                  onclick={() => decide("accept", data.pending.map((p) => p.id))}>Keep all</button>
          <button class="tiny ghost" disabled={busy}
                  onclick={() => decide("reject", data.pending.map((p) => p.id))}>Discard all</button>
        </span>
      </div>
    </div>
  {/if}

  {#if outcome}
    <div class="card" style="margin-bottom:1.25rem">
      <div class="spread">
        <h2 style="margin:0">Kept — {outcome.length} need{outcome.length === 1 ? "s" : ""} a decision</h2>
        <button class="tiny ghost" onclick={() => (outcome = null)}>Leave them as they are</button>
      </div>
      <ul class="plain" style="margin-top:.75rem">
        {#each outcome as o}
          <li class="near">
            <div>
              <strong class="tiny mono">L1:{o.fact}</strong>
              {#if o.state === "stale"}
                <span class="pill warn">names a path that is not here</span>
              {/if}
            </div>
            {#each o.near ?? [] as n}
              <div class="spread nearrow">
                <span class="tiny muted">
                  may replace <span class="mono">L1:{n.id}</span> — {n.content}
                </span>
                <button class="tiny" disabled={busy}
                        onclick={() => replace(o.fact, [n.id])}>Retire the old one</button>
              </div>
            {/each}
          </li>
        {/each}
      </ul>
      <p class="tiny faint" style="margin:.75rem 0 0">
        Nothing is retired on its own. A score cannot tell a correction from two facts that
        happen to share words, so the choice stays here.
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
  /* The shared rule gives inputs width:100%, which in a flex row leaves no
     room for the button beside them. */
  form.row input { flex: 1; width: auto; min-width: 0; }

  .pend { display: flex; gap: .6rem; align-items: baseline; padding: .3rem 0; }
  .pend .what { flex: 1; min-width: 0; }
  .pend .acts { flex: none; opacity: .55; transition: opacity .12s; }
  .pend:hover .acts, .pend:focus-within .acts { opacity: 1; }
  .near { padding: .5rem 0; border-top: 1px solid var(--line); }
  .near:first-child { border-top: 0; }
  .nearrow { margin-top: .35rem; gap: .8rem; align-items: baseline; }
</style>
