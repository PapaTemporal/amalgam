/**
 * Runtime prerequisite check.
 *
 * Import this BEFORE anything that touches node:sqlite. ESM evaluates imported
 * modules in source order, so a preflight listed first runs before the module
 * that would otherwise fail — and node:sqlite fails on older runtimes with
 * "ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite", which
 * tells a new user nothing about what to do.
 */
const MIN_MAJOR = 22;
const MIN_MINOR = 5;

const [major, minor] = process.versions.node.split(".").map(Number);
export const nodeOk = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);

if (!nodeOk) {
  console.error(`amalgam needs Node ${MIN_MAJOR}.${MIN_MINOR} or newer — this is Node ${process.versions.node}.`);
  console.error("Its memory store uses Node's built-in SQLite, which arrived in 22.5.");
  console.error("");
  console.error("Install a newer Node from https://nodejs.org (or via nvm/fnm/volta) and re-run.");
  console.error("Nothing else about amalgam needs installing — the rest is optional.");
  process.exit(1);
}
