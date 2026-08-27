<script>
  import "$lib/app.css";
  import { page } from "$app/state";
  import InstallChip from "$lib/InstallChip.svelte";
  let { children } = $props();

  const links = [
    { href: "/", label: "Projects" },
    { href: "/metrics", label: "Metrics" },
    { href: "/memory", label: "Memory" },
    { href: "/setup", label: "Setup" },
  ];
  // "Projects" owns everything about projects, including adding one and
  // opening one — the section a page belongs to is not always the folder its
  // route happens to sit in.
  const on = (href) => href === "/"
    ? page.url.pathname === "/" || page.url.pathname.startsWith("/projects")
    : page.url.pathname.startsWith(href);
</script>

<div class="shell">
  <nav class="side">
    <div class="brand">amalgam<span>local offload stack</span></div>
    {#each links as l}
      <a href={l.href} class:on={on(l.href)}>{l.label}</a>
    {/each}
    <div class="foot"><InstallChip /></div>
  </nav>
  <main>{@render children()}</main>
</div>

<style>
  .foot { margin-top: auto; padding: 1rem 1.25rem 0; }
</style>
