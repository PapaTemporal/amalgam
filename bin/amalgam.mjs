#!/usr/bin/env node
/**
 * Amalgam CLI — install / start / stop / status / wire
 *
 * Zero npm dependencies. Node 18+ only prerequisite.
 * Everything lands in AMALGAM_HOME (default ~/.amalgam); the repo/package
 * carries only code. Downloads go through system curl (which honors
 * HTTP_PROXY / HTTPS_PROXY) with a Node-fetch fallback; every failed
 * download prints the manual URL + destination so proxied machines can
 * fetch files by hand and re-run.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
const WIN = process.platform === "win32";
const PG_PORT = process.env.AMALGAM_PG_PORT ?? "5455";
const LLAMA_PORT = process.env.AMALGAM_LLAMA_PORT ?? "8642";
const exe = (p) => (WIN ? `${p}.exe` : p);
const pgBin = (name) => path.join(HOME, "runtime", "pgsql", "bin", exe(name));
const pgData = path.join(HOME, "data", "pg");
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

const DOWNLOADS = [
  {
    id: "llama.cpp (portable CPU build)",
    asset: "llama-cpu-x64.zip",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b10532/llama-b10532-bin-win-cpu-x64.zip",
    archive: path.join(HOME, "downloads", "llama-cpu-x64.zip"),
    extractTo: path.join(HOME, "runtime", "llama"),
    check: path.join(HOME, "runtime", "llama", exe("llama-server")),
    winOnly: true,
    approx: "~90 MB",
  },
  {
    id: "PostgreSQL 17.5 (portable binaries)",
    asset: "postgresql-17.5-1-windows-x64-binaries.zip",
    url: "https://get.enterprisedb.com/postgresql/postgresql-17.5-1-windows-x64-binaries.zip",
    archive: path.join(HOME, "downloads", "postgresql-17.5-1-windows-x64-binaries.zip"),
    extractTo: path.join(HOME, "runtime"), // zip contains pgsql/
    // Skip pgAdmin/docs/etc: unneeded, huge, and their deep paths can
    // exceed Windows' 260-char limit. bin+lib+share is a complete server.
    extractMembers: ["pgsql/bin/*", "pgsql/lib/*", "pgsql/share/*"],
    check: pgBin("psql"),
    winOnly: true,
    approx: "~300 MB",
  },
  {
    id: "Qwen3-4B model (split 1/2)",
    asset: MODEL_PARTS[0],
    archive: path.join(HOME, "models", MODEL_PARTS[0]),
    check: path.join(HOME, "models", MODEL_PARTS[0]),
    // present if the original single-file model exists instead
    altCheck: path.join(HOME, "models", MODEL_FILE),
    winOnly: false,
    approx: "~1.8 GB",
  },
  {
    id: "Qwen3-4B model (split 2/2)",
    asset: MODEL_PARTS[1],
    archive: path.join(HOME, "models", MODEL_PARTS[1]),
    check: path.join(HOME, "models", MODEL_PARTS[1]),
    altCheck: path.join(HOME, "models", MODEL_FILE),
    winOnly: false,
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
    console.log("Non-Windows install is manual for now: put a llama.cpp build and PostgreSQL");
    console.log(`binaries under ${HOME}/runtime/{llama,pgsql} and the model under ${HOME}/models/.`);
    console.log(manualHelp(DOWNLOADS.filter((d) => !d.winOnly)));
  }
  const cacheIdx = args.indexOf("--cache");
  const cache = cacheIdx >= 0 ? args[cacheIdx + 1] : null;

  fs.mkdirSync(HOME, { recursive: true });
  // 1) code payload → HOME (so project wiring never depends on where the repo clone lives)
  for (const dir of ["mcp", "sql", "skills", "lib", "hooks"]) copyDir(path.join(PKG, dir), path.join(HOME, dir));
  console.log(`Code payload copied to ${HOME}`);

  // 2) fetch + extract runtimes/model
  const failed = [];
  for (const d of DOWNLOADS) {
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

  // 3) initdb (first run only)
  if (WIN && !fs.existsSync(path.join(pgData, "PG_VERSION"))) {
    console.log("Initializing PostgreSQL data directory ...");
    const r = spawnSync(pgBin("initdb"), ["-D", pgData, "-U", os.userInfo().username, "-A", "trust", "-E", "UTF8", "--no-instructions"], { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) {
      console.error("initdb failed");
      process.exit(1);
    }
  }
  console.log("\nInstall complete. Next:  amalgam start   then in each project:  amalgam wire");
}

async function cmdStart() {
  // PostgreSQL — spawn detached with ignored stdio (the daemon inherits
  // handles; piping them hangs the parent shell).
  if (!pgRunning()) {
    console.log(`Starting PostgreSQL on 127.0.0.1:${PG_PORT} ...`);
    const r = spawnSync(
      pgBin("pg_ctl"),
      ["-D", pgData, "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1`, "-l", path.join(HOME, "data", "pg.log"), "-w", "start"],
      { stdio: ["ignore", "ignore", "inherit"] }
    );
    if (r.status !== 0 || !pgRunning()) {
      console.error(`PostgreSQL failed to start — see ${path.join(HOME, "data", "pg.log")}`);
      process.exit(1);
    }
  } else console.log("PostgreSQL already running.");

  // DB + schema, idempotent
  const has = spawnSync(pgBin("psql"), ["-h", "127.0.0.1", "-p", PG_PORT, "-d", "postgres", "-tA", "-c", "SELECT 1 FROM pg_database WHERE datname='amalgam'"], { encoding: "utf8" });
  if (!has.stdout?.includes("1")) {
    spawnSync(pgBin("createdb"), ["-h", "127.0.0.1", "-p", PG_PORT, "amalgam"], { stdio: "inherit" });
    console.log("Created database 'amalgam'.");
  }
  spawnSync(pgBin("psql"), ["-h", "127.0.0.1", "-p", PG_PORT, "-d", "amalgam", "-q", "-f", path.join(HOME, "sql", "schema.sql")], { stdio: ["ignore", "ignore", "inherit"] });
  console.log("Schema ensured.");

  // llama.cpp
  if (await httpGet(`http://127.0.0.1:${LLAMA_PORT}/health`)) {
    console.log("llama-server already running.");
  } else {
    console.log(`Starting llama-server on 127.0.0.1:${LLAMA_PORT} (CPU) ...`);
    // Model may exist as the original single file or as a llama.cpp split
    // GGUF (release-asset form). llama-server loads the rest of a split
    // automatically when pointed at part 1.
    const singleModel = path.join(HOME, "models", MODEL_FILE);
    const splitModel = path.join(HOME, "models", MODEL_PARTS[0]);
    const modelPath = fs.existsSync(singleModel) ? singleModel : splitModel;
    if (!fs.existsSync(modelPath)) {
      console.error(`No model found in ${path.join(HOME, "models")} — run 'amalgam install' first.`);
      process.exit(1);
    }
    const child = spawn(
      path.join(HOME, "runtime", "llama", exe("llama-server")),
      ["-m", modelPath, "--host", "127.0.0.1", "--port", LLAMA_PORT, "-c", "8192", "--threads", String(Math.max(2, os.cpus().length - 2))],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
    process.stdout.write("  waiting for model load ");
    const deadline = Date.now() + 120000;
    let ok = false;
    while (Date.now() < deadline) {
      const h = await httpGet(`http://127.0.0.1:${LLAMA_PORT}/health`);
      if (h && h.includes("ok")) { ok = true; break; }
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(ok ? " ready." : " still loading — check `amalgam status` in a minute.");
  }
  console.log("Amalgam stack is up.");
}

function cmdStop() {
  if (WIN) spawnSync("taskkill", ["/IM", "llama-server.exe", "/F"], { stdio: "ignore" });
  else spawnSync("pkill", ["-f", "llama-server"], { stdio: "ignore" });
  console.log("llama-server stopped (if it was running).");
  spawnSync(pgBin("pg_ctl"), ["-D", pgData, "-m", "fast", "stop"], { stdio: ["ignore", "ignore", "inherit"] });
  console.log("PostgreSQL stopped (if it was running).");
}

async function cmdStatus() {
  console.log(`AMALGAM_HOME: ${HOME}`);
  console.log(`PostgreSQL  : ${pgRunning() ? `OK (port ${PG_PORT})` : "not running"}`);
  const h = await httpGet(`http://127.0.0.1:${LLAMA_PORT}/health`);
  console.log(`llama-server: ${h?.includes("ok") ? `OK (port ${LLAMA_PORT})` : "not running / still loading"}`);
  const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });
  console.log(`uv (graphify): ${uv.status === 0 ? uv.stdout.trim() : "uv not found — graph_query build/query unavailable"}`);
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

  const hookPath = path.join(HOME, "hooks", "session-start.mjs");
  if (fs.existsSync(hookPath)) {
    backupOnce(USER_SETTINGS);
    mergeJsonFile(USER_SETTINGS, (o) => {
      o.hooks ??= {};
      o.hooks.SessionStart ??= [];
      const already = o.hooks.SessionStart.some((entry) =>
        (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("session-start.mjs"))
      );
      if (!already) o.hooks.SessionStart.push({ hooks: [{ type: "command", command: `node "${hookPath}"` }] });
    });
    console.log(`SessionStart hook -> ${USER_SETTINGS}`);
  }

  // MCP at user scope lives in ~/.claude.json. That file holds unrelated user
  // state, so back it up before merging into it.
  backupOnce(USER_MCP_CONFIG);
  mergeJsonFile(USER_MCP_CONFIG, (o) => {
    o.mcpServers ??= {};
    o.mcpServers.amalgam = { command: "node", args: [serverPath] };
  });
  console.log(`MCP server -> ${USER_MCP_CONFIG} (mcpServers.amalgam)`);
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
    // SessionStart hook: starts PostgreSQL if needed and injects the offload
    // directives as context. Deterministic, unlike skill matching, and it
    // covers every workflow in the session (BMAD included) without editing
    // any of their files.
    const hookPath = path.join(HOME, "hooks", "session-start.mjs");
    if (fs.existsSync(hookPath)) {
      mergeJsonFile(path.join(proj, ".claude", "settings.json"), (o) => {
        o.hooks ??= {};
        o.hooks.SessionStart ??= [];
        const cmd = `node "${hookPath}"`;
        const already = o.hooks.SessionStart.some((entry) =>
          (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("session-start.mjs"))
        );
        if (!already) o.hooks.SessionStart.push({ hooks: [{ type: "command", command: cmd }] });
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

function cmdGraph(args) {
  const target = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  if (!fs.existsSync(target)) {
    console.error(`No such directory: ${target}`);
    process.exit(1);
  }
  if (args.includes("--check")) {
    const s = graphStaleness(target);
    if (!s) console.log(`no graph in ${target} — build one with: amalgam graph ${target}`);
    else console.log(`graph built ${s.builtAt.toISOString().slice(0, 10)}, ${s.commits} commit(s) since${s.commits > 0 ? " — consider refreshing" : ""}`);
    return;
  }
  console.log(`Building code graph for ${target} (tree-sitter, local, no LLM) ...`);
  const r = spawnSync("uv", ["tool", "run", "--from", "graphifyy", "graphify", ".", "--code-only"], {
    cwd: target, stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error("graphify failed. Is uv installed? (https://docs.astral.sh/uv/)");
    process.exit(1);
  }
  console.log(`\nGraph at ${path.join(target, GRAPH_REL)} — query it with the graph_query MCP tool.`);
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
  L.push(`RUNTIME  postgres ${pgRunning() ? "up" : "down (auto-starts on first memory call)"}`);

  console.log(L.join("\n"));
}

// ================================================================ streams
// Parallel work streams as git worktrees. Each stream is an isolated
// checkout so concurrent AI sessions never fight over one working tree.
//
// Worktrees that get compiled are expensive (a C++ build dir is GBs), so
// they are treated as reclaimable: every stream carries enough state to
// decide, later and without a human remembering, whether it can be freed.

const STREAMS_DB = path.join(HOME, "streams.json");
// Build output dirs to reclaim. Matched at the worktree root only.
const BUILD_DIR_RE = /^(build|build[-.].*|.*\.build|cmake-build-.*|out|target|node_modules)$/i;

function git(repo, args, opts = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function readStreams() {
  try { return JSON.parse(fs.readFileSync(STREAMS_DB, "utf8")); } catch { return { streams: {} }; }
}
function writeStreams(db) {
  fs.mkdirSync(path.dirname(STREAMS_DB), { recursive: true });
  fs.writeFileSync(STREAMS_DB, JSON.stringify(db, null, 2) + "\n");
}
const streamKey = (repo, name) => `${path.basename(repo)}::${name}`;

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      try { total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; } catch {}
    }
  } catch {}
  return total;
}
const human = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`);

function buildDirs(worktree) {
  try {
    return fs.readdirSync(worktree, { withFileTypes: true })
      .filter((e) => e.isDirectory() && BUILD_DIR_RE.test(e.name))
      .map((e) => path.join(worktree, e.name));
  } catch { return []; }
}

/** Everything needed to judge whether a stream is still worth its disk. */
function inspectStream(rec, { sizes = true } = {}) {
  const exists = fs.existsSync(rec.path);
  const st = { ...rec, exists, dirty: false, merged: false, ageDays: null, builds: [], buildBytes: 0, unmergedCommits: 0 };
  if (!exists) return st;
  // "Dirty" must mean work at risk, not build output. Untracked files inside
  // a build dir are expected in any compiled worktree; counting them would
  // make every built stream permanently unreclaimable.
  st.dirty = git(rec.path, ["status", "--porcelain"]).out
    .split("\n").filter(Boolean)
    .some((line) => {
      const p = line.slice(3).replace(/^"|"$/g, "");
      if (!line.startsWith("??")) return true;             // tracked change
      return !BUILD_DIR_RE.test(p.split("/")[0]);          // untracked non-build file
    });
  st.merged = git(rec.repo, ["merge-base", "--is-ancestor", rec.branch, rec.base]).ok;
  const last = git(rec.path, ["log", "-1", "--format=%ct"]).out;
  if (last) st.ageDays = Math.floor((Date.now() / 1000 - Number(last)) / 86400);
  const ahead = git(rec.repo, ["rev-list", "--count", `${rec.base}..${rec.branch}`]).out;
  st.unmergedCommits = Number(ahead || 0);
  st.builds = buildDirs(rec.path);
  if (sizes) st.buildBytes = st.builds.reduce((n, d) => n + dirSize(d), 0);
  return st;
}

