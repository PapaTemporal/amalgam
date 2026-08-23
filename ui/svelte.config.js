import adapter from "@sveltejs/adapter-static";

/**
 * Built to static files on purpose.
 *
 * The UI is authored in SvelteKit but must never require the person using it
 * to run a build or an npm install: `amalgam ui` serves the compiled output
 * from Node's own http server, and the API lives beside it in plain Node. So
 * the adapter is static with an SPA fallback — no server runtime, no adapter
 * lock-in, and the build directory is committed.
 */
export default {
  kit: {
    adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", precompress: false }),
    prerender: { entries: [] },
  },
};
