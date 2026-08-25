<script>
  import { post } from "$lib/api.js";

  /**
   * The agent's work, as it happens.
   *
   * Not a terminal: a conversation with the tool calls folded into it. What
   * somebody watching wants to know is what it said, what it is doing right
   * now, and whether it is waiting on them — none of which a wall of ANSI
   * gives you. Tool calls collapse to one line each and open on click, so a
   * hundred file reads do not bury the sentence that matters.
   *
   * The raw protocol is one toggle away, because when this misreads something
   * the only honest answer is the output itself.
   */
  let { id, onended } = $props();

  let s = $state(null);
  let reply = $state("");
  let showRaw = $state(false);
  let openTools = $state(new Set());
  let sending = $state(false);

  $effect(() => {
    if (!id) return;
    const source = new EventSource(`/api/sessions/${id}/stream`);
    source.onmessage = (e) => {
      s = JSON.parse(e.data);
      if (s.state !== "running") onended?.(s);
    };
    source.onerror = () => source.close();
    return () => source.close();
  });

  async function sendReply() {
    const text = reply.trim();
    if (!text || sending) return;
    sending = true;
    reply = "";
    try { await post("/session/send", { id, text }); } catch (e) { reply = text; alert(e.message); }
    sending = false;
  }

  function onKey(e) {
    // Enter sends, Shift+Enter makes a paragraph — the convention everywhere
    // else you type at something that answers back.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(); }
  }

  const toggle = (i) => {
    const next = new Set(openTools);
    next.has(i) ? next.delete(i) : next.add(i);
    openTools = next;
  };

  /** Keep the newest turn in view unless the reader has scrolled up. */
  function follow(node) {
    const near = () => node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    let stick = true;
    const onScroll = () => { stick = near(); };
    node.addEventListener("scroll", onScroll);
    const observer = new MutationObserver(() => { if (stick) node.scrollTop = node.scrollHeight; });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return { destroy: () => { observer.disconnect(); node.removeEventListener("scroll", onScroll); } };
  }
</script>

{#if !s}
  <p class="tiny faint">starting the agent…</p>
{:else}
  <div class="session">
    <div class="bar">
      <span class="dot {s.state === 'running' ? (s.busy ? 'live' : 'idle') : s.state === 'failed' ? 'bad' : 'done'}"></span>
      <strong class="tiny">
        {#if s.state === "failed"}Failed
        {:else if s.state !== "running"}Finished
        {:else if s.busy}Working…
        {:else}Waiting for you{/if}
      </strong>
      <span class="tiny faint">{s.permissionMode} · {s.turns.length} turn(s)</span>
      <div class="grow"></div>
      {#if s.cost != null}<span class="tiny faint">${s.cost.toFixed(3)}</span>{/if}
      <button class="quiet" onclick={() => (showRaw = !showRaw)}>{showRaw ? "Hide protocol" : "Protocol"}</button>
      {#if s.state === "running"}
        <button class="quiet" onclick={() => post("/session/stop", { id })}>Stop</button>
      {/if}
    </div>

    {#if s.error}<p class="err tiny">{s.error}</p>{/if}

    <div class="log" use:follow>
      {#each s.turns as turn, i}
        {#if turn.role === "user"}
          <div class="turn you"><div class="who tiny">you</div><div class="what">{turn.text}</div></div>
        {:else if turn.role === "assistant"}
          <div class="turn agent"><div class="who tiny">agent</div><div class="what prose">{turn.text}</div></div>
        {:else if turn.role === "notice"}
          <div class="notice tiny">{turn.text}</div>
        {:else}
          <button class="tool {turn.state}" onclick={() => toggle(i)} aria-expanded={openTools.has(i)}>
            <span class="mark"></span>
            <span class="name">{turn.name}</span>
            <span class="arg mono tiny">{turn.input}</span>
          </button>
          {#if openTools.has(i) && turn.result}
            <pre class="tool-out">{turn.result}</pre>
          {/if}
        {/if}
      {/each}

      {#if s.busy}
        <div class="turn agent"><div class="who tiny">agent</div>
          <div class="typing"><span></span><span></span><span></span></div>
        </div>
      {/if}
    </div>

    {#if showRaw}
      <pre class="raw">{s.raw.join("\n")}</pre>
    {/if}

    {#if s.state === "running"}
      <div class="composer">
        <textarea bind:value={reply} onkeydown={onKey} rows="2"
                  placeholder={s.busy ? "It is working — you can queue the next thing" : "Answer, or ask for the next thing…"}></textarea>
        <button class="primary" onclick={sendReply} disabled={!reply.trim() || sending}>Send</button>
      </div>
      <p class="tiny faint" style="margin:.35rem 0 0">Enter sends · Shift+Enter for a new line</p>
    {/if}
  </div>
{/if}

<style>
  .session { display: flex; flex-direction: column; gap: .6rem; }
  .bar { display: flex; align-items: center; gap: .5rem; }
  .grow { flex: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-faint); flex: none; }
  .dot.live { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  .dot.idle { background: var(--warn); }
  .dot.done { background: var(--good); }
  .dot.bad { background: var(--bad); }
  @keyframes pulse { 50% { opacity: .3; transform: scale(.8); } }
  .quiet { background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--ink-faint);
           font-size: .74rem; padding: .2rem .5rem; cursor: pointer; }
  .quiet:hover { color: var(--ink); border-color: var(--ink-faint); }

  .log { max-height: 30rem; overflow-y: auto; display: flex; flex-direction: column; gap: .55rem;
         border: 1px solid var(--line); border-radius: 8px; padding: .8rem; background: var(--panel-2); }

  .turn { display: flex; gap: .7rem; align-items: flex-start; }
  .who { flex: none; width: 3.2rem; color: var(--ink-faint); text-transform: uppercase;
         letter-spacing: .04em; padding-top: .15rem; }
  .what { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .88rem; }
  .turn.you .what { color: var(--ink); }
  .turn.agent .what { color: var(--ink-dim); }

  /* One line per tool call, opening to its result. A hundred file reads
     should not bury the sentence that matters. */
  .tool { display: flex; align-items: baseline; gap: .5rem; width: 100%; text-align: left;
          background: none; border: none; padding: .15rem .3rem; border-radius: 4px; cursor: pointer; }
  .tool:hover { background: var(--panel); }
  .tool .mark { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--ink-faint); }
  .tool.running .mark { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  .tool.done .mark { background: var(--good); }
  .tool.failed .mark { background: var(--bad); }
  .tool .name { font-size: .78rem; color: var(--ink-dim); flex: none; }
  .tool .arg { color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-out { margin: 0 0 .3rem 1.2rem; max-height: 12rem; overflow: auto; font-size: .72rem;
              background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .5rem; }

  .notice { color: var(--warn); }
  .err { color: var(--bad); }

  .typing { display: flex; gap: .25rem; padding-top: .4rem; }
  .typing span { width: 5px; height: 5px; border-radius: 50%; background: var(--ink-faint);
                 animation: blink 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: .2s; }
  .typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 60%, 100% { opacity: .2; } 30% { opacity: 1; } }

  .raw { max-height: 14rem; overflow: auto; background: #0a0c10; border: 1px solid var(--line);
         border-radius: 6px; padding: .6rem; font-size: .68rem; white-space: pre; color: #b9c2d0; margin: 0; }

  .composer { display: flex; gap: .5rem; align-items: flex-end; }
  .composer textarea { flex: 1; resize: vertical; font: inherit; font-size: .88rem; }
</style>