/**
 * Reclamation policy. Two tiers, because losing a build dir costs time while
 * losing an unmerged worktree costs work:
 *   remove  — whole worktree: merged, or explicitly evaluated; never dirty
 *   builds  — free build output only, keep the code: stale but still open
 */
function classify(st, maxAgeDays) {
  if (!st.exists) return { action: "forget", why: "worktree directory is gone" };
  if (st.dirty) return { action: "keep", why: "uncommitted changes — never auto-removed" };
  // Pinned streams keep their (expensive) warm build dir across cycles —
  // e.g. the nightly worktree, where a cold rebuild costs far more than disk.
  if (st.pinned) return { action: "keep", why: "pinned (persistent worktree)" };
  if (st.merged) return { action: "remove", why: `merged into ${st.base}` };
  if (st.evaluated) return { action: "remove", why: `marked done ${st.evaluatedAt?.slice(0, 10) ?? ""}`.trim() };
  if (st.ageDays !== null && st.ageDays >= maxAgeDays) {
    return st.buildBytes > 0
      ? { action: "builds", why: `no commits in ${st.ageDays}d, ${st.unmergedCommits} unmerged commit(s) kept` }
      : { action: "keep", why: `stale (${st.ageDays}d) but nothing to reclaim` };
  }
  return { action: "keep", why: "active" };
}

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
      const maxAge = Number(opt("--max-age-days", 14));
      const buildsOnly = flag("--builds-only");
      const recs = Object.values(db.streams);
      if (recs.length === 0) { console.log("No streams registered."); break; }
      console.log(`${execute ? "Reclaiming" : "Plan (nothing will be deleted — add --yes to execute)"}:\n`);
      let freed = 0, removed = 0, cleaned = 0;
      for (const rec of recs) {
        const st = inspectStream(rec);
        let { action, why } = classify(st, maxAge);
        if (buildsOnly && action === "remove") action = st.buildBytes > 0 ? "builds" : "keep";
        const key = streamKey(rec.repo, rec.name);

        if (action === "keep") { console.log(`  keep    ${st.name} — ${why}`); continue; }

        if (action === "forget") {
          console.log(`  forget  ${st.name} — ${why}`);
          if (execute) { git(rec.repo, ["worktree", "prune"]); delete db.streams[key]; }
          continue;
        }

        if (action === "builds") {
          console.log(`  builds  ${st.name} — free ${human(st.buildBytes)} — ${why}`);
          if (execute) {
            for (const d of st.builds) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
            freed += st.buildBytes; cleaned++;
          }
          continue;
        }

        // remove: worktree + branch (branch only when truly merged)
        const total = st.buildBytes;
        console.log(`  remove  ${st.name} — ${why}${st.buildBytes ? ` — frees ${human(st.buildBytes)}+` : ""}`);
        if (execute) {
          // Clear build output first: it is the bulk of the bytes, and git
          // refuses to remove a worktree containing untracked files. Our own
          // dirty check (stricter about real work, lenient about build dirs)
          // already passed, so --force here cannot discard actual work.
          for (const d of st.builds) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
          let r = git(rec.repo, ["worktree", "remove", st.path]);
          if (!r.ok) r = git(rec.repo, ["worktree", "remove", "--force", st.path]);
          if (!r.ok) { console.log(`          ! ${r.err.split("\n")[0]} (skipped)`); continue; }
          if (st.merged) git(rec.repo, ["branch", "-d", st.branch]);
          else console.log(`          branch ${st.branch} kept (unmerged work preserved)`);
          delete db.streams[key];
          freed += total; removed++;
        }
      }
      if (execute) {
        writeStreams(db);
        console.log(`\nDone: ${removed} worktree(s) removed, ${cleaned} build dir set(s) cleared, ~${human(freed)} freed.`);
      }
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

