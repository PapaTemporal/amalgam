<script>
  import { get } from "$lib/api.js";
  import Modal from "$lib/Modal.svelte";

  /**
   * What you sat down to do.
   *
   * Tasks, not command names. "Work on a story" is a thing somebody knows they
   * are doing; which workflow serves it is the framework's business. Several
   * of these run the same command — the difference between fixing a bug and
   * picking up a story is what you tell it, not which machinery runs — and
   * that is not a distinction worth putting on screen.
   *
   * Picking one prefills. It does not send. What runs is a line you can read
   * and edit, because the whole point is that the interface and a terminal do
   * the same thing.
   */
  let { projectKey, onstart, disabled = false } = $props();

  let data = $state(null);
  let hat = $state(0);
  let picked = $state(null);
  let text = $state("");
  let showAll = $state(false);
  let chooser = $state(null);
  let ask = $state("");

  $effect(() => {
    if (!data && projectKey) get("/workflows", { key: projectKey }).then((d) => (data = d)).catch(() => {});
  });

  const groups = $derived(data?.tasks ?? []);
  const hasHelp = $derived(!!data?.help);
  const current = $derived(groups[hat] ?? null);

  function pick(item) {
    picked = item;
    text = item.template ? item.template.replace("{{input}}", "") : item.prefill;
  }

  function run() {
    const body = picked?.template
      ? picked.template.replace("{{input}}", text.trim() ? text : "")
      : text;
    if (!body.trim()) return;
    onstart?.(body, picked?.label ?? "Session");
    picked = null;
    text = "";
  }

  async function askHelp() {
    const q = ask.trim();
    if (!q) return;
    ask = "";
    onstart?.(`/bmad-help ${q}`, `Help: ${q.slice(0, 40)}`);
  }

  // A chooser hands its prompt over when its own copy button is pressed.
  $effect(() => {
    const onMessage = (e) => {
      if (e.data?.source !== "bmad-chooser" || !e.data.prompt) return;
      const name = chooser?.name;
      chooser = null;
      onstart?.(e.data.prompt, name ? `From ${name}` : "From a chooser");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
</script>

{#if groups.length}
  <div class="hats">
    {#each groups as g, i}
      <button class:on={hat === i} onclick={() => { hat = i; picked = null; }}>{g.hat}</button>
    {/each}
  </div>

  {#if current}
    <p class="tiny faint blurb">{current.blurb}</p>
    <div class="tasks">
      {#each current.items as item}
        <button class="task" class:on={picked?.label === item.label} onclick={() => pick(item)}>
          <span class="what">{item.label}</span>
          <span class="tiny faint why">{item.note}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if picked}
    <div class="compose">
      <div class="spread">
        <strong class="tiny">{picked.label}</strong>
        <span class="tiny faint">
          {#if picked.command}runs <span class="mono">{picked.command}</span>
          {:else}runs against this project's own tools{/if}
        </span>
      </div>

      <textarea bind:value={text} rows={picked.template ? 6 : 2}
                placeholder={picked.ask ? picked.ask : "edit before running, or run as it is"}></textarea>

      <div class="spread">
        <span class="tiny faint">
          {#if picked.ask}Fill in: {picked.ask}.{/if}
          {#if picked.next} Usually followed by <em>{picked.next}</em>.{/if}
        </span>
        <div class="row">
          <button class="ghost" onclick={() => (picked = null)}>Cancel</button>
          <button class="primary" onclick={run} disabled={disabled || !text.trim()}>Run it</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- BMAD's own help, and everything installed, kept out of the way -->
  <div class="foot">
    {#if hasHelp}
      <input type="text" bind:value={ask} placeholder="Not sure? Describe it and BMAD will say what fits"
             onkeydown={(e) => e.key === "Enter" && askHelp()} />
      <button onclick={askHelp} disabled={!ask.trim()}>Ask</button>
    {:else}
      <span class="tiny faint">
        The planning workflows are not installed here, so only the tasks that use amalgam's own
        tools are offered. Install them from the project's setup to get the rest.
      </span>
    {/if}
    {#each data?.choosers ?? [] as c}
      <button class="linky" onclick={() => (chooser = c)}>{c.title ?? c.name}</button>
    {/each}
    {#if (data?.all?.length ?? 0) > 0}
      <button class="linky" onclick={() => (showAll = true)}>All {data.all.length} workflows</button>
    {/if}
  </div>
{/if}

<Modal open={!!chooser} title={chooser?.title ?? ""} onclose={() => (chooser = null)}>
  {#if chooser}
    <p class="tiny muted" style="margin:0 0 .6rem">
      Make your choices and press its copy button — the prompt comes back here and starts a
      session. It goes to your clipboard too.
    </p>
    <iframe title={chooser.name} src={`/workflow/${projectKey}/${chooser.name}`}></iframe>
  {/if}
</Modal>

<Modal open={showAll} title="Everything installed here" onclose={() => (showAll = false)}>
  <p class="tiny muted" style="margin:0 0 .6rem">
    The workflows behind the tasks above, read from this project's skills. Worth a look if you
    are curious; picking a task is faster than picking from this.
  </p>
  <div class="list">
    {#each data?.all ?? [] as w}
      <div class="entry">
        <span class="mono tiny">{w.command}</span>
        {#if w.description}<span class="tiny faint">{w.description}</span>{/if}
      </div>
    {/each}
  </div>
</Modal>

<style>
  .hats { display: flex; gap: .3rem; flex-wrap: wrap; margin-bottom: .5rem; }
  .hats button { font-size: .82rem; padding: .3rem .65rem; }
  .hats button.on { background: var(--panel-2); color: var(--ink); border-color: var(--accent); }
  .blurb { margin: 0 0 .6rem; }

  .tasks { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: .4rem; }
  .task { display: flex; flex-direction: column; gap: .15rem; align-items: flex-start; text-align: left;
          background: none; border: 1px solid var(--line); border-radius: 8px;
          padding: .55rem .7rem; cursor: pointer; color: var(--ink-dim); }
  .task:hover { background: var(--panel-2); color: var(--ink); border-color: var(--ink-faint); }
  .task.on { border-color: var(--accent); background: var(--panel-2); color: var(--ink); }
  .task .what { font-size: .88rem; font-weight: 550; color: var(--ink); }
  .task .why { line-height: 1.4; }

  .compose { display: flex; flex-direction: column; gap: .5rem; margin-top: .9rem;
             border-top: 1px solid var(--line); padding-top: .8rem; }
  .compose textarea { width: 100%; resize: vertical; font: inherit; font-size: .85rem; }

  .foot { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
          margin-top: .9rem; border-top: 1px solid var(--line); padding-top: .7rem; }
  .foot input { flex: 1; min-width: 16rem; }
  .linky { background: none; border: none; color: var(--ink-faint); cursor: pointer; padding: 0;
           font-size: .76rem; text-decoration: underline; text-underline-offset: 3px; }
  .linky:hover { color: var(--ink); }

  iframe { width: 100%; height: min(68vh, 640px); border: 1px solid var(--line);
           border-radius: 8px; background: #fff; }
  .list { max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: .35rem; }
  .entry { display: flex; flex-direction: column; gap: .1rem; }
</style>
