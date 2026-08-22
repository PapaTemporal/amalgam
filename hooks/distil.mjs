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
import { readTranscript, proposeFacts, savePending } from "../lib/capture.mjs";

const [transcript, sessionId = "unknown"] = process.argv.slice(2);

try {
  const turns = readTranscript(transcript);
  const proposals = await proposeFacts(turns);
  if (proposals.length) savePending(proposals, sessionId);
} catch { /* silent: nobody is watching this process */ }
