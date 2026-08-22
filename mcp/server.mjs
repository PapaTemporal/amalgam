#!/usr/bin/env node
/**
 * Amalgam MCP server — zero dependencies, plain Node.
 *
 * Bridges Claude Code to fully-local offload services:
 *   - SQLite (node built-in) : L0..L3 layered memory (tencentdb concept)
 *   - llama.cpp + Qwen3-4B   : bulk digest / caveman translation (optional)
 *   - graphify via uv        : code knowledge graph queries (graphify concept)
 *
 * MCP stdio transport = newline-delimited JSON-RPC 2.0. Implemented by hand
 * so nothing needs to be installed.
 */
// Must come first — see lib/preflight.mjs.
import "../lib/preflight.mjs";

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import os from "node:os";
import { ensureLlama, modelInstalled } from "../lib/services.mjs";
import { open as openDb, ftsQuery, logUsage, DB_PATH } from "../lib/db.mjs";
import { embed, similarity, toBlob, fromBlob, embeddingsInstalled } from "../lib/embed.mjs";
import { verifyFact } from "../lib/verify.mjs";
import { createTask, addEvent, setState, listTasks, resume, renderResume } from "../lib/tasks.mjs";
import { loadGraph, hasGraph, findSymbols, sliceSymbol, callersOf, calleesOf,
         changedFiles, changedRanges, symbolsInRanges } from "../lib/graph.mjs";

// Machine-level home: runtimes, model, and data live here (shared by all
// projects on the machine). The package itself only carries code.
const ROOT = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
const LLAMA_URL = process.env.AMALGAM_LLAMA_URL ?? "http://127.0.0.1:8642";
const SESSION_ID = process.env.AMALGAM_SESSION_ID ?? `s-${new Date().toISOString().slice(0, 10)}`;

const db = () => openDb();

/**
 * Give any memory that lacks a vector one, in bounded batches so a large
 * backlog cannot stall a recall. Runs before semantic search; a store written
 * before embeddings were installed catches up on its own.
 */
async function backfillEmbeddings(d, batch = 32) {
  const missing = [
    ...d.prepare(`SELECT id, content, context FROM l1_facts WHERE embedding IS NULL LIMIT ?`).all(batch)
      .map((r) => ({ table: "l1", id: r.id, text: `${r.content} ${r.context}` })),
    // A scenario doc's path and summary describe it; its full body dilutes the
    // vector, so only its opening is included.
    ...d.prepare(`SELECT path, summary, substr(content, 1, 600) AS content FROM l2_scenarios WHERE embedding IS NULL LIMIT ?`).all(batch)
      .map((r) => ({ table: "l2", id: r.path, text: `${r.path}. ${r.summary}. ${r.content}` })),
  ];
  if (missing.length === 0) return 0;
  const vecs = await embed(missing.map((m) => m.text));
  if (!vecs) return 0;
  missing.forEach((m, i) => {
    if (!vecs[i]) return;
    if (m.table === "l1") d.prepare(`UPDATE l1_facts SET embedding = ? WHERE id = ?`).run(toBlob(vecs[i]), m.id);
    else d.prepare(`UPDATE l2_scenarios SET embedding = ? WHERE path = ?`).run(toBlob(vecs[i]), m.id);
  });
  return missing.length;
}

/**
 * Render one fact for recall. A fact whose last machine check failed is still
 * shown — it may be the only thing that answers the query — but it is shown
 * WITH that fact attached, so the reader discounts it instead of acting on it.
 */
function factLine(r) {
  const stale = r.verify_state === "stale" ? ` !stale: ${r.verify_note}` : "";
  return `[L1:${r.id}] (${r.kind}${r.context ? ` @${r.context}` : ""}${stale}) ${r.content}`;
}

/**
 * Facts close enough to a new one that they may be the thing it replaces.
 * Cheap: the vectors are already stored, so this is a dot product per row and
 * no model call. The threshold is deliberately high — a false candidate costs
 * the agent a moment's attention, and this is meant to be quiet.
 */
