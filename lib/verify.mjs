/**
 * Fact verification: check the parts of a memory that a machine can check.
 *
 * Memories rot silently. A fact recorded in good faith names a path, a port or
 * a command, and months later the path is gone — but recall still ranks it
 * first and states it with the same confidence as the truth. That failure is
 * expensive twice over: the frontier model spends context on it, then spends
 * more context correcting it.
 *
 * Most of a fact is prose and only a human or a much larger model can judge
 * it. But the concrete anchors inside it — filesystem paths, above all — are
 * checkable for free, locally, with no model at all. So that is what this
 * does: it never asks whether a fact is TRUE, only whether the things it
 * names still EXIST. A fact whose anchors have vanished is not necessarily
 * wrong, but it is exactly the kind that has usually drifted, and flagging it
 * is far cheaper than discovering it mid-task.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

// Text that looks like a path but is deliberately not one. Documentation
// placeholders would otherwise be reported stale on every machine forever.
const PLACEHOLDER = /(<[^>]*>|\{[^}]*\}|\bpath[\\/]to\b|\byour-|\bexample\b|\*|\?$)/i;

const WINDOWS_ABS = /\b[A-Za-z]:[\\/][^\s,;:'"`)\]]+/g;
const POSIX_ABS = /(?:^|[\s('"`])(~?\/[^\s,;:'"`)\]]+)/g;

/** Trailing sentence punctuation is not part of the path. */
const trim = (p) => p.replace(/[.,;:!?)\]]+$/, "");

/**
 * Pull the checkable anchors out of a fact. Currently filesystem paths; the
 * shape allows other anchor kinds (ports, commands) to be added without
 * changing callers.
 */
export function claims(text) {
  const out = [];
  const add = (raw) => {
    const value = trim(raw);
    // A bare "/start" or "and/or" is prose, not a path worth checking.
    if (value.length < 4 || PLACEHOLDER.test(value)) return;
    if (/^https?:|^git\+|^mailto:/i.test(value)) return;
    const segments = value.split(/[\\/]+/).filter(Boolean);
    if (segments.length < 2) return;
    if (!out.some((c) => c.value === value)) out.push({ kind: "path", value });
  };
  for (const m of String(text).matchAll(WINDOWS_ABS)) add(m[0]);
  for (const m of String(text).matchAll(POSIX_ABS)) add(m[1]);
  return out;
}

/** Resolve a claim to something the filesystem can be asked about. */
export function resolve(value) {
  let p = value.split("\\").join("/");
  if (p === "~" || p.startsWith("~/")) p = path.join(HOME, p.slice(1));
  return p;
}

/**
 * Verify one fact.
 *
 * Returns 'unknown' when there was nothing to check — deliberately distinct
 * from 'ok', so an unverifiable fact is never presented as a confirmed one.
 */
export function verifyFact(text) {
  const found = claims(text);
  if (found.length === 0) return { state: "unknown", note: "no checkable anchors", checked: 0, missing: [] };
  const missing = found.filter((c) => !fs.existsSync(resolve(c.value)));
  if (missing.length === 0) {
    return { state: "ok", note: `${found.length} path(s) exist`, checked: found.length, missing: [] };
  }
  const shown = missing.slice(0, 2).map((m) => m.value).join(", ");
  return {
    state: "stale",
    note: `missing: ${shown}${missing.length > 2 ? ` (+${missing.length - 2} more)` : ""}`,
    checked: found.length,
    missing: missing.map((m) => m.value),
  };
}
