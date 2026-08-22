/**
 * The local model, as a shared station.
 *
 * Lifted out of the MCP server once a second caller appeared: retrieval wants
 * to spend a second of local compute turning a question into the vocabulary a
 * codebase actually uses, which is precisely the trade this project exists to
 * make — local compute instead of frontier context.
 *
 * Everything here is optional. The model is a 2.5 GB download nobody is
 * obliged to take, so callers are expected to check `modelInstalled()` and
 * carry on without it rather than treat its absence as an error.
 */
import { ensureLlama, modelInstalled, touchLlamaUse } from "./services.mjs";

const LLAMA_URL = process.env.AMALGAM_LLAMA_URL ?? "http://127.0.0.1:8642";

export async function llama(system, user, maxTokens = 2048) {
  // Lazy start: the model holds ~3.6 GB, so it loads on first actual use
  // rather than at session start. First call after a reboot pays the load.
  if (!(await ensureLlama())) {
    throw new Error(
      modelInstalled()
        ? `Local model is installed but llama-server would not start (check the runtime under AMALGAM_HOME).`
        : `The optional local model is not installed on this machine, so this tool is unavailable. Install it with 'amalgam install --with-model' (~2.5 GB), or do this reduction yourself instead.`
    );
  }
  // Stamped before the request as well as after it. The idle watchdog reads
  // this file to decide when the model has stopped earning its memory, and a
  // stamp written only on completion means a call in flight looks idle for as
  // long as it runs — so a slow generation could have the server shot out from
  // under it, and the caller would see "unreachable" for no reason it could
  // act on.
  touchLlamaUse();
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
    throw new Error(`Local model unreachable at ${LLAMA_URL} (${e.message}). Check 'amalgam status'.`);
  }
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  // Records that the model earned its memory just now; the idle watchdog reads
  // this to decide when it has stopped earning it.
  touchLlamaUse();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

const EXPAND_SYS =
  "You translate a question about a codebase into the words that codebase probably uses. " +
  "Reply with 8 to 12 candidates, comma-separated, nothing else: likely identifier names in camelCase " +
  "(e.g. parseToken, validateSession) plus a few plain technical keywords. No sentences, no explanation, no numbering.";

const RERANK_SYS =
  "You are given a question about a codebase and a numbered list of candidate symbols, each with its file " +
  "and a short description. Choose the entries that best answer the question. " +
  "Reply with up to 4 numbers from the list, best first, comma-separated. Numbers only — no words, no explanation. " +
  "If nothing fits, reply with the single word NONE.";

/**
 * Re-rank candidates with the local model.
 *
 * Query expansion was tried first and did not work: asked to guess the words a
 * codebase uses, the model produces plausible generic names — auditLog,
 * vectorCache — because it has never seen this codebase. Handing it the actual
 * candidates removes the guessing. It no longer has to invent the vocabulary,
 * only to judge which of these twenty things answers the question, which is
 * the kind of reading a small model does well.
 *
 * Retrieval stays in charge of what is possible; this only reorders. A model
 * that returns nonsense, times out, or is not installed leaves the original
 * order untouched.
 */
export async function rerankSymbols(task, candidates, { keep = 4, trust = 2 } = {}) {
  if (!modelInstalled() || candidates.length <= trust + 1) return null;
  // The first few hits are left exactly where retrieval put them. Measured on
  // this repo, letting the model reorder everything traded precision for
  // recall — it rescued good answers from the tail while demoting others that
  // were already first. Retrieval's strongest signal is worth more than the
  // model's judgement; its weakest is worth less. So the top few are fixed and
  // the model only competes for the places below them.
  const head = candidates.slice(0, trust);
  const tail = candidates.slice(trust);
  const list = tail.map((c, i) => {
    const about = (c.doc || c.context || "").replace(/\s+/g, " ").slice(0, 110);
    return `${i + 1}. ${c.label || c.name} — ${c.file}${about ? ` — ${about}` : ""}`;
  }).join("\n");
  try {
    const out = await llama(RERANK_SYS, `Question: ${task}\n\nCandidates:\n${list}`, 40);
    if (/^\s*NONE\b/i.test(out)) return null;
    const picked = [...out.matchAll(/\d+/g)]
      .map((m) => Number(m[0]) - 1)
      .filter((i) => i >= 0 && i < tail.length);
    if (!picked.length) return null;
    const seen = new Set();
    const promoted = [];
    for (const i of picked.slice(0, keep)) {
      if (seen.has(i)) continue;
      seen.add(i);
      promoted.push(tail[i]);
    }
    const rest = tail.filter((_, i) => !seen.has(i));
    return [...head, ...promoted, ...rest];
  } catch {
    return null;
  }
}

/**
 * Guess the vocabulary a question is really about.
 *
 * Embedding a question directly asks a general-purpose model to bridge, in one
 * hop, from how a person describes a problem to how a programmer named the
 * solution. That hop is where retrieval loses things: nobody calls it "where
 * the text of a function is read from", they call it `sliceSymbol`. A small
 * local model is good at exactly this guess, and its output is used only as
 * search terms — a wrong guess costs a little ranking noise, never a wrong
 * answer, because the source still decides what comes back.
 *
 * Returns an empty list when no model is installed, so callers can treat
 * expansion as a bonus rather than a dependency.
 */
export async function expandQuery(task, { max = 12 } = {}) {
  if (!modelInstalled()) return [];
  try {
    const out = await llama(EXPAND_SYS, String(task), 120);
    return [...new Set(
      out.split(/[,\n]/)
        .map((t) => t.trim().replace(/^[-*\d.\s]+/, "").replace(/[`'".]/g, ""))
        .filter((t) => t && t.length > 2 && t.length < 40 && !t.includes(" ")),
    )].slice(0, max);
  } catch {
    return [];
  }
}