function supersedeCandidates(d, newId, vec, threshold = 0.86, max = 3) {
  if (!vec) return [];
  const out = [];
  for (const r of d.prepare(
    `SELECT id, content, embedding FROM l1_facts
      WHERE embedding IS NOT NULL AND superseded_by IS NULL AND id != ?`).all(newId)) {
    const score = similarity(vec, fromBlob(r.embedding));
    if (score >= threshold) out.push({ id: r.id, score, content: r.content });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/** Embed one record at write time; silently skipped when unavailable. */
async function embedRow(table, id, text) {
  if (!embeddingsInstalled()) return null;
  try {
    const [v] = (await embed(text)) ?? [];
    if (!v) return null;
    const d = db();
    if (table === "l1") d.prepare(`UPDATE l1_facts SET embedding = ? WHERE id = ?`).run(toBlob(v), id);
    else d.prepare(`UPDATE l2_scenarios SET embedding = ? WHERE path = ?`).run(toBlob(v), id);
    return v;
  } catch { return null; }
}

// ------------------------------------------------------------- llama bridge
async function llama(system, user, maxTokens = 2048) {
  // Lazy start: the model holds ~3.6 GB, so it loads on first actual use
  // rather than at session start. First call after a reboot pays the load.
  if (!(await ensureLlama())) {
    throw new Error(
      modelInstalled()
        ? `Local model is installed but llama-server would not start (check ${ROOT}\\runtime\\llama).`
        : `The optional local model is not installed on this machine, so this tool is unavailable. Install it with 'amalgam install --with-model' (~2.5 GB), or do this reduction yourself instead.`
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

// ------------------------------------------------------------- code evidence
const git = (repo, args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** One line naming a symbol and its immediate neighbourhood in the graph. */
function symbolHeader(g, n, sym, repo = null, cache = new Map()) {
  const inb = callersOf(g, n.id, repo, cache).map((c) => c.name);
  const out = calleesOf(g, n.id, repo, cache).map((c) => c.name);
  const bits = [`${sym.file}:${sym.line ?? "?"}  ${n.label}`];
  if (inb.length) bits.push(`called by: ${inb.slice(0, 6).join(", ")}${inb.length > 6 ? ` (+${inb.length - 6})` : ""}`);
  if (out.length) bits.push(`calls: ${out.slice(0, 6).join(", ")}${out.length > 6 ? ` (+${out.length - 6})` : ""}`);
  return bits.join("  |  ");
}

/**
 * How far behind the working tree the graph has fallen. Reported rather than
 * hidden: selection quality degrades with staleness even though the quoted
 * text is always current, and an agent should know which it is looking at.
 */
function graphDrift(repo, g) {
  if (!g.builtAt) return "";
  const changed = changedFiles(repo, g.builtAt, git);
  if (!changed || changed.length === 0) return "";
  return `graph built at ${String(g.builtAt).slice(0, 8)}; ${changed.length} file(s) changed since, so selection may miss recent symbols`;
}

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
      "Search local long-term memory by meaning and by keyword (local embeddings + BM25). Finds relevant memories even when your wording shares no words with them. Returns distilled facts (L1), scenario docs (L2), and optionally raw log lines (L0). Stored content is dense; read it as-is, it costs few tokens. Use at task start to load context instead of re-asking the user or re-reading files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-language search terms" },
        limit: { type: "integer", default: 8, minimum: 1, maximum: 50 },
        include_raw: { type: "boolean", default: false, description: "Also search raw L0 conversation log" },
        include_superseded: { type: "boolean", default: false, description: "Also return facts that a later fact replaced (history; off by default)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_supersede",
    description:
      "Mark older facts as replaced by a newer one. Use when a fact you just saved corrects or updates something already stored — the old rows stay as history but stop appearing in recall, so the mistake and its correction are not both paid for in context. memory_save_fact reports likely candidates.",
    inputSchema: {
      type: "object",
      properties: {
        new_id: { type: "integer", description: "The fact that replaces the others" },
        old_ids: { type: "array", items: { type: "integer" }, description: "Fact ids now superseded" },
      },
      required: ["new_id", "old_ids"],
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
        context: { type: "string", default: "", description: "Project/topic tag, e.g. 'api-server'" },
        priority: { type: "integer", default: 50, minimum: 0, maximum: 100 },
        task_id: { type: "integer", description: "Work item this was learned during (see task_start); lets a resumed task recover it" },
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
      "Create or overwrite a scenario document (L2) — durable project context: build steps, architecture notes, conventions, current plan. Write content caveman-dense. Path is virtual, e.g. 'api-server/build-notes'.",
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
    name: "digest",
    description:
      "Read a large file or run a command and return only a dense factual digest — the raw text never enters your context. Use for long logs, specs, dumps, or verbose command output you would otherwise read in full. Requires the optional local model.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to a file to digest" },
        command: { type: "string", description: "Shell command whose output should be digested (alternative to file)" },
        focus: { type: "string", description: "Optional: what to pay attention to, e.g. 'errors and their causes'" },
      },
    },
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
  {
    name: "task_start",
    description:
      "Open a work item that ties a piece of work to its repo, branch, work stream and story. Cheap and worth doing for anything spanning more than one exchange: notes and facts recorded against it make 'where was I' a lookup instead of an investigation next session. Returns the task id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        repo: { type: "string" }, branch: { type: "string" },
        stream: { type: "string" }, story: { type: "string", description: "Story/issue id this implements, if any" },
      },
      required: ["title"],
    },
  },
  {
    name: "task_note",
    description:
      "Record one thing that happened on a work item: a decision and why, a blocker, a test result, a commit. Append-only. What was already tried is usually the expensive thing to rediscover.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        kind: { type: "string", enum: ["note", "decision", "blocker", "test", "commit", "state"], default: "note" },
        detail: { type: "string" },
      },
      required: ["task_id", "detail"],
    },
  },
  {
    name: "task_resume",
    description:
      "Pick work back up: with an id, the item's full history — where it lives, what was decided, what broke, and the facts learned during it. Without one, the open items, most recently touched first. Call this before asking the user what they were doing.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        repo: { type: "string", description: "Filter the list to one repo" },
        state: { type: "string", enum: ["open", "done", "all"], default: "open" },
      },
    },
  },
  {
    name: "task_done",
    description: "Close a work item. Its history stays readable; it stops appearing in the open list.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "integer" }, outcome: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "code_context",
    description:
      "Assemble an evidence packet for a task from a repo's code graph: the symbols that matter, who calls them, what they call, and their CURRENT source lines read from disk. Use this INSTEAD of reading whole files when you need to understand or change existing code — it returns the few hundred tokens that bear on the task rather than the few thousand that surround them. Requires a built graph (amalgam graph).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute path to the repo" },
        task: { type: "string", description: "Plain-language description of what you are about to do, or a symbol name" },
        max_symbols: { type: "integer", default: 5, minimum: 1, maximum: 15 },
        lines: { type: "integer", default: 14, minimum: 4, maximum: 60, description: "Source lines per symbol" },
      },
      required: ["repo", "task"],
    },
  },
  {
    name: "graph_impact",
    description:
      "Blast radius of a change: which symbols the diff actually touched, and everything that calls them, from the code graph. Use before reviewing or extending a change instead of grepping for callers. Defaults to uncommitted work; pass a revision to compare against something else.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute path to the repo" },
        rev: { type: "string", default: "HEAD", description: "Revision to diff against (default HEAD = uncommitted changes)" },
        max_symbols: { type: "integer", default: 20, minimum: 1, maximum: 100 },
      },
      required: ["repo"],
    },
  },
];

