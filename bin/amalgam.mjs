#!/usr/bin/env node
/**
 * Amalgam CLI — install / start / stop / status / stats / wire / stream /
 * brief / graph / globalize
 *
 * Zero npm dependencies. Node 22.5+ is the only prerequisite (it supplies the
 * built-in SQLite the memory store uses).
 * Everything lands in AMALGAM_HOME (default ~/.amalgam); the repo/package
 * carries only code. Downloads go through system curl (which honors
 * HTTP_PROXY / HTTPS_PROXY) with a Node-fetch fallback; every failed
 * download prints the manual URL + destination so proxied machines can
 * fetch files by hand and re-run.
 */
// Must come first: it reports an unsupported Node clearly, before the SQLite
// import that would otherwise fail with an opaque built-in-module error.
import "../lib/preflight.mjs";

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { ensureLlama, llamaHealthy, modelInstalled, LLAMA_PORT,
         stopLlama, minutesIdle, IDLE_MINUTES } from "../lib/services.mjs";
import { open as openDb } from "../lib/db.mjs";
import { verifyFact } from "../lib/verify.mjs";
// The reclamation rules live in lib/streams.mjs so they can be tested against
// real repositories; this file only prints what they decide.
import { git, readStreams, writeStreams, streamKey, inspectStream, classify,
         buildDirs, dirSize, human, BUILD_DIR_RE, plan as planGc, apply as applyGc,
         STREAMS_DB } from "../lib/streams.mjs";
import { importGraph, indexStatus } from "../lib/graphdb.mjs";
import { listPending, countPending, acceptPending, rejectPending,
         pruneRaw, forgetRaw, RAW_DAYS, RAW_MAX_ROWS } from "../lib/capture.mjs";
import { embed, toBlob, embeddingsInstalled } from "../lib/embed.mjs";
import { createTask, addEvent, setState, listTasks, resume, renderResume } from "../lib/tasks.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
const WIN = process.platform === "win32";
const exe = (p) => (WIN ? `${p}.exe` : p);
const MODEL_FILE = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";

// ------------------------------------------------------------- download plan
// Pinned versions (validated 2026-08). `check` = path that proves the piece
// is already present; `archive` = where the raw download is cached.
//
// Every file is also published as a GitHub release asset on this repo, so a
// machine that can reach github.com needs nothing else. Fetch order per file:
//   1. release asset via gh CLI (if a gh binary is available and authed)
//   2. release asset via curl + token (AMALGAM_GITHUB_TOKEN or GITHUB_TOKEN)
//   3. external URL + mirrors via plain curl (public hosts)
//   4. manual: the browser instructions printed on failure (assets download
//      fine from the release page in a logged-in browser)
const RELEASE = { repo: "PapaTemporal/amalgam", tag: "v0.1.0" };
const RELEASE_PAGE = `https://github.com/${RELEASE.repo}/releases/tag/${RELEASE.tag}`;
// The model ships as a llama.cpp split GGUF (each part under GitHub's 2 GiB
// asset cap). llama-server loads part 1 and pulls the rest automatically —
// no reassembly needed. A machine may instead have the original single file.
const MODEL_PARTS = [
  "Qwen3-4B-Instruct-2507-Q4_K_M-00001-of-00002.gguf",
  "Qwen3-4B-Instruct-2507-Q4_K_M-00002-of-00002.gguf",
];

// Memory is SQLite via Node's built-in module: nothing to download for it.
// Only the optional model path has payloads, and they are skipped unless the
// user asks for them with --with-model.
const EMBED_MODEL_FILE = "bge-small-en-v1.5-f32.gguf";

const DOWNLOADS = [
  {
    id: "llama.cpp (portable CPU build)",
    asset: "llama-cpu-x64.zip",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b10532/llama-b10532-bin-win-cpu-x64.zip",
    archive: path.join(HOME, "downloads", "llama-cpu-x64.zip"),
    extractTo: path.join(HOME, "runtime", "llama"),
    check: path.join(HOME, "runtime", "llama", exe("llama-server")),
    winOnly: true,
    // Serves both the embedding model and the generation model.
    needsRuntime: true,
    approx: "~90 MB",
  },
  {
    id: "bge-small embedding model (semantic recall)",
    asset: EMBED_MODEL_FILE,
    url: `https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/${EMBED_MODEL_FILE}`,
    mirrors: [`https://hf-mirror.com/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/${EMBED_MODEL_FILE}`],
    archive: path.join(HOME, "models", EMBED_MODEL_FILE),
    check: path.join(HOME, "models", EMBED_MODEL_FILE),
    winOnly: false,
    embedOnly: true,
    approx: "~134 MB",
  },
  {
    id: "Qwen3-4B model (split 1/2)",
    asset: MODEL_PARTS[0],
    archive: path.join(HOME, "models", MODEL_PARTS[0]),
    check: path.join(HOME, "models", MODEL_PARTS[0]),
    // present if the original single-file model exists instead
    altCheck: path.join(HOME, "models", MODEL_FILE),
    winOnly: false,
    modelOnly: true,
    approx: "~1.8 GB",
  },
  {
    id: "Qwen3-4B model (split 2/2)",
    asset: MODEL_PARTS[1],
    archive: path.join(HOME, "models", MODEL_PARTS[1]),
    check: path.join(HOME, "models", MODEL_PARTS[1]),
    altCheck: path.join(HOME, "models", MODEL_FILE),
    winOnly: false,
    modelOnly: true,
    approx: "~0.6 GB",
  },
];

// If the release is unreachable, the model can still come from HF/mirror as
// the original single file (used only when both split parts are missing).
const MODEL_SINGLE_FALLBACK = {
  id: "Qwen3-4B-Instruct GGUF model (single file)",
  url: `https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/${MODEL_FILE}`,
  mirrors: [`https://hf-mirror.com/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/${MODEL_FILE}`],
  archive: path.join(HOME, "models", MODEL_FILE),
  approx: "~2.4 GB",
};

function manualHelp(items) {
  const lines = [
    "",
    "================= MANUAL DOWNLOAD (proxy fallback) =================",
    "Automatic download failed (common behind corporate proxies).",
    "",
    "EASIEST — use your web browser (works for the private repo while you",
    "are logged in to GitHub):",
    `  1. Open  ${RELEASE_PAGE}`,
    "  2. Download the assets listed below",
    "  3. Save each one to its destination path",
    "  4. Re-run:  amalgam install",
    "",
  ];
  for (const d of items) {
    lines.push(`  ${d.id}  (${d.approx})`);
    if (d.asset) lines.push(`    Release asset: ${d.asset}`);
    if (d.url) lines.push(`    External URL : ${d.url}`);
    for (const m of d.mirrors ?? []) lines.push(`    Mirror       : ${m}`);
    lines.push(`    Save to      : ${d.archive}`);
    lines.push("");
  }
  lines.push("The model alternative: instead of the two split parts you may fetch the");
  lines.push(`single file from the External URL/Mirror above and save it to`);
  lines.push(`${MODEL_SINGLE_FALLBACK.archive} — either form works.`);
  lines.push("curl honors HTTP_PROXY / HTTPS_PROXY env vars if your proxy allows CLI traffic.");
  lines.push("====================================================================");
  return lines.join("\n");
}

