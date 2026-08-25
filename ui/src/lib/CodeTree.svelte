<script>
  /**
   * The project as a hierarchy, collapsed by default.
   *
   * Answers "what is even in here", which no amount of node-and-edge drawing
   * ever does. Every row carries its symbol count so a folded branch still
   * says how much it is hiding — the thing that makes a tree browsable rather
   * than a guessing game about which arrow to click.
   */
  let { node, depth = 0, onpick, selected = null } = $props();

  // Open the first couple of levels: a tree that starts fully closed makes you
  // click three times before it has told you anything.
  let open = $state(depth < 2);
  const isLeaf = $derived(node.kind === "symbol");
</script>

<div class="row" style={`padding-left:${depth * 0.85}rem`}>
  {#if isLeaf}
    <button class="line sym" class:on={node.id === selected} onclick={() => onpick?.(node)}>
      <span class="tick"></span>
      <span class="name">{node.name}</span>
      {#if node.degree}<span class="deg tiny faint">{node.degree}</span>{/if}
    </button>
  {:else}
    <button class="line" onclick={() => (open = !open)}>
      <span class="tick">{open ? "▾" : "▸"}</span>
      <span class="name {node.kind}">{node.name}</span>
      <span class="deg tiny faint">{node.symbols}</span>
    </button>
  {/if}
</div>

{#if open && !isLeaf}
  {#each node.children as child}
    <svelte:self node={child} depth={depth + 1} {onpick} {selected} />
  {/each}
{/if}

<style>
  .row { display: block; }
  .line { display: flex; align-items: baseline; gap: .4rem; width: 100%;
          background: none; border: none; padding: .15rem .3rem; text-align: left;
          color: var(--ink-dim); font-size: .84rem; cursor: pointer; border-radius: 4px; }
  .line:hover { background: var(--panel-2); color: var(--ink); }
  .line.on { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--ink); }
  .tick { width: .8rem; flex: none; color: var(--ink-faint); font-size: .7rem; }
  .name { overflow-wrap: anywhere; }
  .name.dir { color: var(--ink); }
  .name.file { font-family: var(--mono, monospace); font-size: .8rem; }
  .sym .name { font-family: var(--mono, monospace); }
  .deg { margin-left: auto; flex: none; }
</style>