// ---------------------------------------------------------------- dispatch
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "install": await cmdInstall(rest); break;
  case "start": await cmdStart(); break;
  case "stop": cmdStop(); break;
  case "status": await cmdStatus(); break;
  case "wire": cmdWire(rest); break;
  case "stream": cmdStream(rest); break;
  case "brief": cmdBrief(rest); break;
  case "globalize": cmdGlobalize(rest); break;
  case "graph": cmdGraph(rest); break;
  default:
    console.log(`amalgam — local offload stack (memory + caveman compression + code graphs)

Usage:
  amalgam install [--cache <dir>]   download portable runtimes + model into ~/.amalgam
  amalgam start                     start PostgreSQL + llama-server (idempotent)
  amalgam stop                      stop both services
  amalgam status                    health check
  amalgam wire [--claude|--copilot] wire the current project (default: both)
  amalgam wire --user               wire once for EVERY project on this machine
                                    (skills + hook + MCP at user scope)
  amalgam globalize [project]       promote a project's bmad-* skills to user
                                    scope so they work in every repo
                                    (--prefix <p>, --keep)
  amalgam stream <sub>              parallel work streams as git worktrees
                                    (new | list | done | gc | drop | pin)
  amalgam brief [repo]              where things stand: git, streams, BMAD
                                    artifacts, graph, services
  amalgam graph [repo] [--check]    build/refresh a local code graph
                                    (--check reports staleness only)

Env overrides: AMALGAM_HOME, AMALGAM_PG_PORT, AMALGAM_LLAMA_PORT`);
}