function findGh() {
  for (const cand of ["gh", path.join(HOME, "tools", "gh", "bin", exe("gh"))]) {
    const r = spawnSync(cand, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return cand;
  }
  return null;
}

function downloadReleaseAsset(assetName, dest) {
  const tmpDir = path.join(path.dirname(dest), ".asset-tmp");
  // 1) gh CLI
  const gh = findGh();
  if (gh) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const r = spawnSync(gh, ["release", "download", RELEASE.tag, "-R", RELEASE.repo, "-p", assetName, "-D", tmpDir],
      { stdio: ["ignore", "inherit", "inherit"] });
    const got = path.join(tmpDir, assetName);
    if (r.status === 0 && fs.existsSync(got)) {
      fs.renameSync(got, dest);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return true;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // 2) token (works without gh; set AMALGAM_GITHUB_TOKEN or GITHUB_TOKEN)
  const token = process.env.AMALGAM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    try {
      const relUrl = `https://api.github.com/repos/${RELEASE.repo}/releases/tags/${RELEASE.tag}`;
      const relRes = spawnSync("curl", ["-sL", "--fail", "-H", `Authorization: Bearer ${token}`, relUrl], { encoding: "utf8" });
      if (relRes.status === 0) {
        const rel = JSON.parse(relRes.stdout);
        const asset = (rel.assets ?? []).find((a) => a.name === assetName);
        if (asset) {
          const tmp = dest + ".part";
          const r = spawnSync("curl", ["-L", "--fail", "--retry", "2",
            "-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/octet-stream",
            "-o", tmp, asset.url], { stdio: ["ignore", "inherit", "inherit"] });
          if (r.status === 0) {
            fs.renameSync(tmp, dest);
            return true;
          }
          try { fs.rmSync(tmp, { force: true }); } catch {}
        }
      }
    } catch {}
  }
  return false;
}

function download(d) {
  fs.mkdirSync(path.dirname(d.archive), { recursive: true });
  if (d.asset) {
    console.log(`  fetching ${d.id} ${d.approx} from release ${RELEASE.tag} ...`);
    if (downloadReleaseAsset(d.asset, d.archive)) return true;
  }
  const tmp = d.archive + ".part";
  for (const url of [d.url, ...(d.mirrors ?? [])].filter(Boolean)) {
    console.log(`  downloading ${d.id} ${d.approx} from ${new URL(url).host} ...`);
    const r = spawnSync("curl", ["-L", "--fail", "--retry", "2", "-o", tmp, url], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (r.status === 0) {
      fs.renameSync(tmp, d.archive);
      return true;
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  return false;
}

function extractZip(zip, dest, members = []) {
  fs.mkdirSync(dest, { recursive: true });
  if (WIN) {
    // Use Windows' own bsdtar by absolute path: a Git Bash / MSYS "tar" on
    // PATH is GNU tar, which parses "C:\..." as a remote host. bsdtar also
    // handles zips, long paths, and selective member extraction.
    const tarExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const args = ["-xf", path.resolve(zip), "-C", path.resolve(dest), ...members];
    const tar = spawnSync(tarExe, args, { stdio: ["ignore", "ignore", "inherit"] });
    if (tar.status === 0) return true;
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Path '${zip}' -DestinationPath '${dest}' -Force`],
      { stdio: ["ignore", "ignore", "inherit"] }
    );
    return r.status === 0;
  }
  return spawnSync("unzip", ["-oq", zip, "-d", dest], { stdio: "inherit" }).status === 0;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function httpGet(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
}

function pgRunning() {
  const r = spawnSync(pgBin("pg_isready"), ["-h", "127.0.0.1", "-p", PG_PORT], { stdio: "ignore" });
  return r.status === 0;
}

// ---------------------------------------------------------------- commands
async function cmdInstall(args) {
  if (!WIN) {
    console.log("Non-Windows: memory works as-is (SQLite is built into Node). For the");
    console.log(`optional model, put a llama.cpp build under ${HOME}/runtime/llama and`);
    console.log(`the GGUF model(s) under ${HOME}/models/.`);
    console.log(manualHelp(DOWNLOADS.filter((d) => !d.winOnly)));
  }
  const cacheIdx = args.indexOf("--cache");
  const cache = cacheIdx >= 0 ? args[cacheIdx + 1] : null;

  fs.mkdirSync(HOME, { recursive: true });
  // 1) code payload → HOME (so project wiring never depends on where the repo clone lives)
  for (const dir of ["mcp", "skills", "lib", "hooks"]) copyDir(path.join(PKG, dir), path.join(HOME, dir));
  console.log(`Code payload copied to ${HOME}`);

  // 2) fetch + extract runtimes/model
  const failed = [];
  const withModel = args.includes("--with-model");
  const withEmbed = args.includes("--with-embeddings") || withModel;
  for (const d of DOWNLOADS) {
    if (d.modelOnly && !withModel) continue;
    if (d.embedOnly && !withEmbed) continue;
    if (d.needsRuntime && !withModel && !withEmbed) continue;
    if (d.winOnly && !WIN) continue;
    if (fs.existsSync(d.check) || (d.altCheck && fs.existsSync(d.altCheck))) {
      console.log(`  [ok] ${d.id} already present`);
      continue;
    }
    if (!fs.existsSync(d.archive)) {
      if (cache) {
        const c = path.join(cache, path.basename(d.archive));
        if (fs.existsSync(c)) {
          fs.mkdirSync(path.dirname(d.archive), { recursive: true });
          fs.copyFileSync(c, d.archive);
          console.log(`  [cache] ${d.id} <- ${c}`);
        }
      }
      if (!fs.existsSync(d.archive) && !download(d)) {
        failed.push(d);
        continue;
      }
    }
    if (d.extractTo) {
      console.log(`  extracting ${d.id} ...`);
      if (!extractZip(d.archive, d.extractTo, d.extractMembers ?? [])) {
        console.error(`  extraction failed for ${d.archive}`);
        failed.push(d);
      }
    }
  }
  // Model rescue: if only the split parts failed (release unreachable), try
  // the original single file from the public HF host/mirror instead.
  const failedParts = failed.filter((d) => MODEL_PARTS.includes(d.asset));
  if (failedParts.length > 0 && !fs.existsSync(MODEL_SINGLE_FALLBACK.archive)) {
    console.log("Release unreachable for model parts — trying single-file fallback ...");
    if (download(MODEL_SINGLE_FALLBACK)) {
      for (const d of failedParts) failed.splice(failed.indexOf(d), 1);
    }
  }
  if (failed.length) {
    console.error(manualHelp(failed));
    process.exit(1);
  }

  // Memory needs no initialization step: the SQLite file and its schema are
  // created on first use by lib/db.mjs.
  writeStamp();
  console.log("\nInstall complete. Next, in each project:  amalgam wire");
  console.log("(or once for all of them:  amalgam wire --user)");

  // Installs predating the SQLite migration left a PostgreSQL runtime behind.
  // Nothing reads it any more, and memories in it are not migrated
  // automatically, so say both rather than leaving ~350 MB of confusion.
  const oldPg = path.join(HOME, "runtime", "pgsql");
  if (fs.existsSync(oldPg)) {
    console.log("\nNote: a PostgreSQL runtime from an older amalgam is still present:");
    console.log(`  ${oldPg}`);
    console.log("Memory now uses SQLite and nothing reads it. It is safe to delete.");
    console.log("Memories stored in it are NOT migrated automatically — say so if you need them.");
  }
  if (spawnSync("uv", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.log("\nNote: `uv` was not found, so code-graph commands are unavailable.");
    console.log("Memory works without it. Install from https://docs.astral.sh/uv/ to enable");
    console.log("`amalgam graph` and the graph_query tool.");
  }
  if (!modelInstalled()) {
    console.log("(The optional local model was not installed. `digest` and `caveman_*`");
    console.log(" stay unavailable until you run: amalgam install --with-model)");
  }
}

/**
 * Kept for the one optional service. Memory is a file, so there is nothing to
 * start for it — this only warms the model so the first digest is not slow.
 */
async function cmdStart() {
  if (!modelInstalled()) {
    console.log("Nothing to start: memory is a local SQLite file, and the optional model is not installed.");
    console.log("Install it with `amalgam install --with-model` if you want digest / caveman tools.");
    return;
  }
  if (await llamaHealthy()) console.log("llama-server already running.");
  else {
    process.stdout.write(`Starting llama-server on 127.0.0.1:${LLAMA_PORT} (CPU), loading model `);
    const ok = await ensureLlama(180000);
    console.log(ok ? "— ready." : "— still loading; check `amalgam status`.");
  }
}

function cmdStop() {
  stopLlama();
  console.log("llama-server stopped (if it was running). Memory needs no shutdown.");
}

async function cmdStatus() {
  console.log(`AMALGAM_HOME: ${HOME}`);
  const dbFile = path.join(HOME, "data", "memory.db");
  const size = fs.existsSync(dbFile) ? `${(fs.statSync(dbFile).size / 1e6).toFixed(1)} MB` : "not created yet";
  console.log(`memory      : SQLite (${dbFile}) — ${size}`);
  const idle = minutesIdle();
  const idleNote = IDLE_MINUTES
    ? `, idle ${idle === null ? "?" : Math.floor(idle)}m of ${IDLE_MINUTES}m before shutdown`
    : ", idle shutdown disabled";
  console.log(`local model : ${!modelInstalled() ? "not installed (optional)"
    : (await llamaHealthy()) ? `running (port ${LLAMA_PORT}${idleNote})`
    : "installed, not running (starts on first use)"}`);
  const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });
  console.log(`uv (graphify): ${uv.status === 0 ? uv.stdout.trim() : "uv not found — graph build/query unavailable"}`);
}

/**
 * Usage report. Only measured quantities — no invented counterfactuals — so
 * the project's premise can be judged on data.
 */
function cmdStats() {
  const d = openDb();
  const rows = d.prepare(
    `SELECT tool, count(*) AS calls, sum(in_chars) AS in_chars, sum(out_chars) AS out_chars,
            sum(coalesce(baseline_chars, 0)) AS baseline
       FROM usage_log GROUP BY tool ORDER BY calls DESC`).all();
  if (rows.length === 0) {
    console.log("No tool usage recorded yet.");
    console.log("(Usage is logged from the MCP server; this tells you whether the offload tools are actually being used.)");
    return;
  }
  const est = (chars) => Math.round(chars / 4); // ~4 chars/token, rough but consistent
  console.log("tool              calls    returned (est. tokens)   note");
  let avoided = 0;
  for (const r of rows) {
    // Three different epistemic states, kept apart on purpose. A digest knows
    // what it consumed; a packet knows the files it stood in for; a recall
    // knows neither, and claiming a saving there would be inventing one.
    let note;
    if (r.tool === "caveman_compress" || r.tool === "digest") {
      note = `input ${est(r.in_chars)} tok -> ${est(r.out_chars)} tok (${Math.round((1 - r.out_chars / Math.max(r.in_chars, 1)) * 100)}% smaller, measured)`;
      avoided += Math.max(r.in_chars - r.out_chars, 0);
    } else if (r.baseline > 0) {
      note = `replaced ${est(r.baseline)} tok of file reads (${Math.round((1 - r.out_chars / r.baseline) * 100)}% smaller, measured)`;
      avoided += Math.max(r.baseline - r.out_chars, 0);
    } else {
      note = "context loaded locally instead of by reading files";
    }
    console.log(`${r.tool.padEnd(18)}${String(r.calls).padEnd(9)}${String(est(r.out_chars)).padEnd(25)}${note}`);
  }
  if (avoided > 0) {
    console.log(`\nnot sent to the frontier model: ~${est(avoided)} tokens, measured against what each call actually replaced.`);
  }
  const counts = d.prepare(
    `SELECT (SELECT count(*) FROM l1_facts) f, (SELECT count(*) FROM l2_scenarios) s, (SELECT count(*) FROM l0_log) l`).get();
  console.log(`\nstored: ${counts.f} facts, ${counts.s} scenario docs, ${counts.l} log entries`);
  console.log("Reduction figures are measured on real calls. Everything else is volume, not savings:");
  console.log("no counterfactual run is recorded, so treat those as usage evidence only.");
}

function mergeJsonFile(file, mutate) {
  let obj = {};
  if (fs.existsSync(file)) {
    try { obj = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { throw new Error(`${file} exists but is not valid JSON — fix or remove it, then re-run wire.`); }
  }
  mutate(obj);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

const COPILOT_MARK_BEGIN = "<!-- amalgam-begin -->";
const COPILOT_MARK_END = "<!-- amalgam-end -->";
const COPILOT_SNIPPET = `${COPILOT_MARK_BEGIN}
## Local offload (amalgam MCP)

A local MCP server "amalgam" provides long-term memory and context offload.
All services are on 127.0.0.1 — never substitute cloud services.

- Session start: call \`memory_persona_read\`, then \`memory_recall\` with task keywords.
- Prefer \`graph_query\` (explain/path/query) over reading files in repos with a built graph.
- Save durable facts with \`memory_save_fact\` (terse, dense wording; keep names/paths/commands exact).
- Update project context with \`memory_context_write\`; \`caveman_compress\`/\`caveman_expand\` translate between dense storage form and readable English.
- If tools error "unreachable", ask the user to run: \`amalgam start\`.
${COPILOT_MARK_END}`;

// User-scope Claude Code locations. Skills and hooks placed here apply to
// every session on the machine, regardless of which repo it opens — which is
// what agent skills (amalgam's and BMAD's alike) generally want, since their
// workflows resolve the project at runtime rather than at install time.
const USER_CLAUDE_DIR = path.join(os.homedir(), ".claude");
const USER_SKILLS_DIR = path.join(USER_CLAUDE_DIR, "skills");
const USER_SETTINGS = path.join(USER_CLAUDE_DIR, "settings.json");
const USER_MCP_CONFIG = path.join(os.homedir(), ".claude.json");

function backupOnce(file) {
  try {
    if (fs.existsSync(file) && !fs.existsSync(file + ".amalgam-bak")) {
      fs.copyFileSync(file, file + ".amalgam-bak");
    }
  } catch {}
}

/** Install amalgam's skills, hook, and MCP server for every project at once. */
function wireUser() {
  const serverPath = path.join(HOME, "mcp", "server.mjs");
  if (!fs.existsSync(serverPath)) {
    console.error(`Server not found at ${serverPath} — run 'amalgam install' first.`);
    process.exit(1);
  }

  for (const s of ["offload", "caveman", "start"]) {
    copyDir(path.join(HOME, "skills", s), path.join(USER_SKILLS_DIR, s));
  }
  console.log(`Skills -> ${USER_SKILLS_DIR} (offload, caveman, start)`);

  // Two hooks, same shape: one injects the offload directives as a session
  // begins, the other records what the session learned as it ends.
  for (const [event, file] of [["SessionStart", "session-start.mjs"], ["SessionEnd", "session-end.mjs"]]) {
    const hookPath = path.join(HOME, "hooks", file);
    if (!fs.existsSync(hookPath)) continue;
    backupOnce(USER_SETTINGS);
    mergeJsonFile(USER_SETTINGS, (o) => {
      o.hooks ??= {};
      o.hooks[event] ??= [];
      const already = o.hooks[event].some((entry) =>
        (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(file))
      );
      if (!already) o.hooks[event].push({ hooks: [{ type: "command", command: `node "${hookPath}"` }] });
    });
    console.log(`${event} hook -> ${USER_SETTINGS}`);
  }

  // MCP at user scope lives in ~/.claude.json. That file holds unrelated user
  // state, so back it up before merging into it.
  backupOnce(USER_MCP_CONFIG);
  mergeJsonFile(USER_MCP_CONFIG, (o) => {
    o.mcpServers ??= {};
    o.mcpServers.amalgam = { command: "node", args: [serverPath] };
  });
  console.log(`MCP server -> ${USER_MCP_CONFIG} (mcpServers.amalgam)`);
  recordWiredUser();
  console.log("\nUser-scope wiring done — applies to every project on this machine.");
  console.log("Takes effect in new sessions.");
}

/**
 * Promote a project's agent skills to user scope.
 *
 * BMAD installs its skills into <project>/.claude/skills, which makes them
 * invocable only from sessions rooted in that project — even though the skill
 * bodies use {project-root} placeholders and are perfectly portable. Moving
 * them up makes BMAD usable across every repo, while each project keeps its
 * own _bmad/ config and artifacts.
 */
function cmdGlobalize(args) {
  const proj = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  const prefix = (() => { const i = args.indexOf("--prefix"); return i >= 0 ? args[i + 1] : "bmad-"; })();
  const keep = args.includes("--keep");
  const src = path.join(proj, ".claude", "skills");
  if (!fs.existsSync(src)) {
    console.error(`No skills directory at ${src}`);
    process.exit(1);
  }
  const names = fs.readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name);
  if (names.length === 0) {
    console.log(`No skills starting with "${prefix}" in ${src}`);
    return;
  }
  for (const n of names) {
    copyDir(path.join(src, n), path.join(USER_SKILLS_DIR, n));
    if (!keep) fs.rmSync(path.join(src, n), { recursive: true, force: true });
  }
  console.log(`${names.length} skill(s) matching "${prefix}" -> ${USER_SKILLS_DIR}`);
  console.log(keep
    ? "Project copies kept — note they shadow the user-scope ones in that project."
    : "Project copies removed, so there is exactly one definition of each.");
  console.log(`\nEach project still needs its own config: run the tool's own installer there`);
  console.log(`(for BMAD: npx bmad-method install --directory <project>) to create _bmad/.`);
  console.log("Takes effect in new sessions.");
}

function cmdWire(args) {
  if (args.includes("--user") || args.includes("--global")) return wireUser();
  recordWiredProject(process.cwd());
  const doClaude = args.includes("--claude") || (!args.includes("--copilot"));
  const doCopilot = args.includes("--copilot") || (!args.includes("--claude"));
  const proj = process.cwd();
  const serverPath = path.join(HOME, "mcp", "server.mjs");
  if (!fs.existsSync(serverPath)) {
    console.error(`Server not found at ${serverPath} — run 'amalgam install' first.`);
    process.exit(1);
  }

  if (doClaude) {
    mergeJsonFile(path.join(proj, ".mcp.json"), (o) => {
      o.mcpServers ??= {};
      o.mcpServers.amalgam = { command: "node", args: [serverPath] };
    });
    for (const s of ["offload", "caveman", "start"]) {
      copyDir(path.join(HOME, "skills", s), path.join(proj, ".claude", "skills", s));
    }
    // SessionStart hook: injects the offload directives as context.
    // Deterministic, unlike skill matching, and it
    // covers every workflow in the session (BMAD included) without editing
    // any of their files.
    const hookPath = path.join(HOME, "hooks", "session-start.mjs");
    if (fs.existsSync(hookPath)) {
      mergeJsonFile(path.join(proj, ".claude", "settings.json"), (o) => {
        o.hooks ??= {};
        for (const [event, file] of [["SessionStart", "session-start.mjs"], ["SessionEnd", "session-end.mjs"]]) {
          const p = path.join(HOME, "hooks", file);
          if (!fs.existsSync(p)) continue;
          o.hooks[event] ??= [];
          const already = o.hooks[event].some((entry) =>
            (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(file))
          );
          if (!already) o.hooks[event].push({ hooks: [{ type: "command", command: `node "${p}"` }] });
        }
      });
      console.log("Claude Code wired: .mcp.json + .claude/skills/{offload,caveman,start} + SessionStart hook");
    } else {
      console.log("Claude Code wired: .mcp.json + .claude/skills/{offload,caveman,start}");
      console.log("  (no hook installed — run 'amalgam install' to refresh the code payload)");
    }
  }

  if (doCopilot) {
    mergeJsonFile(path.join(proj, ".vscode", "mcp.json"), (o) => {
      o.servers ??= {};
      o.servers.amalgam = { type: "stdio", command: "node", args: [serverPath] };
    });
    const ciPath = path.join(proj, ".github", "copilot-instructions.md");
    fs.mkdirSync(path.dirname(ciPath), { recursive: true });
    let body = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, "utf8") : "";
    if (body.includes(COPILOT_MARK_BEGIN)) {
      body = body.replace(new RegExp(`${COPILOT_MARK_BEGIN}[\\s\\S]*?${COPILOT_MARK_END}`), COPILOT_SNIPPET);
    } else {
      body = body.trimEnd() + (body ? "\n\n" : "") + COPILOT_SNIPPET + "\n";
    }
    fs.writeFileSync(ciPath, body);
    console.log("Copilot wired: .vscode/mcp.json + .github/copilot-instructions.md");
  }
}

// ================================================================ graph
// graphify builds a code graph that answers "what calls this / how do these
// connect" for a fraction of the tokens reading files costs. The graph is a
// snapshot, so it goes stale as code lands — hence staleness reporting below
// and a refresh command that always passes --code-only (the docs/media pass
// would call a cloud backend, which this stack forbids).

const GRAPH_REL = path.join("graphify-out", "graph.json");

/** null = no graph; otherwise commits landed since it was built. */
function graphStaleness(repo) {
  const g = path.join(repo, GRAPH_REL);
  if (!fs.existsSync(g)) return null;
  let builtAt;
  try { builtAt = fs.statSync(g).mtime; } catch { return null; }
  if (!git(repo, ["rev-parse", "--git-dir"]).ok) return { builtAt, commits: 0, unknown: true };
  // Only code changes can invalidate a code graph. Counting doc/config-only
  // commits would nag for a rebuild that changes nothing.
  const out = git(repo, [
    "log", "--since", builtAt.toISOString(), "--oneline", "--",
    ".", ":(exclude)*.md", ":(exclude)*.txt", ":(exclude).gitignore",
    ":(exclude)docs/**", ":(exclude)LICENSE*",
  ]).out;
  return { builtAt, commits: out ? out.split("\n").filter(Boolean).length : 0 };
}

function buildOneGraph(dir, { sql = false } = {}) {
  console.log(`\n=== ${path.basename(dir)} — building code graph (tree-sitter, local, no LLM)`);
  // graphify's own hint says `pip install graphifyy[sql]`, which does not apply
  // here: it runs through uv in an ephemeral environment, so the extra belongs
  // in the --from spec instead.
  const from = sql ? "graphifyy[sql]" : "graphifyy";
  const r = spawnSync("uv", ["tool", "run", "--from", from, "graphify", ".", "--code-only"], {
    cwd: dir, stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`  failed for ${dir}. Is uv installed? (https://docs.astral.sh/uv/)`);
    return false;
  }
  console.log(`  graph -> ${path.join(dir, GRAPH_REL)}`);
  return true;
}

/**
 * Fold a freshly built graph into the index beside memory.
 *
 * Done here rather than on demand because it is the moment the graph is known
 * to be current, and because embedding a few hundred symbols once is cheaper
 * than every query paying to parse the document again. Failure is reported and
 * ignored: the JSON remains perfectly usable on its own.
 */
async function indexOneGraph(dir) {
  try {
    const withVectors = embeddingsInstalled();
    const res = await importGraph(dir, {
      embed: withVectors ? async (texts) => (await embed(texts))?.map(toBlob) : null,
    });
    if (!res.ok) return console.log(`  index skipped: ${res.error}`);
    const vec = withVectors
      ? `${res.embedded} embedded, ${res.reused} vectors reused`
      : "no embeddings installed — name search only";
    console.log(`  indexed -> ${res.symbols} symbols, ${res.edges} edges (${vec}${res.removed ? `, ${res.removed} gone` : ""})`);
  } catch (e) {
    console.log(`  index skipped: ${e.message}`);
  }
}

function reportStaleness(dir, label = dir) {
  const s = graphStaleness(dir);
  if (!s) console.log(`  ${label}: no graph — build with \`amalgam graph\``);
  else if (s.commits > 0) console.log(`  ${label}: built ${s.builtAt.toISOString().slice(0, 10)}, ${s.commits} code commit(s) since — refresh`);
  else console.log(`  ${label}: current (built ${s.builtAt.toISOString().slice(0, 10)})`);
}

/**
 * Graphs are per service, but a workspace usually wants all of them, so that
 * is the default: run bare in a workspace and every service is graphed in
 * turn, each keeping its own graph. Naming a directory explicitly always means
 * exactly that directory.
 */
async function cmdGraph(args) {
  const dirIdx = args.indexOf("--directory");
  const explicit = dirIdx >= 0 ? args[dirIdx + 1] : args.find((a) => !a.startsWith("--"));
  const check = args.includes("--check");
  const includeNonGit = args.includes("--all");
  const sql = args.includes("--sql");
  const cwd = path.resolve(process.cwd());

  // An explicit path is taken literally — no workspace expansion.
  if (explicit) {
    const target = path.resolve(explicit);
    if (!fs.existsSync(target)) {
      console.error(`No such directory: ${target}`);
      process.exit(1);
    }
    if (check) return reportStaleness(target, path.basename(target));
    if (!buildOneGraph(target, { sql })) process.exit(1);
    await indexOneGraph(target);
    return;
  }

  const services = findServices(cwd);
  const isRepo = git(cwd, ["rev-parse", "--git-dir"]).ok;
  const isWorkspace = !isRepo && services.length >= 2;

  if (!isWorkspace) {
    if (check) return reportStaleness(cwd, path.basename(cwd));
    if (!buildOneGraph(cwd, { sql })) process.exit(1);
    await indexOneGraph(cwd);
    return;
  }

  // Workspace: every service, each with its own graph. Directories not under
  // version control are skipped by default — they are usually vendored tools
  // or downloads rather than code being worked on.
  const targets = services.filter((s) => s.isGit || includeNonGit);
  const skipped = services.filter((s) => !s.isGit && !includeNonGit);

  if (check) {
    console.log(`workspace ${cwd} — ${targets.length} service(s)`);
    for (const s of targets) reportStaleness(s.path, s.name);
    if (skipped.length) console.log(`  (skipped, not git repos: ${skipped.map((s) => s.name).join(", ")} — include with --all)`);
    return;
  }

  console.log(`workspace ${cwd} — graphing ${targets.length} service(s)`);
  if (skipped.length) console.log(`skipping (not git repos): ${skipped.map((s) => s.name).join(", ")}   include with --all`);
  let failures = 0;
  for (const s of targets) {
    if (!buildOneGraph(s.path, { sql })) { failures++; continue; }
    await indexOneGraph(s.path);
  }
  console.log(`\n${targets.length - failures}/${targets.length} graph(s) built. Query them with the graph_query MCP tool.`);
  if (failures) process.exit(1);
}

// ================================================================ version / update
// The code the agent actually runs is a COPY under AMALGAM_HOME, and the
// skills are copies again under ~/.claude and each wired project. Pulling the
// repo therefore updates nothing by itself, so installs are stamped and
// `update` re-deploys every copy.

const STAMP = path.join(HOME, "installed.json");
const WIRED = path.join(HOME, "wired.json");

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version; } catch { return "unknown"; }
}
function pkgCommit() {
  const r = git(PKG, ["rev-parse", "--short", "HEAD"]);
  return r.ok ? r.out : null;
}
function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
}
function writeStamp() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STAMP, JSON.stringify({
    version: pkgVersion(), commit: pkgCommit(), source: PKG, installedAt: new Date().toISOString(),
  }, null, 2) + "\n");
}
/** Remember which projects were wired, so an update can refresh their copies. */
function recordWiredProject(dir) {
  const w = readJson(WIRED, { user: false, projects: [] });
  if (!w.projects.includes(dir)) w.projects.push(dir);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(WIRED, JSON.stringify(w, null, 2) + "\n");
}
function recordWiredUser() {
  const w = readJson(WIRED, { user: false, projects: [] });
  w.user = true;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(WIRED, JSON.stringify(w, null, 2) + "\n");
}

