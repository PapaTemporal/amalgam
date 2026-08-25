<script>
  import { get } from "$lib/api.js";
  import CodeTree from "./CodeTree.svelte";
  import { untrack } from "svelte";

  /**
   * The project as a hierarchy, fetched a branch at a time.
   *
   * Answers "what is even in here", which no amount of node-and-edge drawing
   * ever does. Every row carries its symbol count so a folded branch still
   * says how much it is hiding — the thing that makes a tree browsable rather
   * than a guessing game about which arrow to click.
   *
   * Children arrive on expand rather than up front, because a project with a
   * hundred thousand symbols is eleven megabytes of tree: not something to
   * browse, something to download. What is open is what has been paid for.
   */
  let { node, projectKey, depth = 0, onpick, selected = null } = $props();

  // Open the first level: a tree that starts fully closed makes you click
  // before it has told you anything. Both of these are read once on purpose —
  // a row's depth never changes, and the keyed each above guarantees a row
  // never receives a different node than the one it was built for.
  let open = $state(untrack(() => depth) < 1);
  let fetched = $state(null);
  let loading = $state(false);
  let error = $state(null);

  // What is on screen: whatever arrived from the branch fetch, or whatever the
  // parent already had.
  const children = $derived(fetched ?? node.children ?? []);

  const isLeaf = $derived(node.kind === "symbol");
  const needsFetch = $derived(!isLeaf && !children.length && (node.childCount ?? 0) > 0);

  async function expand() {
    open = !open;
    if (!open || !needsFetch || loading) return;
    loading = true;
    try {
      const branch = await get("/explore/tree", { key: projectKey, under: node.path ?? "" });
      fetched = branch.children ?? [];
    } catch (e) { error = e.message; }
    loading = false;
  }
</script>

<div class="row" style={`padding-left:${depth * 0.85}rem`}>
  {#if isLeaf}
    <button class="line sym" class:on={node.id === selected} onclick={() => onpick?.(node)}>
      <span class="tick"></span>
      <span class="name">{node.name}</span>
      {#if node.degree}<span class="deg tiny faint">{node.degree}</span>{/if}
    </button>
  {:else}
    <button class="line" onclick={expand}>
      <span class="tick">{loading ? "·" : open ? "▾" : "▸"}</span>
      <span class="name {node.kind}">{node.name}</span>
      <span class="deg tiny faint">{node.symbols}</span>
    </button>
  {/if}
</div>

{#if error}
  <div class="row tiny" style={`padding-left:${(depth + 1) * 0.85}rem;color:var(--bad)`}>{error}</div>
{/if}

{#if open && !isLeaf}
  <!-- Keyed, so a branch that reloads builds new rows rather than handing a
       different node to a row that has already decided whether it is open. -->
  {#each children as child (child.id ?? child.path ?? child.name)}
    <CodeTree node={child} {projectKey} depth={depth + 1} {onpick} {selected} />
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
