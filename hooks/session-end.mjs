#!/usr/bin/env node
/**
 * SessionEnd hook — the session records what it learned and leaves the graph
 * current, so nobody has to remember to.
 *
 * Three jobs, and a strict rule about time. A hook runs while the user is
 * waiting for their prompt back, so the cheap half happens here and now
 * (logging the conversation to L0, which is a few inserts) while both expensive
 * halves are handed to detached children and forgotten about. Nothing this file
 * does can delay a session ending, and nothing it fails at can prevent one.
 *
 * The first child asks the local model what was durable about the session. What
 * it produces are PROPOSALS: they wait in a pending table for someone to accept
 * them; see lib/capture.mjs for why automatic writes into long-term memory are
 * a bad trade.
 *
 * The second brings stale code graphs up to date. This is the moment for it —
 * the work has stopped, the machine is idle, and the session that benefits is
 * the next one — and it is why there is no watcher and no git hook. It decides
 * for itself whether anything is worth doing, within a budget learned from how
 * long each repository actually took; see lib/refresh.mjs. Independent of
 * capture, because a graph going stale has nothing to do with whether
 * conversations are being kept.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

let payload = {};
try { payload = JSON.parse(input || "{}"); } catch { /* nothing to do */ }

const transcript = payload.transcript_path ?? "";
const sessionId = payload.session_id ?? "unknown";

/** Start something and stop caring about it. */
const detach = (args) => {
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch { /* the session still has to end */ }
};

try {
  if (transcript && fs.existsSync(transcript)) {
    const { readTranscript, logTurns, captureEnabled } = await import("../lib/capture.mjs");
    if (captureEnabled()) {
      const turns = readTranscript(transcript);
      if (turns.length) {
        logTurns(turns, sessionId);
        // The model pass can take half a minute; the user is not waiting for it.
        detach([path.join(HERE, "distil.mjs"), transcript, sessionId]);
      }
    }
  }
} catch (e) {
  if (process.env.AMALGAM_HOOK_DEBUG) console.error(`[amalgam session-end capture] ${e.stack ?? e.message}`);
}

try {
  // Whether anything is due is worked out by the child, not here: deciding
  // means asking git about every registered repository, and this file is not
  // allowed to spend that while somebody waits for their prompt.
  const { autoRefreshEnabled } = await import("../lib/refresh.mjs");
  if (autoRefreshEnabled()) detach([path.join(HERE, "..", "bin", "amalgam.mjs"), "refresh"]);
} catch (e) {
  // A session must always be allowed to end, so nothing here is fatal. But
  // silence while developing a hook means debugging blind, so the failure is
  // available on request.
  if (process.env.AMALGAM_HOOK_DEBUG) console.error(`[amalgam session-end] ${e.stack ?? e.message}`);
}

process.exit(0);
