#!/usr/bin/env node
/**
 * Shuts the local model down once nothing has used it for a while.
 *
 * Lazy start was only half of the bargain this project makes about the model:
 * it holds ~3.6 GB, so it loads on first real use — and then, until this
 * existed, sat there until the machine rebooted. That cost is worse than an
 * eager start because it is invisible. No session mentions it, and nobody
 * thinks to run `amalgam stop` hours later.
 *
 * Runs detached, outside whatever asked for the model, since that is usually
 * an MCP server or a one-shot hook which exits long before the model stops
 * being useful. It writes a heartbeat so a second watchdog will not start, and
 * it exits on its own once the server is gone — including when someone else
 * stopped it — so an idle machine ends up running neither.
 *
 * Usage: normally spawned by lib/services.mjs. AMALGAM_LLAMA_IDLE_MIN=0
 * disables the whole mechanism; the model then behaves as it did before.
 */
import fs from "node:fs";
import path from "node:path";
import { HOME, IDLE_MINUTES, llamaHealthy, minutesIdle, stopLlama } from "./services.mjs";

const LOCK = path.join(HOME, "llama.watchdog");
// Poll interval is a knob only so the test can run in seconds rather than
// minutes; a minute is right for real use.
const POLL_MS = Number(process.env.AMALGAM_LLAMA_POLL_MS ?? 60000);

const beat = () => { try { fs.writeFileSync(LOCK, String(Date.now())); } catch {} };
const done = () => { try { fs.rmSync(LOCK, { force: true }); } catch {} };

if (!IDLE_MINUTES) process.exit(0);
beat();

// A server that never became healthy is not this process's problem: give it a
// couple of minutes to load, then stop waiting.
let waited = 0;
while (!(await llamaHealthy())) {
  if ((waited += POLL_MS) > 180000) { done(); process.exit(0); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

while (true) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  beat();

  // Somebody else stopped it, or it died: nothing left to watch.
  if (!(await llamaHealthy())) break;

  const idle = minutesIdle();
  if (idle !== null && idle >= IDLE_MINUTES) {
    stopLlama();
    break;
  }
}

done();
process.exit(0);