// ---------------------------------------------------------------- handlers
const esc = (s) => s; // psql -v handles quoting; values pass as variables

async function handleTool(name, args) {
  switch (name) {
    case "memory_recall": {
      const limit = Math.min(Math.max(args.limit ?? 8, 1), 50);
      const d = db();
      // A fact that a later fact replaced is history, not an answer. Paying
      // context for both the mistake and its correction is the expensive way
      // to be right, and ranking can put them in either order.
      const supersededFilter = args.include_superseded ? "" : " AND superseded_by IS NULL";

      // --- keyword leg (BM25) ---
      const q = ftsQuery(args.query);
      const keyword = [];
      if (q) {
        for (const r of d.prepare(
          `SELECT f.id, f.kind, f.context, f.content, f.verify_state, f.verify_note, bm25(l1_fts) AS rank
             FROM l1_fts JOIN l1_facts f ON f.id = l1_fts.rowid
            WHERE l1_fts MATCH ?${supersededFilter.replace(/superseded_by/, 'f.superseded_by')} ORDER BY rank LIMIT ?`).all(q, limit * 2)) {
          keyword.push({ key: `L1:${r.id}`, line: factLine(r) });
        }
        for (const r of d.prepare(
          `SELECT path, summary, substr(content, 1, 1200) AS content, bm25(l2_fts) AS rank
             FROM l2_fts WHERE l2_fts MATCH ? ORDER BY rank LIMIT ?`).all(q, limit * 2)) {
          keyword.push({ key: `L2:${r.path}`, line: `[L2:${r.path}] (scenario${r.summary ? ` @${r.summary}` : ""}) ${r.content}` });
        }
        if (args.include_raw) {
          for (const r of d.prepare(
            `SELECT g.id, g.role, g.session_id, g.content, bm25(l0_fts) AS rank
               FROM l0_fts JOIN l0_log g ON g.id = l0_fts.rowid
              WHERE l0_fts MATCH ? ORDER BY rank LIMIT ?`).all(q, limit * 2)) {
            keyword.push({ key: `L0:${r.id}`, line: `[L0:${r.id}] (${r.role} @${r.session_id}) ${r.content}` });
          }
        }
      }

      // --- semantic leg (embeddings), when the small model is installed ---
      let semantic = [];
      let semanticUsed = false;
      if (embeddingsInstalled()) {
        try {
          await backfillEmbeddings(d);
          const [qv] = (await embed(args.query, { query: true })) ?? [];
          if (qv) {
            semanticUsed = true;
            const scored = [];
            for (const r of d.prepare(
              `SELECT id, kind, context, content, verify_state, verify_note, embedding
                 FROM l1_facts WHERE embedding IS NOT NULL${supersededFilter}`).all()) {
              scored.push({
                score: similarity(qv, fromBlob(r.embedding)),
                key: `L1:${r.id}`,
                line: factLine(r),
              });
            }
            for (const r of d.prepare(
              `SELECT path, summary, substr(content,1,1200) AS content, embedding FROM l2_scenarios WHERE embedding IS NOT NULL`).all()) {
              scored.push({
                score: similarity(qv, fromBlob(r.embedding)),
                key: `L2:${r.path}`,
                line: `[L2:${r.path}] (scenario${r.summary ? ` @${r.summary}` : ""}) ${r.content}`,
              });
            }
            semantic = scored.sort((a, b) => b.score - a.score).slice(0, limit * 2);
          }
        } catch {
          // Semantic recall is an enhancement; keyword results still stand.
        }
      }

      if (keyword.length === 0 && semantic.length === 0) return "No memories matched.";

      // Combining the two legs: cosine similarity is a calibrated score, while
      // keyword rank is not, so when embeddings are available semantic decides
      // the order and keyword only contributes candidates semantic missed
      // (exact identifiers, paths, commands). Rank fusion was tried first and
      // was worse here: a memory matching one common word landed in both lists
      // and outranked the correct answer. No tuning constants, which also
      // means nothing overfitted to a handful of test queries.
      const seen = new Set();
      const ordered = [];
      for (const s of semantic) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        ordered.push(s.line);
      }
      for (const k of keyword) {
        if (seen.has(k.key)) continue;
        seen.add(k.key);
        ordered.push(k.line);
      }
      const out = ordered.slice(0, limit).join("\n");
      logUsage("memory_recall", String(args.query).length, out.length);
      return semanticUsed ? out : out + "\n\n(keyword search only — install semantic recall with `amalgam install --with-embeddings`)";
    }
    case "memory_save_fact": {
      const d = db();
      // Check the fact's own anchors as it is written. Catching a dead path
      // now costs nothing; discovering it mid-task months later is expensive.
      const v = verifyFact(args.content);
      const info = d.prepare(
        `INSERT INTO l1_facts (kind, content, context, priority, verify_state, verify_note, verified_at, task_id)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      ).run(args.kind ?? "fact", args.content, args.context ?? "", args.priority ?? 50, v.state, v.note,
            args.task_id ? Number(args.task_id) : null);
      const id = Number(info.lastInsertRowid);
      const vec = await embedRow("l1", id, `${args.content} ${args.context ?? ""}`);

      const out = [`Saved L1 fact id=${id}`];
      if (v.state === "stale") out.push(`Careful: ${v.note} — this fact names a path that does not exist here.`);
      const near = supersedeCandidates(d, id, vec);
      if (near.length) {
        out.push(`Close to existing memories, which this may replace:`);
        for (const c of near) out.push(`  L1:${c.id} (${c.score.toFixed(2)}) ${c.content.slice(0, 90)}${c.content.length > 90 ? "…" : ""}`);
        out.push(`If it does, call memory_supersede { new_id: ${id}, old_ids: [...] } so recall stops returning both.`);
      }
      return out.join("\n");
    }
    case "memory_supersede": {
      const d = db();
      const newId = Number(args.new_id);
      if (!d.prepare(`SELECT 1 FROM l1_facts WHERE id = ?`).get(newId)) return `No fact id=${newId}.`;
      const stmt = d.prepare(
        `UPDATE l1_facts SET superseded_by = ?, superseded_at = datetime('now')
          WHERE id = ? AND id != ? AND superseded_by IS NULL`);
      let n = 0;
      for (const raw of args.old_ids ?? []) n += Number(stmt.run(newId, Number(raw), newId).changes);
      return `Superseded ${n} fact(s) by L1:${newId}. They remain as history; recall no longer returns them.`;
    }
    case "memory_log": {
      const stmt = db().prepare(`INSERT INTO l0_log (session_id, role, content) VALUES (?, ?, ?)`);
      for (const m of args.messages) stmt.run(args.session_id ?? SESSION_ID, m.role, m.content);
      return `Logged ${args.messages.length} message(s) to L0 (session ${args.session_id ?? SESSION_ID}).`;
    }
    case "memory_context_write": {
      const d = db();
      d.prepare(
        `INSERT INTO l2_scenarios (path, content, summary) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content = excluded.content, summary = excluded.summary,
           version = version + 1, updated_at = datetime('now')`
      ).run(args.path, args.content, args.summary ?? "");
      // l2_fts is a standalone FTS table (path is the key, not a rowid), so
      // keep it in step explicitly rather than with triggers.
      d.prepare(`DELETE FROM l2_fts WHERE path = ?`).run(args.path);
      d.prepare(`INSERT INTO l2_fts (path, summary, content) VALUES (?, ?, ?)`)
        .run(args.path, args.summary ?? "", args.content);
      await embedRow("l2", args.path, `${args.path}. ${args.summary ?? ""}. ${String(args.content).slice(0, 600)}`);
      return `Wrote L2 scenario '${args.path}'.`;
    }
    case "memory_context_read": {
      const r = db().prepare(`SELECT content FROM l2_scenarios WHERE path = ?`).get(args.path);
      return r ? r.content : `No scenario at '${args.path}'.`;
    }
    case "memory_context_list": {
      const rows = db().prepare(
        `SELECT path, summary, substr(updated_at, 1, 10) AS updated FROM l2_scenarios
          WHERE path LIKE ? ORDER BY path`).all((args.prefix ?? "") + "%");
      return rows.length ? rows.map((r) => `${r.path} | ${r.summary} | ${r.updated}`).join("\n") : "No scenarios stored.";
    }
    case "memory_persona_read": {
      const r = db().prepare(`SELECT content FROM l3_persona ORDER BY id DESC LIMIT 1`).get();
      return r ? r.content : "No persona stored yet.";
    }
    case "memory_persona_write": {
      db().prepare(`INSERT INTO l3_persona (content) VALUES (?)`).run(args.content);
      return "Persona updated (new L3 version).";
    }
    case "caveman_compress": {
      const out = await llama(COMPRESS_SYS, args.text, Math.max(256, Math.ceil(args.text.length / 2)));
      logUsage("caveman_compress", args.text.length, out.length);
      return out;
    }
    case "caveman_expand":
      return await llama(EXPAND_SYS, args.text, Math.max(512, args.text.length * 2));
    case "digest": {
      // The one shape where a local model genuinely saves frontier context:
      // bulk text is read and reduced HERE, so only the digest is returned and
      // the raw content never enters the caller's context.
      let text, source;
      if (args.file) {
        source = args.file;
        if (!fs.existsSync(args.file)) throw new Error(`File not found: ${args.file}`);
        text = fs.readFileSync(args.file, "utf8");
      } else if (args.command) {
        source = `$ ${args.command}`;
        const r = spawn(process.env.ComSpec || "cmd.exe", ["/c", args.command], { windowsHide: true });
        text = await new Promise((resolve, reject) => {
          let o = "";
          r.stdout.on("data", (d) => (o += d));
          r.stderr.on("data", (d) => (o += d));
          r.on("error", reject);
          r.on("close", () => resolve(o));
        });
      } else {
        throw new Error("digest needs either `file` or `command`");
      }
      // Input larger than the model's context is the normal case here — that
      // is the reason to digest at all — so map/reduce it: digest each chunk,
      // then digest the combined digests until the result fits in one pass.
      // Chunk sized to leave room for the answer inside an 8k-token context.
      const CHUNK = 18000;
      const focus = args.focus ? `\nFocus on: ${args.focus}` : "";
      const SYS = `You reduce bulk text to a dense factual digest. Keep every concrete fact, name, number, path, command, and error verbatim. Drop narration and repetition. Output only the digest as terse lines.${focus}`;

      const digestOnce = async (s) => llama(SYS, s, 1200);
      const chunk = (s) => {
        const parts = [];
        for (let i = 0; i < s.length; i += CHUNK) parts.push(s.slice(i, i + CHUNK));
        return parts;
      };

      let level = text;
      let passes = 0;
      while (level.length > CHUNK && passes < 3) {
        const parts = chunk(level);
        const digested = [];
        for (const p of parts) digested.push(await digestOnce(p));
        level = digested.join("\n");
        passes++;
      }
      const out = level.length === text.length ? await digestOnce(level) : (level.length > CHUNK ? level : await digestOnce(level));

      logUsage("digest", text.length, out.length);
      const pct = text.length ? Math.round((1 - out.length / text.length) * 100) : 0;
      return `Digest of ${source} (${text.length} chars -> ${out.length}, ${pct}% smaller${passes ? `, ${passes} reduction pass(es)` : ""}):\n\n${out}`;
    }
    case "graph_query": {
      const repo = args.repo;
      if (!fs.existsSync(repo)) throw new Error(`Repo not found: ${repo}`);
      // --code-only: local tree-sitter AST only; the doc/image semantic pass
      // would call a cloud LLM backend, which this stack forbids.
      if (args.mode === "build") return await graphify(repo, [args.a ?? ".", "--code-only"]);
      const out = args.mode === "explain" ? await graphify(repo, ["explain", args.a])
        : args.mode === "path" ? await graphify(repo, ["path", args.a, args.b])
          : await graphify(repo, ["query", args.a]);
      logUsage("graph_query", String(args.a ?? "").length, out.length);
      return out;
    }
    case "task_start": {
      const id = createTask({
        title: args.title, repo: args.repo ?? "", branch: args.branch ?? "",
        stream: args.stream ?? "", story: args.story ?? "",
      });
      return `Opened task ${id}: ${args.title}
Record what happens with task_note, and save durable facts with memory_save_fact { task_id: ${id} }.`;
    }
    case "task_note": {
      addEvent(args.task_id, args.kind ?? "note", args.detail);
      return `Noted on task ${args.task_id}.`;
    }
    case "task_done": {
      if (args.outcome) addEvent(args.task_id, "state", args.outcome);
      setState(args.task_id, "done");
      return `Task ${args.task_id} closed. Its history stays readable via task_resume.`;
    }
    case "task_resume": {
      if (args.task_id) {
        const out = renderResume(resume(args.task_id));
        logUsage("task_resume", 0, out.length);
        return out;
      }
      const rows = listTasks({ repo: args.repo ?? "", state: args.state ?? "open" });
      if (!rows.length) return "No open work items.";
      const out = rows.map((t) =>
        `task ${t.id} [${t.state}] ${t.title}` +
        `${t.repo ? ` — ${t.repo}` : ""}${t.branch ? ` @${t.branch}` : ""}${t.story ? ` (story ${t.story})` : ""}` +
        `  last touched ${t.updated_at}`).join("\n");
      logUsage("task_resume", 0, out.length);
      return out;
    }
    case "code_context": {
      const repo = args.repo;
      if (!fs.existsSync(repo)) throw new Error(`Repo not found: ${repo}`);
      if (!hasGraph(repo)) throw new Error(`No code graph in ${repo}. Build one with 'amalgam graph' (or graph_query mode=build).`);
      const g = loadGraph(repo);
      const found = findSymbols(g, args.task, Math.min(Math.max(args.max_symbols ?? 5, 1), 15));
      if (!found.length) return `No symbol in the graph matches "${args.task}". Try naming a function, or fall back to a file read.`;

      const lines = Math.min(Math.max(args.lines ?? 14, 4), 60);
      const parts = [];
      const drift = graphDrift(repo, g);
      if (drift) parts.push(`(${drift})`);
      const siteCache = new Map();
      for (const n of found) {
        const sym = sliceSymbol(repo, n, lines);
        parts.push(`--- ${symbolHeader(g, n, sym, repo, siteCache)}`);
        if (sym.missing) parts.push(`    [${sym.missing} — the graph is behind the tree here]`);
        else {
          if (sym.moved) parts.push(`    [moved since the graph was built; located by name]`);
          parts.push(sym.text);
        }
      }
      const out = parts.join("\n");
      // The counterfactual is knowable here, so measure it: without a packet
      // the agent would have read the files these symbols live in.
      const baseline = [...new Set(found.map((n) => n.file))]
        .reduce((sum, f) => sum + (fs.existsSync(path.join(repo, f)) ? fs.statSync(path.join(repo, f)).size : 0), 0);
      logUsage("code_context", String(args.task).length, out.length, baseline);
      return out;
    }
    case "graph_impact": {
      const repo = args.repo;
      if (!fs.existsSync(repo)) throw new Error(`Repo not found: ${repo}`);
      if (!hasGraph(repo)) throw new Error(`No code graph in ${repo}. Build one with 'amalgam graph'.`);
      const rev = args.rev ?? "HEAD";
      const g = loadGraph(repo);
      const ranges = changedRanges(repo, rev, git);
      if (ranges.size === 0) return `No changes against ${rev}.`;

      // Most-depended-on first, and capped: a large diff otherwise returns a
      // wall of symbols, which is the file-reading problem in another costume.
      const all = symbolsInRanges(g, ranges)
        .sort((a, b) => (g.callers.get(b.id) ?? []).length - (g.callers.get(a.id) ?? []).length);
      const cap = Math.min(Math.max(args.max_symbols ?? 20, 1), 100);
      const touched = all.slice(0, cap);
      const files = [...ranges.keys()];
      const parts = [`changed vs ${rev}: ${files.length} file(s), ${all.length} symbol(s) in the graph`
        + (all.length > touched.length ? ` — showing the ${touched.length} most depended on` : "")];

      // Files the graph knows nothing about are the honest gap in this answer:
      // new files are not in a graph built before they existed.
      const known = new Set([...g.nodes.values()].map((n) => n.file.split("\\").join("/")));
      const unknown = files.filter((f) => !known.has(f));
      if (unknown.length) parts.push(`not in the graph (new or unindexed): ${unknown.join(", ")}`);

      const siteCache = new Map();
      let dropped = 0;
      for (const n of touched) {
        const inb = callersOf(g, n.id, repo, siteCache);
        dropped += inb.rejected ?? 0;
        parts.push(`--- ${n.file}:${n.line} ${n.label}`);
        parts.push(inb.length
          ? `    called by: ${inb.map((c) => `${c.name} (${c.file}:${c.line})`).join(", ")}`
          : `    no callers in the graph — entry point, or reached dynamically`);
      }
      const out = parts.join("\n");
      const baseline = files.reduce((sum, f) => sum + (fs.existsSync(path.join(repo, f)) ? fs.statSync(path.join(repo, f)).size : 0), 0);
      logUsage("graph_impact", rev.length, out.length, baseline);
      if (dropped) return `${out}\n(${dropped} edge(s) the source did not confirm were left out — shadowed names or calls that no longer exist)`;
      return out;
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
