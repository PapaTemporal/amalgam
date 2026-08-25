<script>
  /**
   * A real dialog.
   *
   * Asking a question by pushing a panel into the page moves everything else
   * down and leaves the thing you clicked somewhere else entirely — you lose
   * your place answering a question you did not go looking for. `<dialog>`
   * with showModal() gets the rest for free: focus is trapped, Escape closes
   * it, the page behind is inert, and it is centred over what you were looking
   * at rather than displacing it.
   */
  let { open = false, title = "", onclose, children } = $props();

  let el = $state(null);

  $effect(() => {
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  });
</script>

<dialog bind:this={el} onclose={() => onclose?.()} onclick={(e) => { if (e.target === el) onclose?.(); }}>
  <!-- The click handler above closes on the backdrop only: `e.target` is the
       dialog itself only when the click landed outside its content box. -->
  <div class="body">
    <div class="head">
      <h2>{title}</h2>
      <button class="x" onclick={() => onclose?.()} aria-label="Close">✕</button>
    </div>
    {@render children?.()}
  </div>
</dialog>

<style>
  dialog {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    color: var(--ink);
    padding: 0;
    max-width: min(560px, calc(100vw - 2rem));
    width: 100%;
    box-shadow: 0 24px 60px rgb(0 0 0 / .55);
  }
  dialog::backdrop { background: rgb(0 0 0 / .55); }
  .body { padding: 1.15rem 1.25rem 1.25rem; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: .6rem; }
  .head h2 { margin: 0; font-size: 1.05rem; }
  .x { background: none; border: none; color: var(--ink-faint); cursor: pointer;
       font-size: .9rem; line-height: 1; padding: .25rem; border-radius: 4px; }
  .x:hover { color: var(--ink); background: var(--panel-2); }
</style>
