<script>
  import { install, refreshInstall } from "$lib/install.svelte.js";

  /**
   * The state of the install, said once and quietly.
   *
   * There is no landing page asking what you would like to set up, because
   * that question only has an answer the first time and it was in the way
   * every time after. What is left is the part that is genuinely news: that
   * something needed is missing, or that an update is sitting in the clone.
   * When everything is in place it is a version number and nothing more.
   *
   * It reads from the shared store rather than fetching its own copy, so an
   * install or an update run on the setup page is reflected here immediately
   * instead of waiting for a page refresh nobody knew to do.
   */
  $effect(() => { if (!install.loaded) refreshInstall(); });

  const s = $derived(install.data);

  const level = $derived(
    !s ? null
    : !s.installed ? "bad"
    : s.stale ? "warn"
    : !s.wiredUser ? "warn"
    : "ok"
  );
  const label = $derived(
    !s ? ""
    : !s.installed ? "not installed"
    : s.stale ? "update ready"
    : !s.wiredUser ? "not wired"
    : `v${s.version}`
  );
</script>

{#if s}
  <a href="/setup" class="chip {level}" title={s.installed ? `${s.home}\n${s.sourceCommit ?? ""}` : "amalgam is not deployed on this machine"}>
    <span class="dot"></span>{label}
  </a>
{/if}

<style>
  .chip { display: inline-flex; align-items: center; gap: .45rem; font-size: .72rem;
          padding: .3rem .55rem; border: 1px solid var(--line); border-radius: 999px;
          color: var(--ink-faint); text-decoration: none; }
  .chip:hover { color: var(--ink); border-color: var(--ink-faint); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-faint); }
  .chip.ok .dot { background: var(--good); }
  .chip.warn .dot { background: var(--warn); }
  .chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .chip.bad .dot { background: var(--bad); }
  .chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); }
</style>
