/**
 * Running a build or a test suite without its output entering the agent's
 * context.
 *
 * This is the most reliably wasteful exchange in agentic development: a
 * command produces two thousand lines, of which nine matter, and all two
 * thousand are pasted into the conversation so the model can find the nine. It
 * happens several times per task, and it is paid for at frontier prices.
 *
 * `digest` already reduces bulk text, but it is the wrong instrument here for
 * two reasons. It needs the optional local model, and compilers and test
 * runners announce their failures in formats that a regular expression reads
 * perfectly — a model asked to summarise them can only lose fidelity. So this
 * is the deterministic tier of the same ladder: extract what failed, exactly
 * as written, and report what was withheld. The model is a fallback for
 * output nothing recognised, and the frontier model sees neither.
 *
 * Fidelity is the whole point. Every line reported is byte-for-byte from the
 * command, never paraphrased: an error message with the wrong line number in
 * it is worse than no error message, because it sends someone to the wrong
 * place with confidence.
 */
import { spawn } from "node:child_process";

/**
 * Lines that mean something went wrong, across the toolchains this is likely
 * to meet. Being over-inclusive is the right bias: a false positive costs one
 * line of context, a false negative costs the whole point of the exercise.
 */
const FAILURE_PATTERNS = [
  /^\s*(FAIL|FAILED|ERROR|ERR!)\b/i,                    // generic, npm, jest
  /\b(FAILED|ERRORED)\b/,                               // pytest, tox: verdict at line end
  /\berror(\s+TS\d+)?\s*:/i,                            // tsc, gcc, clang, generic
  /^error\[E\d+\]/,                                     // rust
  /^\s*[✕×✗]\s/u,                                       // vitest, jest, mocha
  /^\s*\d+\)\s+\S/,                                     // mocha numbered failures
  /\bAssertionError\b|^\s*assert\b/i,                   // python, node
  /^Traceback \(most recent call last\)/,               // python
  /^\s*panic:/,                                         // go
  /^\s*--- FAIL:/,                                      // go test
  /\bundefined reference\b|\bsegmentation fault\b/i,    // linkers, crashes
  /^\s*at .*\(.*:\d+:\d+\)/,                            // stack frames
  /\bCMake Error\b|\bmake(\[\d+\])?: \*\*\*/,           // cmake, make
];

/** Lines that summarise a run — worth keeping even when nothing failed. */
const SUMMARY_PATTERNS = [
  /^\s*Tests?:\s+.*\b(failed|passed)\b/i,
  /\b\d+\s+(passing|failing|passed|failed|errors?)\b/i,
  /^test result:/,                                      // cargo
  /^=+.*\b(failed|passed|error)\b.*=+$/i,               // pytest
  /^\s*Suites?:\s+/i,
  /\ball checks passed\b|\b\d+\/\d+ passed\b/i,
];

const matches = (line, patterns) => patterns.some((p) => p.test(line));

/**
 * Pick the interesting lines out of command output.
 *
 * Failures come with a little following context, because the message and the
 * location are usually on different lines and separating them helps nobody.
 */
export function extract(output, { maxFailures = 25, contextLines = 2 } = {}) {
  const lines = output.split(/\r?\n/);
  const keep = new Map();          // index -> reason, so context never duplicates
  let failures = 0;

  lines.forEach((line, i) => {
    if (matches(line, FAILURE_PATTERNS)) {
      if (++failures > maxFailures) return;
      keep.set(i, "failure");
      // Only lines that read as part of the failure. stdout and stderr are
      // merged into one buffer and do not interleave in source order, so "the
      // next two lines" can easily be unrelated progress chatter from the
      // other stream. A continuation of an error is indented, or carries a
      // file position — anything else is somebody else talking.
      for (let j = i + 1; j <= i + contextLines && j < lines.length; j++) {
        const next = lines[j];
        if (keep.has(j) || !next.trim()) continue;
        if (/^\s/.test(next) || /:\d+([:)]|$)/.test(next)) keep.set(j, "context");
      }
    } else if (matches(line, SUMMARY_PATTERNS)) {
      keep.set(i, "summary");
    }
  });

  const picked = [...keep.keys()].sort((a, b) => a - b).map((i) => lines[i]);
  return {
    lines: picked,
    failures,
    truncated: Math.max(failures - maxFailures, 0),
    recognised: keep.size > 0,
    totalLines: lines.length,
  };
}

