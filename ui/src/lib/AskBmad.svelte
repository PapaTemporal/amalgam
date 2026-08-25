<script>
  import { get, post } from "$lib/api.js";
  import Modal from "$lib/Modal.svelte";

  /**
   * BMAD's own help, and the pages some of its workflows ship.
   *
   * BMAD already answers "what should I run for this?" — that is what
   * `/bmad-help` is for. Reimplementing it in a menu would be a worse copy of
   * something already installed, so this asks it instead: a box, a question,
   * and the answer arrives in a session you can keep talking to.
   *
   * The full list of workflows is here too, because somebody curious should
   * be able to see what they have. It is behind a disclosure rather than in
   * anybody's way, since knowing the names is not how you decide what to run.
   */
  let { projectKey, onstart } = $props();

  let data = $state(null);
  let question = $state("");
  let busy = $state(false);
  let showAll = $state(false);
  let chooser = $state(null);

  $effect(() => {
    if (!data && projectKey) get("/workflows", { key: projectKey }).then((d) => (data = d)).catch(() => {});
  });

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    busy = true;
    // Sent as the command you would have typed, because that is what it is.
    await onstart?.(`/bmad-help ${q}`, `Help: ${q.slice(0, 40)}`);
    question = "";
    busy = false;
  }

  async function run(command, title) {
    await onstart?.(command, title ?? command);
  }

  /**
   * A chooser hands its prompt over when it is used.
   *
   * The page still copies to the clipboard — it is unmodified — but the copy
   * served into this frame also posts the text here, so the step where a
   * person carries it between two windows the interface is already showing
   * them does not need to happen.
   */
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

  const grouped = $derived({
    bmad: (data?.all ?? []).filter((w) => w.group === "bmad"),
    amalgam: (data?.all ?? []).filter((w) => w.group !== "bmad"),
  });
</script>

{#if data?.help}
  <div class="ask">
    <div class="row">
      <input type="text" bind:value={question} placeholder="What are you trying to do? — BMAD will say which workflow fits"
             onkeydown={(e) => e.key === "Enter" && ask()} />
      <button class="primary" onclick={ask} disabled={!question.trim() || busy}>Ask</button>
    </div>
    <div class="row extras tiny">
      {#each data.choosers as c}
        <button class="linky" onclick={() => (chooser = c)}>{c.title ?? c.name}</button>
      {/each}
      <button class="linky" onclick={() => (showAll = true)}>
        All {data.all.length} workflows
      </button>
    </div>
  </div>
{/if}

<!-- the chooser, embedded rather than opened elsewhere -->
<Modal open={!!chooser} title={chooser?.title ?? chooser?.name ?? ""} onclose={() => (chooser = null)}>
  {#if chooser}
    <p class="tiny muted" style="margin:0 0 .6rem">
      Make your choices and press its copy button — the prompt comes back here and starts a
      session. It goes to your clipboard too.
    </p>
    <iframe title={chooser.name} src={`/workflow/${projectKey}/${chooser.name}`}></iframe>
  {/if}
</Modal>

<!-- everything installed, for somebody who wants to look -->
<Modal open={showAll} title="Workflows installed here" onclose={() => (showAll = false)}>
  <p class="tiny muted" style="margin:0 0 .6rem">
    Read from this project's skills, so an upgrade that adds one appears here on its own.
    Asking above is usually faster than reading the list.
  </p>
  <div class="list">
    {#each ["bmad", "amalgam"] as group}
      {#if grouped[group].length}
        <h3 class="tiny">{group === "bmad" ? "Planning and build" : "amalgam"}</h3>
        {#each grouped[group] as w}
          <button class="entry" onclick={() => { showAll = false; run(w.command, w.name); }}>
            <span class="mono">{w.command}</span>
            {#if w.description}<span class="tiny faint">{w.description}</span>{/if}
          </button>
        {/each}
      {/if}
    {/each}
  </div>
</Modal>

<style>
  .ask { display: flex; flex-direction: column; gap: .45rem; margin-top: .8rem;
         border-top: 1px solid var(--line); padding-top: .8rem; }
  .ask input { flex: 1; }
  .extras { gap: .9rem; }
  .linky { background: none; border: none; color: var(--ink-faint); cursor: pointer;
           padding: 0; font-size: .76rem; text-decoration: underline; text-underline-offset: 3px; }
  .linky:hover { color: var(--ink); }

  iframe { width: 100%; height: min(68vh, 640px); border: 1px solid var(--line);
           border-radius: 8px; background: #fff; }

  .list { max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: .1rem; }
  .list h3 { margin: .8rem 0 .2rem; color: var(--ink-faint); text-transform: uppercase;
             letter-spacing: .04em; }
  .list h3:first-child { margin-top: 0; }
  .entry { display: flex; flex-direction: column; gap: .1rem; align-items: flex-start;
           background: none; border: none; text-align: left; cursor: pointer;
           padding: .4rem .5rem; border-radius: 6px; color: var(--ink-dim); width: 100%; }
  .entry:hover { background: var(--panel-2); color: var(--ink); }
  .entry .mono { font-size: .82rem; }
</style>
