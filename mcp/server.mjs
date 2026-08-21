#!/usr/bin/env node
/**
 * Amalgam MCP server — zero dependencies, plain Node.
 *
 * Bridges Claude Code to fully-local offload services:
 *   - PostgreSQL (portable) : L0..L3 layered memory (tencentdb concept)
 *   - llama.cpp + Qwen3-4B  : caveman compress/expand (caveman concept)
 *   - graphify via uv       : code knowledge graph queries (graphify concept)
 *
 * MCP stdio transport = newline-delimited JSON-RPC 2.0. Implemented by hand
 * so nothing needs to be installed.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import os from "node:os";
import { ensurePg, ensureLlama, pgBin, LLAMA_URL as SVC_LLAMA_URL } from "../lib/services.mjs";

// Machine-level home: runtimes, model, and data live here (shared by all
// projects on the machine). The package itself only carries code.
const ROOT = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
const PSQL = process.env.AMALGAM_PSQL ?? pgBin("psql");
const PG_PORT = process.env.AMALGAM_PG_PORT ?? "5455";
const PG_DB = process.env.AMALGAM_PG_DB ?? "amalgam";
const LLAMA_URL = process.env.AMALGAM_LLAMA_URL ?? "http://127.0.0.1:8642";
const SESSION_ID = process.env.AMALGAM_SESSION_ID ?? `s-${new Date().toISOString().slice(0, 10)}`;

// ---------------------------------------------------------------- psql bridge
/**
 * Run SQL, starting PostgreSQL on demand if it is not up. Sessions should
 * never fail just because the machine rebooted since the last one.
 */
async function psql(sql, vars = {}) {
  try {
    return await psqlOnce(sql, vars);
  } catch (e) {
    if (!/connection to server|could not connect|Connection refused|spawn failed/i.test(e.message)) throw e;
    if (!ensurePg()) {
      throw new Error(
        `PostgreSQL is not running and could not be started from ${ROOT}. Run 'amalgam install' if this machine has no runtime yet, else 'amalgam start'.`
      );
    }
    return await psqlOnce(sql, vars);
  }
}

function psqlOnce(sql, vars = {}) {
  return new Promise((resolve, reject) => {
    // SQL goes via stdin, not -c: psql only interpolates :'var' variables
    // when reading from stdin/file, never inside -c command strings.
    const args = ["-h", "127.0.0.1", "-p", PG_PORT, "-d", PG_DB, "-X", "-q", "-tA", "-F", "\t", "--no-psqlrc", "-v", "ON_ERROR_STOP=1"];
    for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${String(v)}`);
    const p = spawn(PSQL, args, { windowsHide: true });
    p.stdin.write(sql);
    p.stdin.end();
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`psql spawn failed: ${e.message}. Is PostgreSQL extracted at runtime/pgsql?`)));
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`psql exited ${code}: ${err.trim() || out.trim()}`));
      else resolve(out.replace(/\r/g, "").split("\n").filter((l) => l.length > 0).map((l) => l.split("\t")));
    });
  });
}

// ------------------------------------------------------------- llama bridge
async function llama(system, user, maxTokens = 2048) {
  // Lazy start: the model holds ~3.6 GB, so it loads on first actual use
  // rather than at session start. First call after a reboot pays the load.
  if (!(await ensureLlama())) {
    throw new Error(
      `Local model could not be started (expected llama-server + model under ${ROOT}). Run 'amalgam install' if this machine has no runtime yet.`
    );
  }
  let res;
  try {
    res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local",
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e) {
    throw new Error(`Local model unreachable at ${LLAMA_URL} (${e.message}). Run scripts/start-all.ps1 first.`);
  }
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

const COMPRESS_SYS =
  "You compress English into dense telegraphic 'caveman' text. Remove articles, filler, pleasantries, hedging, and predictable grammar. Keep EVERY fact, number, name, decision, and constraint. Code, file paths, commands, URLs, and error messages must stay byte-for-byte exact. Output ONLY the compressed text, nothing else.";
const EXPAND_SYS =
  "You expand dense telegraphic 'caveman' text into clear, natural English prose. Do not add information, opinions, or filler. Keep code, file paths, commands, URLs, and error messages byte-for-byte exact. Output ONLY the expanded text, nothing else.";

// ------------------------------------------------------------- graphify bridge
function graphify(repo, cliArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn("uv", ["tool", "run", "--from", "graphifyy", "graphify", ...cliArgs], {
      cwd: repo,
      windowsHide: true,
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`uv spawn failed: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`graphify exited ${code}: ${(err || out).slice(0, 1000)}`));
      else resolve(out.trim());
    });
  });
}

