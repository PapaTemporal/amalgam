<script>
  import { get } from "$lib/api.js";
  import { page } from "$app/state";
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
   *
   * Which task is picked lives in the URL, so a prompt can be sent to somebody
   * rather than described to them: ?task=fix-a-bug opens this page with that
   * one already composed. The name in the link is the label somebody would
   * say out loud, not an internal id, because the link is read by people.
   */
  let { projectKey, onstart, oncompose = null, routed = null, tiers = null,
        onretier = null, disabled = false } = $props();

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

  /**
   * Who is sitting down.
   *
   * A hat is what you are doing this hour; a role is what you are doing this
   * job, so it is remembered per person rather than per project and it orders
   * the menu instead of cutting it down. Everything stays reachable — the
   * person who most needs a task outside their role is the one who has just
   * been handed it.
   */
  const ROLE_KEY = "amalgam.role";
  let role = $state(null);
  $effect(() => {
    if (role !== null || typeof localStorage === "undefined") return;
    // A link may say who is reading — "here is what this looks like from
    // where I sit" — and if it does, it wins and then sticks, because being
    // shown a view you cannot get back to is worse than not being shown it.
    const said = page.url.searchParams.get("you");
    if (said) { role = said; try { localStorage.setItem(ROLE_KEY, said); } catch { /* private mode */ } return; }
    role = localStorage.getItem(ROLE_KEY) ?? "";
  });

  const allRoles = $derived(data?.roles ?? []);
  const mine = $derived(allRoles.find((r) => r.label === role) ?? null);

  function beRole(label) {
    role = role === label ? "" : label;
    hat = 0;
    picked = null;
    remember(null);
    try { localStorage.setItem(ROLE_KEY, role); } catch { /* private mode */ }
  }

  // The role's own tasks ride in front of the hats as one more tab, so it is
  // an ordering and not a mode: every hat is still one click away.
  const tabs = $derived(mine ? [{ hat: mine.label, blurb: mine.note, items: mine.items, role: true }, ...groups] : groups);
  const current = $derived(tabs[hat] ?? null);

  /** "Fix a bug" -> "fix-a-bug". Stable enough to link to, readable in a URL. */
  const slug = (label) =>
    String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  function pick(item, { link = true } = {}) {
    picked = item;
    text = item.template ? item.template.replace("{{input}}", "") : item.prefill;
    if (link) remember(slug(item.label));
    // Sized on what is actually composed, including the label — "Fix a bug"
    // carries information the bare command does not.
    oncompose?.(`${item.label}. ${text}`);
  }

  /** Keep the address bar honest without adding a history entry per click. */
  function remember(value) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("task", value);
    else url.searchParams.delete("task");
    history.replaceState({}, "", url);
  }

  // A link that names a task opens with it composed. Runs once the catalogue
  // has arrived, since until then there is nothing to match against, and it
  // does not re-link: the URL already says this.
  let linked = $state(false);
  $effect(() => {
    if (linked || !groups.length) return;
    linked = true;
    const want = page.url.searchParams.get("task");
    if (!want) return;
    for (const [i, g] of tabs.entries()) {
      const item = g.items.find((it) => slug(it.label) === want);
      if (item) { hat = i; pick(item, { link: false }); return; }
    }
  });

  function run() {
    const body = picked?.template
      ? picked.template.replace("{{input}}", text.trim() ? text : "")
      : text;
    if (!body.trim()) return;
    onstart?.(body, picked?.label ?? "Session");
    picked = null;
    text = "";
    remember(null);
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
  {#if allRoles.length}
    <div class="roles">
      <span class="tiny faint">you are</span>
      {#each allRoles as r}
        <button class="chip" class:on={role === r.label} title={r.note} onclick={() => beRole(r.label)}>{r.label}</button>
      {/each}
      {#if role}
        <button class="linky tiny" onclick={() => beRole(role)}>show everything equally</button>
      {/if}
    </div>
  {/if}

  <div class="hats">
    {#each tabs as g, i}
      <button class:on={hat === i} onclick={() => { hat = i; picked = null; remember(null); }}>{g.hat}</button>
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

    {#if current.role && mine?.talkTo?.length}
      <div class="specialists">
        <span class="tiny faint">or think it through with</span>
        {#each mine.talkTo as t}
          <button class="chip" class:on={picked?.label === t.label} title={t.note} onclick={() => pick(t)}>
            {t.label.replace(/^Talk to the /, "")}
          </button>
        {/each}
      </div>
    {/if}
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
                onblur={() => oncompose?.(`${picked.label}. ${text}`)}
                placeholder={picked.ask ? picked.ask : "edit before running, or run as it is"}></textarea>

      {#if routed}
        <div class="routed">
          <span class="tiny faint">runs on</span>
          <strong class="tiny">{routed.label}</strong>
          <span class="tiny faint">— {routed.why} ({routed.by})</span>
          {#if tiers}
            <span class="spacer"></span>
            {#each tiers as t}
              {#if t.id !== routed.tier}
                <button class="linky tiny" title={t.note}
                        onclick={() => onretier?.(t.id)}>use {t.label}</button>
              {/if}
            {/each}
          {/if}
        </div>
      {/if}

      <div class="spread">
        <span class="tiny faint">
          {#if picked.ask}Fill in: {picked.ask}.{/if}
          {#if picked.next} Usually followed by <em>{picked.next}</em>.{/if}
        </span>
        <div class="row">
          <button class="ghost" onclick={() => { picked = null; remember(null); }}>Cancel</button>
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

  .routed { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-top: .4rem; }
  .routed .spacer { flex: 1; min-width: .5rem; }

  .roles { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .specialists { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-top: .7rem; }
  .chip {
    font-size: .78rem; padding: .2rem .55rem; border-radius: 999px;
    border: 1px solid var(--line); background: transparent; color: var(--ink-dim);
  }
  .chip.on { border-color: var(--accent); color: var(--ink); }

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