function cmdVersion() {
  const stamp = readJson(STAMP, null);
  const commit = pkgCommit();
  console.log(`amalgam ${pkgVersion()}${commit ? ` (${commit})` : ""}`);
  console.log(`source   : ${PKG}${commit ? "" : "  (not a git clone — installed via npx?)"}`);
  if (!stamp) {
    console.log(`installed: nothing deployed yet — run \`amalgam install\``);
    return;
  }
  console.log(`installed: ${stamp.version}${stamp.commit ? ` (${stamp.commit})` : ""} on ${stamp.installedAt.slice(0, 10)} -> ${HOME}`);
  if (commit && stamp.commit && commit !== stamp.commit) {
    console.log(`\nThe deployed copy is behind this source. Run: amalgam update`);
  }
}

async function cmdUpdate(args) {
  const commitBefore = pkgCommit();
  if (commitBefore && !args.includes("--no-pull")) {
    const dirty = git(PKG, ["status", "--porcelain"]).out;
    if (dirty) {
      console.log("Local changes present in the source clone — skipping git pull.");
    } else {
      console.log("Pulling latest source ...");
      const r = git(PKG, ["pull", "--ff-only"]);
      console.log(r.ok ? `  ${r.out.split("\n")[0]}` : `  pull failed: ${r.err.split("\n")[0]}`);
    }
  } else if (!commitBefore) {
    console.log("This is not a git clone, so there is nothing to pull.");
    console.log("If you installed with npx, re-run the npx command to fetch the latest.");
  }

  // Re-deploy the code payload, then refresh every copy that was wired.
  console.log("\nRe-deploying code payload ...");
  await cmdInstall(args.filter((a) => a !== "--no-pull"));

  const w = readJson(WIRED, { user: false, projects: [] });
  if (w.user) {
    console.log("\nRefreshing user-scope wiring ...");
    wireUser();
  }
  for (const proj of w.projects) {
    if (!fs.existsSync(proj)) continue;
    console.log(`\nRefreshing project wiring: ${proj}`);
    for (const s of ["offload", "caveman", "start"]) {
      copyDir(path.join(HOME, "skills", s), path.join(proj, ".claude", "skills", s));
    }
  }
  console.log(`\nUpdate complete — now at ${pkgVersion()}${pkgCommit() ? ` (${pkgCommit()})` : ""}.`);
  console.log("Restart any open agent session to pick up new skills, hooks, and MCP tools.");
}

