<script>
  /**
   * What is happening, at a glance, with the detail one click away.
   *
   * The failure mode of a long job is not being wrong — it is being silent
   * long enough that you cannot tell it from a hang. So the top line always
   * moves: a track of segments that fill as steps complete, the running one
   * animated, and the newest line of output ticking past underneath. That is
   * enough to know it is alive and roughly where it is.
   *
   * The full output is right there but folded away, because a build that
   * prints two thousand lines should not push the rest of the page off the
   * screen to tell you it is working. Open it when something looks wrong;
   * a failed step opens itself.
   */
  let { steps = [], status = "running", error = null, title = null } = $props();

  let open = $state(false);
  let openedByFailure = $state(false);

  const done = $derived(steps.filter((s) => s.state === "done" || s.state === "skipped").length);
  const running = $derived(steps.find((s) => s.state === "running"));
  const failedStep = $derived(steps.find((s) => s.state === "failed"));
  const notRun = $derived(steps.filter((s) => s.state === "waiting").length);
  const pct = $derived(steps.length ? Math.round((done / steps.length) * 100) : 0);

  /** The newest line anything has printed — the pulse of a job in one line. */
  const latest = $derived.by(() => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const out = steps[i].output;
      if (out?.length) return out[out.length - 1];
    }
    return null;
  });

  const log = $derived(
    steps.flatMap((s) => (s.output?.length ? [`— ${s.label} —`, ...s.output] : [])).join("\n")
  );

  // A failure is the one time the detail is wanted without being asked for.
  $effect(() => {
    if (status === "failed" && !openedByFailure) { openedByFailure = true; open = true; }
  });

  /** Keep the tail in view: a log scrolled by hand is a log nobody reads. */
  function follow(node) {
    const stick = () => { node.scrollTop = node.scrollHeight; };
    stick();
    const observer = new MutationObserver(stick);
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    return { destroy: () => observer.disconnect() };
  }
</script>

<div class="tracker {status}">
  <!-- the track ------------------------------------------------------------ -->
  <div class="track" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"
       aria-label={title ?? "progress"}>
    {#each steps as step}
      <div class="seg {step.state}" title={step.label}>
        <span class="fill"></span>
      </div>
    {/each}
  </div>

  <!-- what it is doing right now -------------------------------------------- -->
  <div class="now">
    <div class="what">
      {#if status === "failed"}
        <span class="dot bad"></span>
        <strong>{failedStep ? `${failedStep.label} — failed` : "Failed"}</strong>
      {:else if status === "done"}
        <span class="dot good"></span>
        <strong>Done</strong>
        <span class="tiny faint">{steps.length} step{steps.length === 1 ? "" : "s"}</span>
      {:else if running}
        <span class="dot live"></span>
        <strong>{running.label}</strong>
        <span class="tiny faint">step {done + 1} of {steps.length}</span>
      {:else}
        <span class="dot"></span>
        <strong>Starting…</strong>
      {/if}
    </div>
    <button class="peek" onclick={() => (open = !open)} aria-expanded={open}>
      {open ? "Hide output" : "Show output"}
    </button>
  </div>

  {#if latest && !open && status !== "done"}
    <div class="ticker mono" aria-live="polite">{latest}</div>
  {/if}

  <!-- the detail ------------------------------------------------------------ -->
  {#if open}
    <ol class="steps">
      {#each steps as step}
        <li class={step.state}>
          <span class="mark"></span>
          <span class="label">{step.label}</span>
          <span class="tiny faint state">
            {step.state === "running" ? "running…"
              : step.state === "done" ? "done"
              : step.state === "failed" ? `failed (exit ${step.code})`
              : step.state === "skipped" ? "skipped" : "waiting"}
          </span>
        </li>
      {/each}
    </ol>
    <pre class="term" use:follow>{log || "(nothing printed yet)"}</pre>
  {/if}

  {#if status === "failed"}
    <div class="fail">
      <strong>{failedStep ? `“${failedStep.label}” failed` : "That step failed"}</strong>
      {#if notRun}
        <span class="tiny"> — the {notRun} step{notRun === 1 ? "" : "s"} after it did not run, because they assume it worked.</span>
      {/if}
      {#if error}<div class="tiny mono why">{error}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .tracker { display: flex; flex-direction: column; gap: .55rem; }

  /* One segment per step, filling left to right. */
  .track { display: flex; gap: 3px; }
  .seg { flex: 1; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .seg .fill { display: block; height: 100%; width: 0; background: var(--accent); transition: width .35s ease; }
  .seg.done .fill, .seg.skipped .fill { width: 100%; background: var(--good); }
  .seg.skipped .fill { opacity: .45; }
  .seg.failed .fill { width: 100%; background: var(--bad); }
  /* The running segment sweeps, so a step with nothing to say still moves. */
  .seg.running .fill {
    width: 100%;
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--accent) 25%, var(--panel-2)) 0%,
      var(--accent) 50%,
      color-mix(in srgb, var(--accent) 25%, var(--panel-2)) 100%);
    background-size: 220% 100%;
    animation: sweep 1.25s linear infinite;
  }
  @keyframes sweep { from { background-position: 100% 0; } to { background-position: -120% 0; } }

  .now { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .what { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .what strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-faint); flex: none; }
  .dot.good { background: var(--good); }
  .dot.bad { background: var(--bad); }
  .dot.live { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; transform: scale(.8); } }

  .peek { background: none; border: 1px solid var(--line); border-radius: 6px;
          color: var(--ink-faint); font-size: .74rem; padding: .2rem .5rem; cursor: pointer; flex: none; }
  .peek:hover { color: var(--ink); border-color: var(--ink-faint); }

  /* The newest line, as a heartbeat rather than as a log. */
  .ticker {
    font-size: .72rem; color: var(--ink-faint);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-left: 2px solid var(--line); padding-left: .5rem;
  }

  ol.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; }
  ol.steps li { display: flex; align-items: baseline; gap: .5rem; font-size: .84rem; color: var(--ink-dim); }
  ol.steps .mark { width: 7px; height: 7px; border-radius: 50%; background: var(--panel-2);
                   border: 1px solid var(--line); flex: none; }
  ol.steps li.done .mark { background: var(--good); border-color: var(--good); }
  ol.steps li.running .mark { background: var(--accent); border-color: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  ol.steps li.failed .mark { background: var(--bad); border-color: var(--bad); }
  ol.steps li.waiting { color: var(--ink-faint); }
  ol.steps .state { margin-left: auto; flex: none; }

  /* A terminal: fixed height, scrolls both ways, never reflows the page. */
  .term {
    margin: 0;
    max-height: 15rem;
    overflow: auto;
    background: #0a0c10;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: .6rem .7rem;
    font-size: .72rem;
    line-height: 1.5;
    white-space: pre;
    color: #b9c2d0;
  }
  .tracker.failed .term { border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }

  .fail { color: var(--bad); font-size: .88rem; }
  .fail .why { color: var(--ink-dim); margin-top: .3rem; overflow-wrap: anywhere; }
</style>