// ---------------------------------------------------------------- tool defs
const TOOLS = [
  {
    name: "memory_recall",
    description:
      "Search local long-term memory (PostgreSQL full-text, ranked). Returns distilled facts (L1), scenario docs (L2), and optionally raw log lines (L0). Stored content is caveman-dense; read it as-is, it costs few tokens. Use at task start to load context instead of re-asking the user or re-reading files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-language search terms" },
        limit: { type: "integer", default: 8, minimum: 1, maximum: 50 },
        include_raw: { type: "boolean", default: false, description: "Also search raw L0 conversation log" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save_fact",
    description:
      "Save one distilled fact/preference/decision/constraint/instruction to long-term memory (L1). Write it caveman-dense yourself (drop articles/filler, keep every fact and identifier exact). One fact per call.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fact", "preference", "decision", "constraint", "instruction"], default: "fact" },
        content: { type: "string", description: "Caveman-dense fact text" },
        context: { type: "string", default: "", description: "Project/topic tag, e.g. 'musescore'" },
        priority: { type: "integer", default: 50, minimum: 0, maximum: 100 },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_log",
    description:
      "Append raw conversation turns to the L0 log (audit trail / fallback search). Use sparingly for exchanges worth keeping verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } },
            required: ["role", "content"],
          },
          minItems: 1,
        },
        session_id: { type: "string" },
      },
      required: ["messages"],
    },
  },
  {
    name: "memory_context_write",
    description:
      "Create or overwrite a scenario document (L2) — durable project context: build steps, architecture notes, conventions, current plan. Write content caveman-dense. Path is virtual, e.g. 'musescore/build-notes'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        summary: { type: "string", default: "" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "memory_context_read",
    description: "Read one scenario document (L2) by path.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "memory_context_list",
    description: "List scenario documents (L2): path, summary, updated_at.",
    inputSchema: { type: "object", properties: { prefix: { type: "string", default: "" } } },
  },
  {
    name: "memory_persona_read",
    description: "Read the latest persona document (L3) — stable user preferences and working style. Load once at session start.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_persona_write",
    description: "Write a new persona version (L3). Read first, merge, then write the full replacement (caveman-dense).",
    inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "caveman_compress",
    description:
      "Offload to local model: compress verbose English into caveman-dense text (~40-60% fewer tokens, all facts kept). Use before storing bulky notes, or to shrink long docs you must carry in context.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "caveman_expand",
    description:
      "Offload to local model: expand caveman-dense text into clear plain English. Use when showing stored memory or your terse notes to the user in readable form.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "graph_query",
    description:
      "Query a repo's local code knowledge graph (graphify, tree-sitter, no LLM) instead of grepping/reading files. mode 'explain' = one symbol's connections; 'path' = how two symbols connect; 'query' = scoped subgraph for a plain question; 'build' = (re)build the graph for a repo (slow on big repos — run once). Requires graph built in the repo (graphify-out/).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute path to the repo" },
        mode: { type: "string", enum: ["explain", "path", "query", "build"] },
        a: { type: "string", description: "Symbol/question (explain: symbol; path: from; query: question; build: subdir or '.')" },
        b: { type: "string", description: "path mode only: to-symbol" },
      },
      required: ["repo", "mode"],
    },
  },
];

// ---------------------------------------------------------------- handlers
const esc = (s) => s; // psql -v handles quoting; values pass as variables