// ================================================================ shim
/**
 * Write a real `amalgam` command into a directory already on PATH.
 *
 * Shell aliases are the usual advice and the usual failure: a PowerShell
 * function silently drops arguments without `@args`, a doskey macro does the
 * same without `$*` and does not persist or apply to PowerShell at all. A
 * launcher file has none of those problems and works from every shell.
 */
function cmdShim(args) {
  const explicit = args.find((a) => !a.startsWith("--"));
  const cliPath = path.join(PKG, "bin", "amalgam.mjs");
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const onPath = (dir) => pathDirs.some((p) => path.resolve(p).toLowerCase() === path.resolve(dir).toLowerCase());

  const candidates = explicit ? [explicit] : WIN
    ? [path.join(process.env.APPDATA ?? "", "npm"), path.join(os.homedir(), ".local", "bin")]
    : [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin"];
  const dir = candidates.find((d) => d && fs.existsSync(d) && onPath(d)) ?? candidates.find((d) => d && fs.existsSync(d)) ?? candidates[0];

  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  if (WIN) {
    const cmd = path.join(dir, "amalgam.cmd");
    fs.writeFileSync(cmd, `@echo off\r\nnode "${cliPath}" %*\r\n`);
    written.push(cmd);
  }
  // Also write a POSIX launcher: Git Bash and WSL ignore .cmd files.
  const sh = path.join(dir, "amalgam");
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${cliPath.replace(/\\/g, "/")}" "$@"\n`);
  try { fs.chmodSync(sh, 0o755); } catch {}
  written.push(sh);

  console.log(`Installed the amalgam command:`);
  for (const w of written) console.log(`  ${w}`);
  if (onPath(dir)) console.log(`\n${dir} is already on PATH — open a new shell and run:  amalgam status`);
  else {
    console.log(`\n${dir} is NOT on your PATH. Either add it, or re-run pointing at a directory that is:`);
    console.log(`  amalgam shim <dir-on-your-path>`);
  }
}

// ================================================================ brief
// One fast, dependency-free scan of "where things stand" in a project, so a
// guided menu can offer concrete choices ("continue story 2.3") instead of
// abstract ones ("work on a story"). Filesystem + git only: no database, so
// it still answers when services are down.

function tomlValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : null;
}

