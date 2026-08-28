#!/usr/bin/env node
/**
 * The hard constraints, checked instead of trusted.
 *
 * docs/constraints.md explains why each exists. This file exists because that
 * document, on its own, is a document: the no-GPU rule and the portability rule
 * had both been policy since the project started, neither was written down
 * anywhere, and both were broken in good faith by someone adding platform
 * support. Prose does not fail a build.
 *
 * The assertions are about the source rather than a running system, so they
 * hold on a machine with no model installed, no network, and no GPU to be wrong
 * about — which is most machines this runs on.
 *
 * Two exit codes carry different meanings. A violation is a failure and exits
 * non-zero. A *known* gap — something docs/constraints.md already records as not
 * yet true — is reported and does not fail, so the suite stays honest about
 * outstanding work without a permanently red build hiding a new regression.
 *
 * Usage: node tests/constraints-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(PKG, rel), "utf8");
/** Source with comments removed — a rule is about what runs, not what is explained. */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let failed = 0, known = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (detail) console.log(`      ${detail}`);
};
const gap = (what, ok, detail = "") => {
  if (!ok) known++;
  console.log(`${ok ? "PASS" : "GAP "}  ${what}`);
  if (detail) console.log(`      ${detail}`);
};

// --- 1. no GPU ---------------------------------------------------------------
const services = code("lib/services.mjs");
const embed = code("lib/embed.mjs");

check("CPU_ONLY disables both device offload and layer offload",
  /export const CPU_ONLY = \[[^\]]*"--device",\s*"none"[^\]]*"-ngl",\s*"0"[^\]]*\]/.test(services),
  "lib/services.mjs must be able to pin llama-server to the CPU");

