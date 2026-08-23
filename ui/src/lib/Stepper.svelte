<script>
  /**
   * The progress tracker.
   *
   * Every step says which of four states it is in and shows the last few lines
   * it printed, because the failure mode of a wizard is not being wrong — it is
   * being silent long enough that the user cannot tell it apart from a hang.
   */
  let { steps = [], state = "running", error = null } = $props();

  const mark = { waiting: "○", running: "◐", done: "●", failed: "✕", skipped: "◌" };
</script>

<div class="stepper">
  {#each steps as step, i}
    <div class="step {step.state}">
      <div class="rail">
        <span class="mark">{mark[step.state] ?? "○"}</span>
        {#if i < steps.length - 1}<span class="line"></span>{/if}
      </div>
      <div class="body">
        <div class="spread">
          <strong>{step.label}</strong>
          <span class="tiny faint">
            {step.state === "running" ? "running…"
              : step.state === "done" ? "done"
              : step.state === "failed" ? `failed (exit ${step.code})`
              : step.state === "skipped" ? "skipped" : ""}
          </span>
        </div>
        {#if step.output?.length && (step.state === "running" || step.state === "failed")}
          <pre class="out">{step.output.join("\n")}</pre>
        {/if}
      </div>
    </div>
  {/each}
</div>

{#if state === "failed"}
  <p class="fail">That step failed, so the rest were not run — the ones after it assume it worked.
  {#if error}<br /><span class="tiny mono">{error}</span>{/if}</p>
{/if}

<style>
  .stepper { display: flex; flex-direction: column; }
  .step { display: flex; gap: .8rem; }
  .rail { display: flex; flex-direction: column; align-items: center; width: 1.2rem; }
  .mark { font-size: 1rem; line-height: 1.4; color: var(--ink-faint); }
  .line { flex: 1; width: 1px; background: var(--line); min-height: 1.1rem; }
  .body { flex: 1; padding-bottom: .9rem; }
  .step.done .mark { color: var(--good); }
  .step.running .mark { color: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  .step.failed .mark { color: var(--bad); }
  .step.waiting .body strong { color: var(--ink-faint); }
  .fail { color: var(--bad); font-size: .9rem; }
  @keyframes pulse { 50% { opacity: .35; } }
</style>