function scanDocs(dir, limit = 12) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, depth = 0) => {
    if (depth > 2 || out.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(md|markdown)$/i.test(e.name)) continue;
      let status = null;
      try {
        const head = fs.readFileSync(p, "utf8").slice(0, 1500);
        const m = head.match(/^\s*(?:status|Status)\s*[:=]\s*["']?([A-Za-z][\w \-]{0,24})/m)
          || head.match(/\*\*Status:?\*\*\s*:?\s*([A-Za-z][\w \-]{0,24})/);
        if (m) status = m[1].trim();
      } catch {}
      out.push({ file: path.relative(dir, p).replace(/\\/g, "/"), status });
    }
  };
  walk(dir);
  return out;
}

/**
 * Directories sitting inside a workspace — the "services" BMAD documents.
 * Non-git directories count too: a service is a body of code, not a checkout.
 */
function findServices(root) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_") || e.name === "node_modules") continue;
    const p = path.join(root, e.name);
    const isGit = fs.existsSync(path.join(p, ".git"));
    out.push({
      name: e.name,
      path: p,
      isGit,
      branch: isGit ? git(p, ["rev-parse", "--abbrev-ref", "HEAD"]).out : null,
      dirty: isGit ? git(p, ["status", "--porcelain"]).out.split("\n").filter(Boolean).length : 0,
      graph: fs.existsSync(path.join(p, "graphify-out", "graph.json")),
    });
  }
  return out;
}