// GPU offload is a supported exception (docs/constraints.md §1), so the rule is
// no longer "never offload" — it is that CPU is what you get unless somebody
// said otherwise. That is worth asserting by running it rather than by reading
// it: point HOME at an empty directory, which is what an untouched install
// looks like, and ask what the servers would actually be launched with.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-gpu-"));
  const saved = { home: process.env.AMALGAM_HOME, gpu: process.env.AMALGAM_GPU };
  process.env.AMALGAM_HOME = tmp;
  delete process.env.AMALGAM_GPU;
  const svc = await import(`../lib/services.mjs?constraints=${Date.now()}`);

  check("with nothing configured, the GPU is off",
    svc.gpuEnabled() === false, "an untouched install must never offload");
  check("with nothing configured, servers launch pinned to the CPU",
    svc.deviceArgs().join(" ") === "--device none -ngl 0",
    `deviceArgs() = ${JSON.stringify(svc.deviceArgs())}`);

  fs.writeFileSync(path.join(tmp, "gpu.json"), JSON.stringify({ enabled: true }));
  check("the opt-in is what turns it on, and it does turn it on",
    svc.gpuEnabled() === true && !svc.deviceArgs().includes("--device"),
    `after opting in: ${JSON.stringify(svc.deviceArgs())}`);

  fs.writeFileSync(path.join(tmp, "gpu.json"), "{ not json");
  check("a malformed setting falls back to CPU, not to the GPU",
    svc.gpuEnabled() === false, "an unreadable opt-in is not an opt-in");

  if (saved.home === undefined) delete process.env.AMALGAM_HOME; else process.env.AMALGAM_HOME = saved.home;
  if (saved.gpu !== undefined) process.env.AMALGAM_GPU = saved.gpu;
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The opt-in must be a decision, never a discovery. If it asked the machine
// what it had, the same install would offload on a workstation and not on the
// VM it ships to, and that difference would surface as a performance mystery
// rather than as a setting somebody chose.
{
  const body = services.slice(services.indexOf("export function gpuEnabled()"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 3);
  check("the GPU opt-in never probes the hardware",
    !/list-devices|llamaServerPath|spawnSync|spawn\(|cpus\(\)|platform|arch/.test(fn),
    "it reads a setting and an env var, and nothing else");
}

// Call sites are found by looking for llamaServerPath(), not from a list, so a
// spawn added later is checked too rather than silently exempt.
for (const [rel, src] of [["lib/services.mjs", services], ["lib/embed.mjs", embed]]) {
  const spawns = src.split(/spawn\(/).slice(1).filter((s) => s.slice(0, 400).includes("llamaServerPath()"));
  check(`${rel}: every llama-server spawn goes through deviceArgs()`,
    spawns.length > 0 && spawns.every((s) => s.slice(0, 900).includes("...deviceArgs()")),
    `${spawns.length} spawn(s) of llama-server found`);
}

const cli = code("bin/amalgam.mjs");
const GPU_BUILD = /\b(cuda|vulkan|rocm|sycl|opencl|openvino|hip)\b/i;
const assetLines = cli.split("\n").filter((l) => /asset:|url:|archive:/.test(l) && /llama/i.test(l));
check("no GPU-flavoured llama build is referenced",
  !assetLines.some((l) => GPU_BUILD.test(l)),
  assetLines.length ? `${assetLines.length} llama asset line(s) checked` : "no llama asset lines found");

// --- 2. nothing installed, nothing needs admin -------------------------------
for (const rel of ["bin/amalgam.mjs", "lib/services.mjs", "lib/embed.mjs", "lib/uiserver.mjs", "mcp/server.mjs"]) {
  const hit = code(rel).match(/\bsudo\b|\brunas\b|Start-Process[^\n]*-Verb\s+RunAs|\bsetuid\b|launchctl|systemctl|\bapt-get\b|\byum\b|\bbrew\s+install\b/i);
  check(`${rel}: never elevates or invokes a package manager`, !hit, hit ? `found: ${hit[0]}` : "");
}

// The one sanctioned prerequisite is Node, and it must be checked by capability
// rather than by version — the whole reason preflight was wrong before.
const pre = read("lib/preflight.mjs");
check("preflight checks FTS5 itself, not just the version number",
  /USING fts5/.test(pre) && /hasFts5/.test(pre),
  "FTS5 is a compile-time option, so a version comparison cannot prove it");

// --- 3. portable ------------------------------------------------------------
const HOME_USERS = ["lib/db.mjs", "lib/services.mjs", "lib/streams.mjs", "lib/reconcile.mjs",
                    "lib/router.mjs", "lib/transfer.mjs", "bin/amalgam.mjs"];
for (const rel of HOME_USERS) {
  const src = read(rel);
  const roots = [...src.matchAll(/path\.join\(\s*os\.homedir\(\)\s*,\s*"\.amalgam"/g)].length;
  const guarded = [...src.matchAll(/process\.env\.AMALGAM_HOME\s*\?\?\s*path\.join\(\s*os\.homedir\(\)\s*,\s*"\.amalgam"/g)].length;
  check(`${rel}: every storage root honours AMALGAM_HOME`, roots === guarded,
    `${roots} root(s), ${guarded} guarded`);
}

// Wiring must stay relocatable: pin an absolute interpreter only when the bare
// word would resolve somewhere else.
check("wiring prefers the bare `node` when PATH already resolves to it",
  /function wiringNode\(\)/.test(cli) && /return "node";/.test(cli),
  "an absolute path is frozen to a location, and a portable install moves");

// --- 4. one host: this project's own release --------------------------------
// A third-party address may be *shown* — telling someone where a file lives is
// not the same as fetching it for them, and on a machine that cannot reach the
// release it is the difference between being stuck and being informed. What may
// not happen is this project contacting one. So the rule is about the fields
// and calls that download, not about whether a hostname appears in the file.
const THIRD_PARTY = /(huggingface|hf-mirror|unpkg|jsdelivr|cdnjs|ggml-org)/i;
const cliCode = code("bin/amalgam.mjs");

// 4a. download() may reach the release and nothing else.
const dl = cliCode.slice(cliCode.indexOf("function download(d)"));
const dlBody = dl.slice(0, dl.indexOf("\n}\n") + 3);
check("download() fetches only from the release",
  /downloadReleaseAsset\(/.test(dlBody) && !/curl|fetch\(/.test(dlBody),
  "no upstream chain: the release, or a reported failure");

// 4b. Upstream addresses live only on fields named for showing, never fetching.
for (const rel of ["bin/amalgam.mjs", "lib/services.mjs", "lib/embed.mjs", "lib/graphpage.mjs", "lib/llm.mjs"]) {
  const bad = code(rel).split("\n").filter((l) => {
    if (!THIRD_PARTY.test(l) || !/https:\/\//.test(l)) return false;
    return !/\bmanualUrl\b|\bmanualMirrors\b|\bVIS_UPSTREAM\b/.test(l);
  });
  check(`${rel}: upstream addresses are shown, never fetched`, bad.length === 0,
    bad.length ? `unguarded: ${bad[0].trim().slice(0, 70)}` : "");
}

// 4c. Nothing may pass one of those display-only values to a fetcher.
for (const name of ["manualUrl", "manualMirrors", "VIS_UPSTREAM"]) {
  const misuse = new RegExp(`(fetch\\(|curl[^\\n]*)[^\\n]*\\b${name}\\b`);
  check(`${name} is never handed to a downloader`, !misuse.test(cliCode));
}

// --- 4b. the extractor is pinned, and cannot take the cloud pass -------------
// graphify ships several times a day. Unpinned, two machines building the same
// graph can disagree and a rebuild can change results for a reason nothing
// recorded — under a README that reports measured numbers.
{
  const graphMod = code("lib/graph.mjs");
  check("the graphify version is pinned",
    /export const GRAPHIFY_VERSION = "\d+\.\d+\.\d+"/.test(graphMod) &&
    /graphifyy\$\{extras\}==\$\{GRAPHIFY_VERSION\}/.test(graphMod),
    "an extractor that drifts underneath a measurement invalidates it");

  // Every invocation must resolve its package through graphifySpec(), so there
  // is one place a version lives and no call site can float.
  for (const rel of ["bin/amalgam.mjs", "mcp/server.mjs"]) {
    const bad = code(rel).split("\n").filter((l) => /"graphifyy"|'graphifyy'|graphifyy\[/.test(l));
    check(`${rel}: no unpinned graphifyy reference`, bad.length === 0,
      bad.length ? bad[0].trim().slice(0, 70) : "");
  }

  // --code-only keeps graphify on local tree-sitter parsing. Without it the
  // doc/image pass reaches a cloud backend — rule 4, enforced by a flag. The
  // flag is applied centrally so a call site cannot forget it; assert that the
  // central place still does it, and that nothing spawns graphify around it.
  check("extraction is forced local by graphifyArgs()",
    /export function graphifyArgs/.test(graphMod) && /--code-only/.test(graphMod),
    "the doc/image pass calls a cloud backend and must be unreachable");
  for (const rel of ["bin/amalgam.mjs", "mcp/server.mjs"]) {
    const spawns = code(rel).split("\n").filter((l) => /"graphify"/.test(l) && /spawn|spawnSync|"tool", "run"/.test(l));
    check(`${rel}: every graphify spawn goes through graphifyArgs()`,
      spawns.length > 0 && spawns.every((l) => l.includes("graphifyArgs(")),
      `${spawns.length} spawn(s) checked`);
  }
}

// --- 5. degrade, never fail --------------------------------------------------
check("embeddings are optional at runtime, not just at install",
  /export function embeddingsInstalled\(\)/.test(embed),
  "search must fall back to names when the model is absent");

console.log("");
if (failed) console.log(`${failed} constraint(s) violated`);
if (known) console.log(`${known} known gap(s) — recorded in docs/constraints.md, not yet closed`);
if (!failed && !known) console.log("all constraints hold");
process.exit(failed ? 1 : 0);
