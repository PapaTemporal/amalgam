<script>
  import "$lib/app.css";
  import { page } from "$app/state";
  let { children } = $props();

  const links = [
    { href: "/", label: "Projects" },
    { href: "/metrics", label: "Metrics" },
    { href: "/memory", label: "Memory" },
    { href: "/setup", label: "Setup" },
  ];
  const on = (href) => href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(href);
</script>

<div class="shell">
  <nav class="side">
    <div class="brand">amalgam<span>local offload stack</span></div>
    {#each links as l}
      <a href={l.href} class:on={on(l.href)}>{l.label}</a>
    {/each}
  </nav>
  <main>{@render children()}</main>
</div>