async function handleTool(name, args) {
  switch (name) {
    case "memory_recall": {
      const limit = Math.min(Math.max(args.limit ?? 8, 1), 50);
      const rows = await psql(
        `SELECT * FROM (
           SELECT 'L1'::text AS src, id::text AS ref, kind, context AS extra, content,
                  ts_rank(ts, websearch_to_tsquery('english', :'q')) AS rank
             FROM memory.l1_facts
            WHERE ts @@ websearch_to_tsquery('english', :'q')
           UNION ALL
           SELECT 'L2', path, 'scenario', summary, left(content, 1200),
                  ts_rank(ts, websearch_to_tsquery('english', :'q'))
             FROM memory.l2_scenarios
            WHERE ts @@ websearch_to_tsquery('english', :'q')
           ${args.include_raw ? `UNION ALL
           SELECT 'L0', id::text, role, session_id, content,
                  ts_rank(ts, websearch_to_tsquery('english', :'q'))
             FROM memory.l0_log
            WHERE ts @@ websearch_to_tsquery('english', :'q')` : ""}
         ) u ORDER BY rank DESC LIMIT ${limit};`,
        { q: esc(args.query) }
      );
      if (rows.length === 0) return "No memories matched.";
      return rows
        .map(([src, ref, kind, extra, content]) => `[${src}:${ref}] (${kind}${extra ? ` @${extra}` : ""}) ${content}`)
        .join("\n");
    }
    case "memory_save_fact": {
      const rows = await psql(
        `INSERT INTO memory.l1_facts (kind, content, context, priority)
         VALUES (:'kind', :'content', :'context', :'priority'::int)
         RETURNING id;`,
        {
          kind: args.kind ?? "fact",
          content: args.content,
          context: args.context ?? "",
          priority: String(args.priority ?? 50),
        }
      );
      return `Saved L1 fact id=${rows[0][0]}`;
    }
    case "memory_log": {
      let n = 0;
      for (const m of args.messages) {
        await psql(
          `INSERT INTO memory.l0_log (session_id, role, content) VALUES (:'sid', :'role', :'content');`,
          { sid: args.session_id ?? SESSION_ID, role: m.role, content: m.content }
        );
        n++;
      }
      return `Logged ${n} message(s) to L0 (session ${args.session_id ?? SESSION_ID}).`;
    }
    case "memory_context_write": {
      await psql(
        `INSERT INTO memory.l2_scenarios (path, content, summary)
         VALUES (:'path', :'content', :'summary')
         ON CONFLICT (path) DO UPDATE
           SET content = EXCLUDED.content, summary = EXCLUDED.summary,
               version = memory.l2_scenarios.version + 1, updated_at = now();`,
        { path: args.path, content: args.content, summary: args.summary ?? "" }
      );
      return `Wrote L2 scenario '${args.path}'.`;
    }
    case "memory_context_read": {
      const rows = await psql(`SELECT content FROM memory.l2_scenarios WHERE path = :'path';`, { path: args.path });
      return rows.length ? rows[0][0] : `No scenario at '${args.path}'.`;
    }
    case "memory_context_list": {
      const rows = await psql(
        `SELECT path, summary, to_char(updated_at, 'YYYY-MM-DD') FROM memory.l2_scenarios
          WHERE path LIKE :'prefix' || '%' ORDER BY path;`,
        { prefix: args.prefix ?? "" }
      );
      return rows.length ? rows.map((r) => r.join(" | ")).join("\n") : "No scenarios stored.";
    }
    case "memory_persona_read": {
      const rows = await psql(`SELECT content FROM memory.l3_persona ORDER BY id DESC LIMIT 1;`);
      return rows.length ? rows[0][0] : "No persona stored yet.";
    }
    case "memory_persona_write": {
      await psql(`INSERT INTO memory.l3_persona (content) VALUES (:'content');`, { content: args.content });
      return "Persona updated (new L3 version).";
    }
    case "caveman_compress":
      return await llama(COMPRESS_SYS, args.text, Math.max(256, Math.ceil(args.text.length / 2)));
    case "caveman_expand":
      return await llama(EXPAND_SYS, args.text, Math.max(512, args.text.length * 2));
    case "graph_query": {
      const repo = args.repo;
      if (!fs.existsSync(repo)) throw new Error(`Repo not found: ${repo}`);
      // --code-only: local tree-sitter AST only; the doc/image semantic pass
      // would call a cloud LLM backend, which this stack forbids.
      if (args.mode === "build") return await graphify(repo, [args.a ?? ".", "--code-only"]);
      if (args.mode === "explain") return await graphify(repo, ["explain", args.a]);
      if (args.mode === "path") return await graphify(repo, ["path", args.a, args.b]);
      return await graphify(repo, ["query", args.a]);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- MCP stdio
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) void handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore garbage
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "amalgam", version: "0.1.0" },
        },
      });
    } else if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
      // notifications get no response
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      try {
        const text = await handleTool(name, args ?? {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true } });
      }
    } else if (isRequest) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}
