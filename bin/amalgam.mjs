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
const DOWNLOADS = [
  {
    id: "llama.cpp (portable CPU build)",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b10532/llama-b10532-bin-win-cpu-x64.zip",
    archive: path.join(HOME, "downloads", "llama-cpu-x64.zip"),
    extractTo: path.join(HOME, "runtime", "llama"),
    check: path.join(HOME, "runtime", "llama", exe("llama-server")),
    winOnly: true,
    approx: "~90 MB",
  },
  {
    id: "PostgreSQL 17.5 (portable binaries)",
    url: "https://get.enterprisedb.com/postgresql/postgresql-17.5-1-windows-x64-binaries.zip",
    archive: path.join(HOME, "downloads", "postgresql-17.5-1-windows-x64-binaries.zip"),
    extractTo: path.join(HOME, "runtime"), // zip contains pgsql/
    check: pgBin("psql"),
    winOnly: true,
    approx: "~300 MB",
  },
  {
    id: "Qwen3-4B-Instruct GGUF model",
    url: `https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/${MODEL_FILE}`,
    archive: path.join(HOME, "models", MODEL_FILE), // no extraction
    check: path.join(HOME, "models", MODEL_FILE),
    winOnly: false,
    approx: "~2.4 GB",
  },
];

function manualHelp(items) {
  const lines = [
    "",
    "================= MANUAL DOWNLOAD (proxy fallback) =================",
    "Automatic download failed (common behind corporate proxies).",
    "Fetch each file below in a browser / by other means, place it at the",
    "listed destination, then re-run:  amalgam install",
    "",
  ];
  for (const d of items) {
    lines.push(`  ${d.id}  (${d.approx})`);
    lines.push(`    URL : ${d.url}`);
    lines.push(`    Save to: ${d.archive}`);
    lines.push("");
  }
  lines.push("curl honors HTTP_PROXY / HTTPS_PROXY env vars if your proxy allows CLI traffic.");
  lines.push("====================================================================");
  return lines.join("\n");
}

function download(d) {
  fs.mkdirSync(path.dirname(d.archive), { recursive: true });
  console.log(`  downloading ${d.id} ${d.approx} ...`);
  const tmp = d.archive + ".part";
  const r = spawnSync("curl", ["-L", "--fail", "--retry", "2", "-o", tmp, d.url], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status === 0) {
    fs.renameSync(tmp, d.archive);
    return true;
  }
  try { fs.rmSync(tmp, { force: true }); } catch {}
  return false;
}

function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (WIN) {
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
  for (const dir of ["mcp", "sql", "skills"]) copyDir(path.join(PKG, dir), path.join(HOME, dir));
  console.log(`Code payload copied to ${HOME}`);

  // 2) fetch + extract runtimes/model
  const failed = [];
  for (const d of DOWNLOADS) {
    if (d.winOnly && !WIN) continue;
    if (fs.existsSync(d.check)) {
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
      if (!extractZip(d.archive, d.extractTo)) {
        console.error(`  extraction failed for ${d.archive}`);
        failed.push(d);
      }
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
    const child = spawn(
      path.join(HOME, "runtime", "llama", exe("llama-server")),
      ["-m", path.join(HOME, "models", MODEL_FILE), "--host", "127.0.0.1", "--port", LLAMA_PORT, "-c", "8192", "--threads", String(Math.max(2, os.cpus().length - 2))],
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

function cmdWire(args) {
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
    for (const s of ["offload", "caveman"]) {
      copyDir(path.join(HOME, "skills", s), path.join(proj, ".claude", "skills", s));
    }
    console.log("Claude Code wired: .mcp.json + .claude/skills/{offload,caveman}");
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

// ---------------------------------------------------------------- dispatch
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "install": await cmdInstall(rest); break;
  case "start": await cmdStart(); break;
  case "stop": cmdStop(); break;
  case "status": await cmdStatus(); break;
  case "wire": cmdWire(rest); break;
  default:
    console.log(`amalgam — local offload stack (memory + caveman compression + code graphs)

Usage:
  amalgam install [--cache <dir>]   download portable runtimes + model into ~/.amalgam
  amalgam start                     start PostgreSQL + llama-server (idempotent)
  amalgam stop                      stop both services
  amalgam status                    health check
  amalgam wire [--claude|--copilot] wire the current project (default: both)

Env overrides: AMALGAM_HOME, AMALGAM_PG_PORT, AMALGAM_LLAMA_PORT`);
}
