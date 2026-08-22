#!/usr/bin/env node
/**
 * SessionEnd hook — the session records what it learned, so nobody has to
 * remember to.
 *
 * Two jobs, and a strict rule about time. A hook runs while the user is
 * waiting for their prompt back, so the cheap half happens here and now
 * (logging the conversation to L0, which is a few inserts) while the expensive
 * half — asking the local model what was durable about the session — is handed
 * to a detached child and forgotten about. Nothing this file does can delay a
 * session ending, and nothing it fails at can prevent one.
 *
 * What the child produces are PROPOSALS. They wait in a pending table for
 * someone to accept them; see lib/capture.mjs for why automatic writes into
 * long-term memory are a bad trade.
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

try {
  if (transcript && fs.existsSync(transcript)) {
    const { readTranscript, logTurns, captureEnabled } = await import("../lib/capture.mjs");
    if (!captureEnabled()) process.exit(0);
    const turns = readTranscript(transcript);
    if (turns.length) {
      logTurns(turns, sessionId);
      // The model pass can take half a minute; the user is not waiting for it.
      const child = spawn(process.execPath, [path.join(HERE, "distil.mjs"), transcript, sessionId], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      child.unref();
    }
  }
} catch (e) {
  // A session must always be allowed to end, so nothing here is fatal. But
  // silence while developing a hook means debugging blind, so the failure is
  // available on request.
  if (process.env.AMALGAM_HOOK_DEBUG) console.error(`[amalgam session-end] ${e.stack ?? e.message}`);
}

process.exit(0);
