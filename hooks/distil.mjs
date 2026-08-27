#!/usr/bin/env node
/**
 * The slow half of session capture, run detached by hooks/session-end.mjs.
 *
 * Nothing here is on anyone's critical path: by the time this runs the session
 * has already ended and the transcript is on disk. It reads that transcript,
 * asks the local model what about the session stays true, and files the result
 * as proposals for later review. Failure is silent by design — a background
 * job that cannot be seen must not be able to complain.
 *
 * Usage (normally invoked by the hook): node distil.mjs <transcript> <session>
 */
import { readTranscript, proposeFacts, savePending, worthCapturing } from "../lib/capture.mjs";

const [transcript, sessionId = "unknown"] = process.argv.slice(2);

try {
  const turns = readTranscript(transcript);
  // A session that asked one question did not decide anything durable, and
  // every proposal it makes costs somebody a decision to reject.
  if (!worthCapturing(turns)) process.exit(0);

  const proposals = await proposeFacts(turns);
  if (proposals.length) {
    // Compared by meaning where the model is installed: the repeats seen in
    // practice were the same fact reworded, not copied.
    let vectors = {};
    try {
      const { embed, similarity, embeddingsInstalled } = await import("../lib/embed.mjs");
      if (embeddingsInstalled()) vectors = { embed, similarity };
    } catch { /* text comparison is enough */ }
    await savePending(proposals, sessionId, vectors);
  }
} catch { /* silent: nobody is watching this process */ }
