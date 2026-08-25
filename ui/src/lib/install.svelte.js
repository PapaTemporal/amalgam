import { get } from "./api.js";

/**
 * The install state, shared.
 *
 * The chip in the sidebar and the setup page are looking at the same fact —
 * what is deployed, and whether the clone has moved past it — so they read it
 * from one place. Two copies meant the chip went on saying "update ready"
 * after an update had already run, which is the one moment it is guaranteed to
 * be wrong and the one moment somebody is looking at it.
 */
export const install = $state({ data: null, loaded: false, error: null });

let inflight = null;

/** Re-read it. Safe to call from anywhere that just changed the install. */
export async function refreshInstall() {
  // A page that changes the install typically triggers several of these at
  // once; one request is enough and they can all await the same one.
  inflight ??= get("/install")
    .then((d) => { install.data = d; install.error = null; })
    .catch((e) => { install.error = e.message; })
    .finally(() => { install.loaded = true; inflight = null; });
  return inflight;
}
