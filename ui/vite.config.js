import { sveltekit } from "@sveltejs/kit/vite";

export default {
  plugins: [sveltekit()],
  server: {
    // `npm run dev` talks to the same API the shipped build talks to, so the
    // development experience cannot drift from the real one.
    proxy: { "/api": "http://127.0.0.1:7777" },
  },
};