/**
 * End a command and everything it started.
 *
 * Windows has no process groups to signal, so the tree is taken down by pid
 * with taskkill; elsewhere the child was made a group leader, and negating the
 * pid signals the group. Both are best-effort: a process that ignores the
 * signal is beyond this function's remit, and the caller has already been told
 * the run timed out.
 */
function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** Run a command, capturing everything it says without printing any of it. */
export function run(command, { cwd = process.cwd(), timeoutMs = 600000, shell = true } = {}) {
  return new Promise((resolve) => {
    // `shell: true` rather than invoking ComSpec with an argument array: on
    // Windows, Node re-escapes array arguments, so a command containing quotes
    // — `node "C:\path with spaces\x.mjs"` — arrives at cmd.exe with the
    // quoting rearranged and fails to resolve. Letting Node build the shell
    // invocation keeps the command line intact on both platforms.
    const child = spawn(command, {
      cwd, windowsHide: true, shell,
      // A process group, so a timeout can take the whole tree down. Killing
      // the shell alone leaves the thing it started running, which is exactly
      // the case a timeout exists for: `npm test` hanging is really the test
      // runner hanging, two processes below the one we hold a handle to.
      detached: process.platform !== "win32",
    });
    // The two streams are kept apart. Merged into one buffer they interleave
    // by arrival rather than by source, so a failure written to stderr can end
    // up hundreds of lines from its own continuation — which then reads as an
    // error with no detail, and unrelated progress chatter as its detail.
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, killed });
    });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed }); });
  });
}

/**
 * Run a check and return only what a reader needs.
 *
 * The exit code leads, because it is the one fact that is never ambiguous and
 * the one a summary of the text can get wrong. Then the failures verbatim, then
 * an honest account of how much was withheld — so the reader can ask for more
 * rather than assuming they saw everything.
 */
export async function check(command, { cwd, maxFailures = 25, timeoutMs, shell } = {}) {
  const started = Date.now();
  const { code, stdout, stderr, killed } = await run(command, { cwd, timeoutMs, shell });

  // Each stream is read on its own, so adjacency means what it should, and
  // stderr goes first because that is where a failing command usually explains
  // itself.
  const errSide = extract(stderr, { maxFailures });
  const outSide = extract(stdout, { maxFailures: Math.max(maxFailures - errSide.failures, 0) });

  return {
    command, cwd: cwd ?? process.cwd(), code, killed,
    ms: Date.now() - started,
    raw: stdout + stderr,
    stdout, stderr,
    lines: [...errSide.lines, ...outSide.lines],
    failures: errSide.failures + outSide.failures,
    truncated: errSide.truncated + outSide.truncated,
    recognised: errSide.recognised || outSide.recognised,
    totalLines: errSide.totalLines + outSide.totalLines,
  };
}

export function render(result, { includeTail = 20 } = {}) {
  const head = `$ ${result.command}\nexit ${result.code}${result.killed ? " (timed out)" : ""} · ${result.totalLines} lines of output · ${(result.ms / 1000).toFixed(1)}s`;

  if (result.code === 0 && result.failures === 0) {
    const summary = result.lines.length ? `\n${result.lines.join("\n")}` : "";
    return `${head} · passed${summary}`;
  }

  // Output nobody recognised: rather than guess, hand back the tail, which is
  // where a failing command almost always says why.
  if (!result.recognised) {
    const tail = result.raw.split(/\r?\n/).filter(Boolean).slice(-includeTail);
    return `${head}\n\n(no recognised failure format — last ${tail.length} lines verbatim)\n${tail.join("\n")}`;
  }

  const more = result.truncated ? `\n\n(${result.truncated} further failure(s) not shown — raise max_failures)` : "";
  return `${head}\n\n${result.lines.join("\n")}${more}`;
}