function cmdBrief(args) {
  const repo = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  const L = [];
  const isRepo = git(repo, ["rev-parse", "--git-dir"]).ok;
  const services = findServices(repo);
  // A workspace is a directory that holds service repos rather than being one
  // itself. BMAD is installed at this level: it documents the whole system,
  // with each cloned repo as a service under it.
  const isWorkspace = !isRepo && services.length > 0;
  L.push(`${isWorkspace ? "WORKSPACE" : "PROJECT  "} ${path.basename(repo)}  (${repo})`);

  if (isWorkspace) {
    L.push(`SERVICES ${services.length} under this workspace`);
    for (const s of services) {
      const bits = s.isGit
        ? [s.branch, s.dirty ? `${s.dirty} uncommitted` : "clean"]
        : ["not a git repo"];
      const st = graphStaleness(s.path);
      if (!st) bits.push("no graph");
      else if (st.commits > 0) bits.push(`graph ${st.commits} commit(s) stale`);
      else bits.push("graph current");
      L.push(`         ${s.name}  [${bits.join(", ")}]`);
    }
  }

  // --- git ---
  if (isRepo) {
    const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
    const dirty = git(repo, ["status", "--porcelain"]).out.split("\n").filter(Boolean).length;
    const inWorktree = git(repo, ["rev-parse", "--is-inside-work-tree"]).ok;
    L.push(`GIT      branch ${branch}${dirty ? ` | ${dirty} uncommitted change(s)` : " | clean"}${inWorktree ? "" : ""}`);
    const fixBranches = git(repo, ["branch", "--list", "fix/*", "stream/*", "--format=%(refname:short)"]).out
      .split("\n").filter(Boolean);
    if (fixBranches.length) L.push(`         open branches: ${fixBranches.slice(0, 8).join(", ")}${fixBranches.length > 8 ? " ..." : ""}`);
  } else if (!isWorkspace) {
    L.push("GIT      not a git repository");
  }

  // --- amalgam streams for this repo ---
  const db = readStreams();
  const mine = Object.values(db.streams ?? {}).filter((s) => path.resolve(s.repo) === repo);
  if (mine.length === 0) L.push("STREAMS  none");
  else {
    L.push(`STREAMS  ${mine.length}`);
    for (const s of mine) {
      const st = inspectStream(s, { sizes: false });
      const flags = [st.pinned ? "pinned" : null, st.evaluated ? "done" : null, st.dirty ? "dirty" : null,
        st.merged ? "merged" : `${st.unmergedCommits} unmerged`].filter(Boolean).join(", ");
      L.push(`         ${s.name} -> ${s.path}  [${flags}]${s.purpose ? `  ${s.purpose}` : ""}`);
    }
  }

  // --- open work items ---
  // Listed before BMAD's artifacts because this is the question a session
  // actually opens with: not "what exists" but "what was I in the middle of".
  try {
    const open = listTasks({ repo, state: "open", limit: 5 });
    if (open.length) {
      L.push(`TASKS    ${open.length} open`);
      for (const t of open) L.push(`         ${t.id}: ${t.title}${t.story ? ` (story ${t.story})` : ""}  — ${t.updated_at}`);
      L.push(`         resume one with: amalgam task show <id>`);
    }
  } catch {}

  // --- BMAD ---
  const bmadDir = path.join(repo, "_bmad");
  if (fs.existsSync(bmadDir)) {
    let outFolder = "_bmad-output", planning = null, impl = null;
    try {
      const cfg = fs.readFileSync(path.join(bmadDir, "config.toml"), "utf8");
      outFolder = tomlValue(cfg, "output_folder") ?? outFolder;
      planning = tomlValue(cfg, "planning_artifacts");
      impl = tomlValue(cfg, "implementation_artifacts");
    } catch {}
    const resolve = (v, fallback) => (v ? v.replace("{project-root}", repo) : path.join(repo, outFolder, fallback));
    const planDir = resolve(planning, "planning-artifacts");
    const implDir = resolve(impl, "implementation-artifacts");
    const skills = (() => {
      try { return fs.readdirSync(path.join(repo, ".claude", "skills")).filter((n) => n.startsWith("bmad-")).length; }
      catch { return 0; }
    })();
    L.push(`BMAD     installed | ${skills} bmad skills | output ${outFolder}`);
    const plans = scanDocs(planDir);
    const stories = scanDocs(implDir);
    L.push(`         planning artifacts (${planDir}): ${plans.length === 0 ? "none yet" : ""}`);
    for (const p of plans) L.push(`           ${p.file}${p.status ? `  [${p.status}]` : ""}`);
    L.push(`         implementation artifacts (${implDir}): ${stories.length === 0 ? "none yet" : ""}`);
    for (const s of stories) L.push(`           ${s.file}${s.status ? `  [${s.status}]` : ""}`);
  } else {
    L.push("BMAD     not installed in this project");
  }

  // --- graphify ---
  const gst = graphStaleness(repo);
  L.push(`GRAPH    ${!gst ? "not built — run `amalgam graph`"
    : gst.commits > 0 ? `built ${gst.builtAt.toISOString().slice(0, 10)}, ${gst.commits} commit(s) since — refresh with \`amalgam graph\``
      : `current (built ${gst.builtAt.toISOString().slice(0, 10)})`}`);

  // --- services ---
  L.push(`RUNTIME  memory=sqlite (no service) model=${modelInstalled() ? "installed" : "not installed (optional)"}`);

  console.log(L.join("\n"));
}

// ================================================================ streams
// Parallel work streams as git worktrees. Each stream is an isolated
// checkout so concurrent AI sessions never fight over one working tree.
//
// Worktrees that get compiled are expensive (a C++ build dir is GBs), so
// they are treated as reclaimable: every stream carries enough state to
// decide, later and without a human remembering, whether it can be freed.

function cmdStream(args) {
  const [sub, ...rest] = args;
  const flag = (n) => rest.includes(n);
  const opt = (n, d = null) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
  const repo = path.resolve(opt("--repo", process.cwd()));
  const db = readStreams();

  const requireRepo = () => {
    if (!git(repo, ["rev-parse", "--git-dir"]).ok) {
      console.error(`Not a git repository: ${repo}  (pass --repo <path>)`);
      process.exit(1);
    }
  };

  switch (sub) {
    case "new": {
      requireRepo();
      const name = rest[0];
      if (!name || name.startsWith("--")) { console.error("usage: amalgam stream new <name> [--repo <path>] [--base <branch>] [--purpose \"...\"]"); process.exit(1); }
      const base = opt("--base", "main");
      const branch = `stream/${name}`;
      const wt = path.resolve(repo, "..", `${path.basename(repo)}-${name}`);
      if (fs.existsSync(wt)) { console.error(`Path already exists: ${wt}`); process.exit(1); }
      const r = git(repo, ["worktree", "add", "-b", branch, wt, base]);
      if (!r.ok) { console.error(r.err || "git worktree add failed"); process.exit(1); }
      db.streams[streamKey(repo, name)] = {
        name, repo, path: wt, branch, base,
        purpose: opt("--purpose", ""),
        created: new Date().toISOString(),
        evaluated: false, evaluatedAt: null,
        pinned: flag("--pin"),
      };
      writeStreams(db);
      console.log(`Stream '${name}' ready.
  worktree : ${wt}
  branch   : ${branch} (from ${base})
Work there in its own session. Tag memories with context "${path.basename(repo)}/${name}".
When you have judged the result:  amalgam stream done ${name} --repo ${repo}`);
      break;
    }

    case "list": {
      const recs = Object.values(db.streams).filter((s) => !flag("--all") ? true : true);
      if (recs.length === 0) { console.log("No streams registered."); break; }
      const withSizes = !flag("--fast");
      const maxAge = Number(opt("--max-age-days", 14));
      console.log(withSizes ? "Measuring build dirs (use --fast to skip) ...\n" : "");
      for (const rec of recs) {
        const st = inspectStream(rec, { sizes: withSizes });
        const { action, why } = classify(st, maxAge);
        const tag = { keep: "ACTIVE", builds: "RECLAIM BUILDS", remove: "RECLAIMABLE", forget: "MISSING" }[action];
        console.log(`${st.name}  [${tag}]`);
        console.log(`  path    : ${st.path}${st.exists ? "" : "  (gone)"}`);
        console.log(`  branch  : ${st.branch}  ${st.merged ? "(merged)" : `(${st.unmergedCommits} unmerged)`}${st.dirty ? "  DIRTY" : ""}`);
        if (st.purpose) console.log(`  purpose : ${st.purpose}`);
        console.log(`  activity: ${st.ageDays === null ? "no commits" : `${st.ageDays}d since last commit`}`);
        if (withSizes && st.buildBytes) console.log(`  builds  : ${human(st.buildBytes)} in ${st.builds.length} dir(s)`);
        console.log(`  verdict : ${why}\n`);
      }
      console.log("Reclaim with:  amalgam stream gc            (plan only)\n               amalgam stream gc --yes      (execute)");
      break;
    }

    case "done": {
      const name = rest[0];
      const key = streamKey(repo, name);
      if (!db.streams[key]) { console.error(`Unknown stream '${name}' in ${repo}`); process.exit(1); }
      db.streams[key].evaluated = true;
      db.streams[key].evaluatedAt = new Date().toISOString();
      writeStreams(db);
      console.log(`Stream '${name}' marked done — it is now reclaimable by 'amalgam stream gc'.`);
      break;
    }

    case "pin":
    case "unpin": {
      const name = rest[0];
      const key = streamKey(repo, name);
      if (!db.streams[key]) { console.error(`Unknown stream '${name}' in ${repo}`); process.exit(1); }
      db.streams[key].pinned = sub === "pin";
      writeStreams(db);
      console.log(`Stream '${name}' ${sub === "pin" ? "pinned — gc will keep it and its build dir" : "unpinned — gc may now reclaim it"}.`);
      break;
    }

    case "gc": {
      const execute = flag("--yes");
      const planned = planGc(db, {
        maxAgeDays: Number(opt("--max-age-days", 14)),
        buildsOnly: flag("--builds-only"),
      });
      if (planned.length === 0) { console.log("No streams registered."); break; }

      console.log(`${execute ? "Reclaiming" : "Plan (nothing will be deleted — add --yes to execute)"}:
`);
      for (const p of planned) {
        const size = p.bytes ? ` — ${p.action === "builds" ? "free " : "frees "}${human(p.bytes)}${p.action === "remove" ? "+" : ""}` : "";
        console.log(`  ${p.action.padEnd(7)} ${p.state.name} — ${p.why}${size}`);
      }
      if (!execute) break;

      const totals = applyGc(db, planned, {
        onEvent: (e) => {
          if (e.done === "failed") console.log(`          ! ${e.error} (skipped)`);
          else if (e.done === "removed" && e.branch !== "deleted") {
            console.log(`          branch ${e.state.branch} ${e.branch} (unmerged work preserved)`);
          }
        },
      });
      console.log(`
Done: ${totals.removed} worktree(s) removed, ${totals.cleaned} build dir set(s) cleared, ` +
        `${totals.forgotten} registration(s) forgotten, ~${human(totals.freed)} freed.`);
      break;
    }
    case "drop": {
      requireRepo();
      const name = rest[0];
      const key = streamKey(repo, name);
      const rec = db.streams[key];
      if (!rec) { console.error(`Unknown stream '${name}' in ${repo}`); process.exit(1); }
      const st = inspectStream(rec, { sizes: false });
      if ((st.dirty || (!st.merged && st.unmergedCommits > 0)) && !flag("--force")) {
        console.error(`Refusing to drop '${name}': ${st.dirty ? "uncommitted changes" : `${st.unmergedCommits} unmerged commit(s)`}.`);
        console.error(`Its branch ${st.branch} holds the work. Re-run with --force to discard the worktree anyway (branch is kept unless merged).`);
        process.exit(1);
      }
      const r = git(repo, ["worktree", "remove", ...(flag("--force") ? ["--force"] : []), rec.path]);
      if (!r.ok) { console.error(r.err); process.exit(1); }
      if (st.merged) git(repo, ["branch", "-d", rec.branch]);
      delete db.streams[key];
      writeStreams(db);
      console.log(`Dropped stream '${name}'.${st.merged ? "" : ` Branch ${rec.branch} kept.`}`);
      break;
    }

    default:
      console.log(`amalgam stream — parallel work streams as git worktrees

  new <name> [--repo <p>] [--base <branch>] [--purpose "..."] [--pin]
        create an isolated worktree + branch stream/<name>
        --pin keeps it (and its warm build dir) safe from gc
  pin <name> | unpin <name>
        protect a long-lived worktree from reclamation, or release it
  list [--fast] [--max-age-days N]
        show every stream with its reclaim verdict (--fast skips size scan)
  done <name> [--repo <p>]
        mark a stream evaluated — makes it reclaimable
  gc [--yes] [--builds-only] [--max-age-days N]
        reclaim disk. Prints a plan; --yes executes.
        Removes worktrees that are merged or marked done (never dirty ones);
        frees build dirs of stale-but-open streams.
  drop <name> [--force]
        remove one stream now (refuses to discard unmerged work without --force)`);
  }
}

// ================================================================= memory
/**
 * Re-check stored facts against the machine they describe.
 *
 * Memory is the one part of this stack that gets more valuable and less
 * trustworthy over time. Nothing here judges whether a fact is true — only
 * whether the paths it names still exist, which is free and catches the drift
 * that actually happens: a directory moved, a runtime removed, a repo renamed.
 * Recall shows the verdict beside the fact so a stale memory is read with
 * suspicion rather than acted on.
 */
function cmdMemory(args) {
  const sub = args[0] ?? "verify";
  const d = openDb();

  if (sub === "verify") {
    const rows = d.prepare(
      `SELECT id, context, content FROM l1_facts WHERE superseded_by IS NULL ORDER BY id`).all();
    const upd = d.prepare(
      `UPDATE l1_facts SET verify_state = ?, verify_note = ?, verified_at = datetime('now') WHERE id = ?`);
    const tally = { ok: 0, stale: 0, unknown: 0 };
    const stale = [];
    for (const r of rows) {
      const v = verifyFact(r.content);
      upd.run(v.state, v.note, r.id);
      tally[v.state]++;
      if (v.state === "stale") stale.push({ id: r.id, context: r.context, note: v.note });
    }
    console.log(`checked ${rows.length} live fact(s): ${tally.ok} ok, ${tally.stale} stale, ${tally.unknown} nothing to check`);
    for (const s of stale) console.log(`  L1:${s.id}${s.context ? ` @${s.context}` : ""}  ${s.note}`);
    if (stale.length) console.log(`
Stale means a path named in the fact is gone. Fix the fact, or save a corrected one and supersede this id.`);
    return;
  }

  // Proposals from the session-end capture. Deliberately a separate step from
  // saving: a memory nobody approved is a memory nobody can be held to, and
  // recall treats every fact as equally true.
  if (sub === "pending") {
    const rows = listPending(50);
    if (!rows.length) return console.log("no proposals waiting");
    for (const r of rows) console.log(`  ${String(r.id).padStart(3)}  [${r.kind}] ${r.content}`);
    console.log(`
accept with: amalgam memory accept ${rows[0].id}${rows.length > 1 ? " <id>..." : ""}   (or --all)`);
    console.log(`reject with: amalgam memory reject <id>...`);
    return;
  }

  if (sub === "accept" || sub === "reject") {
    const rest = args.slice(1);
    const ids = rest.includes("--all")
      ? listPending(500).map((r) => r.id)
      : rest.filter((a) => /^\d+$/.test(a)).map(Number);
    if (!ids.length) return console.log(`usage: amalgam memory ${sub} <id>... | --all`);
    if (sub === "reject") return console.log(`rejected ${rejectPending(ids)} proposal(s)`);
    const saved = acceptPending(ids, { verifyFact });
    for (const s of saved) console.log(`  proposal ${s.pending} -> L1:${s.fact}${s.state === "stale" ? "  (stale: names a path that does not exist)" : ""}`);
    console.log(`accepted ${saved.length} proposal(s) into memory`);
    return;
  }

  // The raw layer is the one table that grows without anyone choosing to add
  // to it, so it is the one that needs both a limit and a delete button.
  if (sub === "prune") {
    const removed = pruneRaw();
    const left = d.prepare(`SELECT count(*) AS n FROM l0_log`).get().n;
    console.log(`removed ${removed} raw turn(s); ${left} kept (window ${RAW_DAYS} days, cap ${RAW_MAX_ROWS} rows)`);
    return;
  }

  if (sub === "forget") {
    const rest = args.slice(1);
    const idx = rest.indexOf("--session");
    const session = idx >= 0 ? rest[idx + 1] : null;
    if (!session && !rest.includes("--all")) {
      const n = d.prepare(`SELECT count(*) AS n FROM l0_log`).get().n;
      console.log(`usage: amalgam memory forget --session <id> | --all`);
      console.log(`${n} raw turn(s) stored. Distilled facts are never touched by this.`);
      return;
    }
    console.log(`forgot ${forgetRaw({ session })} raw turn(s)${session ? ` from session ${session}` : ""}`);
    return;
  }

  if (sub === "stale" || sub === "list") {
    const where = sub === "stale" ? "verify_state = 'stale' AND superseded_by IS NULL" : "superseded_by IS NULL";
    for (const r of d.prepare(`SELECT id, kind, context, verify_state, content FROM l1_facts WHERE ${where} ORDER BY id`).all()) {
      console.log(`L1:${r.id} [${r.kind}${r.context ? ` @${r.context}` : ""}${r.verify_state === "stale" ? " STALE" : ""}] ${r.content.slice(0, 110)}`);
    }
    return;
  }

  if (sub === "history") {
    const rows = d.prepare(
      `SELECT id, superseded_by, superseded_at, content FROM l1_facts
        WHERE superseded_by IS NOT NULL ORDER BY superseded_at DESC`).all();
    if (!rows.length) return console.log("nothing superseded yet");
    for (const r of rows) console.log(`L1:${r.id} -> L1:${r.superseded_by} (${r.superseded_at})  ${r.content.slice(0, 90)}`);
    return;
  }

  console.log("usage: amalgam memory [verify|list|stale|history|pending|accept|reject|prune|forget]");
}

// ================================================================== tasks
/**
 * Work items from the terminal. The agent has MCP tools for the same store,
 * so a task opened in a session is visible here and the other way round —
 * which is the point: the thread survives whichever end of it you pick up.
 */
function cmdTask(args) {
  // Options and their values are pulled out first, so what remains is the
  // prose the user typed. Filtering only tokens starting with "--" would leave
  // each option's VALUE behind and glue it onto the title.
  const parse = (argv) => {
    const opts = {};
    const words = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith("--")) { opts[argv[i].slice(2)] = argv[i + 1] ?? ""; i++; }
      else words.push(argv[i]);
    }
    return { opts, text: words.join(" ") };
  };

  const [sub, ...rest] = args;
  switch (sub) {
    case "new": {
      const { opts, text } = parse(rest);
      if (!text) return console.log('usage: amalgam task new "<title>" [--repo <path>] [--branch <b>] [--story <id>] [--stream <s>]');
      const repo = opts.repo || process.cwd();
      const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const id = createTask({
        title: text, repo,
        branch: opts.branch || (head.ok ? head.out : ""),
        stream: opts.stream ?? "", story: opts.story ?? "",
      });
      console.log(`task ${id} opened: ${text}`);
      return;
    }
    case "note": {
      const { opts, text } = parse(rest);
      const [id, ...words] = text.split(" ");
      if (!id || !words.length) return console.log('usage: amalgam task note <id> "<what happened>" [--kind decision|blocker|test|commit]');
      addEvent(id, opts.kind ?? "note", words.join(" "));
      console.log(`noted on task ${id}`);
      return;
    }
    case "done": {
      if (!rest[0]) return console.log("usage: amalgam task done <id>");
      setState(rest[0], "done");
      console.log(`task ${rest[0]} closed`);
      return;
    }
    case "show": {
      if (!rest[0]) return console.log("usage: amalgam task show <id>");
      console.log(renderResume(resume(rest[0])));
      return;
    }
    case undefined:
    case "list": {
      const rows = listTasks({ state: rest.includes("--all") ? "all" : "open" });
      if (!rows.length) return console.log('no open work items — start one with: amalgam task new "<title>"');
      for (const t of rows) {
        console.log(`task ${t.id} [${t.state}] ${t.title}`);
        const where = [t.repo && path.basename(t.repo), t.branch && `@${t.branch}`, t.story && `story ${t.story}`].filter(Boolean);
        console.log(`      ${where.join(" ")}   last touched ${t.updated_at}`);
      }
      return;
    }
    default:
      console.log("usage: amalgam task [list|new|note|show|done]");
  }
}

// ---------------------------------------------------------------- dispatch
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "install": await cmdInstall(rest); break;
  case "start": await cmdStart(); break;
  case "stop": cmdStop(); break;
  case "status": await cmdStatus(); break;
  case "stats": cmdStats(); break;
  case "memory": cmdMemory(rest); break;
  case "task": cmdTask(rest); break;
  case "wire": cmdWire(rest); break;
  case "stream": cmdStream(rest); break;
  case "brief": cmdBrief(rest); break;
  case "globalize": cmdGlobalize(rest); break;
  case "graph": await cmdGraph(rest); break;
  case "shim": cmdShim(rest); break;
  case "version": case "--version": case "-v": cmdVersion(); break;
  case "update": await cmdUpdate(rest); break;
  default:
    // Distinguish "you typed a command I don't know" from "I received nothing
    // at all". The second usually means a shell wrapper ate the arguments,
    // which otherwise looks like the tool ignoring a perfectly good command.
    if (cmd === undefined) {
      console.log("No command given — the arguments never reached amalgam.\n");
      console.log("If you ran this through a shell alias or function, that is the usual cause:");
      console.log("  PowerShell: a function must forward arguments with @args");
      console.log("     function amalgam { node C:\\path\\to\\amalgam\\bin\\amalgam.mjs @args }");
      console.log("     (Set-Alias cannot pass arguments at all — use a function.)");
      console.log("  bash/zsh:   alias amalgam='node /path/to/amalgam/bin/amalgam.mjs'\n");
    } else {
      console.log(`Unknown command: ${cmd}\n`);
    }
    console.log(`amalgam — local offload stack (memory + caveman compression + code graphs)

Usage:
  amalgam install [--with-embeddings] set up ~/.amalgam. Memory needs no download;
                 [--with-model]     --with-embeddings adds semantic recall (~220 MB);
                 [--cache <dir>]    --with-model adds digest/caveman too (~2.5 GB)
  amalgam start                     warm the optional model (memory needs no service)
  amalgam stop                      stop the model if running
  amalgam status                    health check
  amalgam version                   what is deployed vs. what this source has
  amalgam update                    pull, re-deploy, and refresh every wired copy
  amalgam stats                     measured tool usage — is any of this earning its keep?
  amalgam memory [sub]              verify | list | stale | history — re-check
                                    stored facts against this machine and show
                                    what drifted or was superseded;
                                    pending | accept | reject — review the facts
                                    a finished session proposed;
                                    prune | forget — apply retention to the raw
                                    session log, or delete it outright
  amalgam task [sub]                list | new | note | show | done — the work
                                    item tying a story, branch, stream and what
                                    was learned into one resumable thread
  amalgam wire [--claude|--copilot] wire the current project (default: both)
  amalgam wire --user               wire once for EVERY project on this machine
                                    (skills + hook + MCP at user scope)
  amalgam globalize [project]       promote a project's bmad-* skills to user
                                    scope so they work in every repo
                                    (--prefix <p>, --keep)
  amalgam stream <sub>              parallel work streams as git worktrees
                                    (new | list | done | gc | drop | pin)
  amalgam shim [dir]                install a real 'amalgam' command on PATH
                                    (avoids alias pitfalls entirely)
  amalgam brief [repo]              where things stand: git, streams, BMAD
                                    artifacts, graph, services
  amalgam graph [--check] [--all]   build/refresh code graphs: every service in
                 [--directory <p>]  a workspace, or just the current repo.
                                    --directory/<path> targets one exactly,
                                    --check reports staleness only,
                                    --all includes non-git directories,
                                    --sql also parses .sql files

Env overrides: AMALGAM_HOME, AMALGAM_DB, AMALGAM_LLAMA_PORT`);
}
