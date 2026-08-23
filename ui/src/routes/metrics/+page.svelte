<script>
  import { get, tokens, relative } from "$lib/api.js";

  let data = $state(null);
  $effect(() => { if (!data) get("/stats").then((d) => (data = d)); });

  // Two different kinds of measurement, kept apart on purpose: a digest knows
  // what it consumed, a packet knows the files it stood in for, and recall
  // knows neither — so it is reported as not measurable rather than as zero.
  const measured = (r) =>
    r.tool === "digest" || r.tool === "caveman_compress"
      ? { from: r.inChars, to: r.outChars }
      : r.baseline > 0 ? { from: r.baseline, to: r.outChars } : null;

  const pct = (m) => Math.round((1 - m.to / m.from) * 100);
  const maxDay = $derived(data ? Math.max(...data.daily.map((d) => d.baseline || d.out), 1) : 1);
</script>

<header class="page">
  <h1>Metrics</h1>
  <div class="sub">Counted only where a real counterfactual exists: what a call replaced, or consumed.</div>
</header>

{#if data}
  <div class="grid" style="margin-bottom:1.5rem">
    <div class="card">
      <span class="label">Not sent to the frontier model</span>
      <div class="stat">{tokens(data.avoided).toLocaleString()}</div>
      <span class="tiny faint">tokens, measured</span>
    </div>
    <div class="card">
      <span class="label">Tool calls</span>
      <div class="stat">{data.rows.reduce((n, r) => n + r.calls, 0).toLocaleString()}</div>
      <span class="tiny faint">across {data.rows.length} tool(s)</span>
    </div>
    <div class="card">
      <span class="label">Sessions on this machine</span>
      <div class="stat">{data.sessions.length}</div>
      <span class="tiny faint">
        {#if data.sessions[0]}most recent {relative(data.sessions[0].at)}{/if}
      </span>
    </div>
  </div>

  <div class="card" style="margin-bottom:1.5rem">
    <h2>By tool</h2>
    <table>
      <thead>
        <tr><th>Tool</th><th>Calls</th><th>Returned</th><th>Replaced</th><th>Saved</th></tr>
      </thead>
      <tbody>
        {#each data.rows as r}
          {@const m = measured(r)}
          <tr>
            <td class="mono">{r.tool}</td>
            <td>{r.calls}</td>
            <td>{tokens(r.outChars).toLocaleString()} tok</td>
            <td>{m ? tokens(m.from).toLocaleString() + " tok" : "—"}</td>
            <td>
              {#if m}<span class="pill good">{pct(m)}% smaller</span>
              {:else}<span class="tiny faint">not measurable</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="tiny faint" style="margin:.75rem 0 0">
      Recall claims nothing: measuring it would mean running the alternative.
    </p>
  </div>

  {#if data.daily.length}
    <div class="card">
      <h2>Recent days</h2>
      <div class="bars">
        {#each data.daily.slice().reverse() as d}
          <div class="bar">
            <div class="fill"
                 style={`height:${Math.max(3, ((d.baseline || d.out) / maxDay) * 100)}%`}
                 title={`${d.day}: ${d.calls} calls`}></div>
            <span class="tiny faint">{d.day.slice(5)}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{:else}
  <p class="faint">reading usage…</p>
{/if}

<style>
  .bars { display: flex; align-items: flex-end; gap: .4rem; height: 130px; padding-top: .5rem; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
         align-items: center; gap: .35rem; height: 100%; }
  .fill { width: 100%; border-radius: 4px 4px 0 0; min-height: 3px;
          background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 35%, transparent)); }
</style>
