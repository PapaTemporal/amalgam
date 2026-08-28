/**
 * Runtime prerequisite check.
 *
 * Import this BEFORE anything that touches node:sqlite. ESM evaluates imported
 * modules in source order, so a preflight listed first runs before the module
 * that would otherwise fail — and node:sqlite fails on older runtimes with
 * "ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite", which
 * tells a new user nothing about what to do.
 *
 * Two prerequisites, and only one of them is a version.
 *
 * The second is FTS5, SQLite's full-text index, which the memory store's schema
 * creates on first open. FTS5 is a *compile-time* option: it depends on who
 * built the Node binary, not on how new it is. Homebrew's Node — the most
 * common install on macOS — is built without it. So a version check alone
 * passes a machine that will later fail at its first memory write with
 * "no such module: fts5", in another process, minutes or hours after the
 * install said it was fine.
 *
 * The official builds on nodejs.org include FTS5, and they are portable
 * archives: extract and run, no installer and no administrator. That is the
 * supported runtime, so this checks for it rather than working around its
 * absence — a store that cannot index is not a degraded store, it is a store
 * that cannot open.
 */
// node:module is present on every runtime this could possibly run on, unlike
// node:sqlite — so importing it above the version check is safe, and it gives a
// synchronous way to reach node:sqlite from an ESM file. A dynamic `import()`
// would work too, but it would make this module async, and its whole job is to
// have finished before anything else loads.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const MIN_MAJOR = 22;
const MIN_MINOR = 5;

const [major, minor] = process.versions.node.split(".").map(Number);
export const nodeOk = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);

if (!nodeOk) {
  console.error(`amalgam needs Node ${MIN_MAJOR}.${MIN_MINOR} or newer — this is Node ${process.versions.node}.`);
  console.error("Its memory store uses Node's built-in SQLite, which arrived in 22.5.");
  console.error("");
  console.error(portableNodeHelp());
  process.exit(1);
}

/**
 * Does this runtime's SQLite have FTS5? Probed on a scratch in-memory database,
 * so it costs nothing and touches no file.
 *
 * node:sqlite announces itself with an ExperimentalWarning as it loads, which
 * would otherwise prefix the output of every command and every MCP response.
 * db.mjs silences that same warning for the same reason; this runs first, so it
 * has to do it too rather than inherit it.
 */
export function hasFts5() {
  const warnings = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
    console.warn(w.stack ?? `${w.name}: ${w.message}`);
  });
  try {
    const { DatabaseSync } = require("node:sqlite");
    const probe = new DatabaseSync(":memory:");
    try {
      probe.exec("CREATE VIRTUAL TABLE amalgam_fts_probe USING fts5(a)");
      return true;
    } catch {
      return false;
    } finally {
      try { probe.close(); } catch {}
    }
  } catch {
    return false;
  } finally {
    // Leave the listener table as it was found, so importing this module is not
    // itself a side effect on anyone else's warning handling.
    if (warnings.length) {
      process.removeAllListeners("warning");
      for (const w of warnings) process.on("warning", w);
    }
  }
}

/**
 * Where this platform's portable Node lives, and what to do with it.
 *
 * Deliberately no PATH edit and no shell rc file. Editing PATH means knowing
 * which shell somebody uses — zsh, bash, fish, PowerShell, cmd — each with a
 * different file and a different syntax, and on a locked-down machine possibly
 * none that persist. Calling the extracted binary by its full path needs none
 * of that: it is the same instruction on every platform and in every shell.
 *
 * It also only has to be done once. `amalgam wire` and `amalgam shim` record
 * the absolute path of whichever Node ran them, so everything afterwards — the
 * MCP server, the session hooks, the `amalgam` command — uses this runtime
 * without PATH being involved at all.
 */
function portableNodeHelp() {
  const LTS = "v22.23.2";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const win = process.platform === "win32";
  const os = win ? "win" : process.platform === "darwin" ? "darwin" : "linux";
  const pkg = win ? `node-${LTS}-win-${arch}.zip`
    : `node-${LTS}-${os}-${arch}.${os === "darwin" ? "tar.gz" : "tar.xz"}`;
  const dir = `node-${LTS}-${os}-${arch}`;
  const bin = win ? `${dir}\\node.exe` : `${dir}/bin/node`;

  return [
    "Node is a prerequisite you install yourself — but it needs no installer,",
    "no administrator and no package manager. The official builds are portable:",
    "",
    `  1. Download  https://nodejs.org/dist/${LTS}/${pkg}`,
    `  2. ${win ? "Unzip" : "Extract"} it anywhere you can write — a home folder, a share, a USB stick`,
    win ? "" : `       tar -xf ${pkg}`,
    "  3. Run amalgam with it, by full path:",
    `       ${bin} bin/amalgam.mjs install`,
    "",
    "No PATH change, no shell profile to edit — which shell you use does not",
    "matter. `wire` and `shim` remember this exact runtime, so every later",
    "command, hook and MCP server uses it without being told again.",
  ].filter((l) => l !== "").join("\n");
}

// FTS5 is only worth asking about once the module exists to ask.
if (nodeOk && !hasFts5()) {
  console.error(`This Node (${process.versions.node}) was built without SQLite's FTS5 module.`);
  console.error("amalgam's memory store indexes every fact, scenario and log line with it,");
  console.error("so the store cannot be created on this runtime. Nothing is wrong with the");
  console.error("version — FTS5 is chosen when the binary is compiled, and some distributions");
  console.error("(Homebrew's Node among them) leave it out.");
  console.error("");
  console.error("The official builds have it. Check with:");
  console.error(`  node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(a)')"`);
  console.error("");
  console.error(portableNodeHelp());
  process.exit(1);
}
