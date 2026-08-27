/**
 * Moving what an update cannot carry.
 *
 * `amalgam update` moves code. It cannot move memory, because memory is a file
 * on the machine you are leaving and the update runs on the one you are
 * arriving at. So a second machine has always started empty — no facts, no
 * persona, no project list — and the only advice was "copy the SQLite file
 * across", which works and is a strange thing to ask somebody to work out.
 *
 * What travels is what a person accumulated: facts, scenarios, persona, the
 * review queue, which projects they have, and how they configured routing.
 *
 * What deliberately does NOT travel is anything the new machine has to learn
 * for itself. Build timings are the clearest case — how long a rebuild takes
 * is a fact about a machine, not about a repository, and carrying one
 * machine's number to another would put the automatic refresh back to
 * deciding from a guess, which is the thing it exists not to do. Downloads
 * stay put too: they are large, and `amalgam install` already fetches them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read at the moment of acting, not at import.
 *
 * Everything else in the project resolves AMALGAM_HOME once when its module
 * loads, which is right for a long-lived process pointed at one machine. These
 * two commands are one-shot and are the only pair that ever means "somewhere
 * else" — and a value captured at import cannot be redirected, which makes
 * both of them untestable and the import silently write to the wrong place.
 */
const home = () => process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");

/**
 * Tables that are not memory, and must not be carried.
 *
 * The code index lives in the same database as memory, which is convenient
 * until you try to move one without the other: on this machine it is 97,918
 * symbols and 206,151 edges with their vectors, and it turned a bundle that
 * should be a few megabytes into 349. It is also entirely derived — every row
 * comes from a repository on the machine that built it, and `amalgam graph`
 * reproduces it — so carrying it would move the largest thing in the file to
 * do no work at all.
 *
 * usage_log goes for a different reason: it is this machine's record of what
 * it actually saved, and on another machine it would be somebody else's
 * numbers being reported as yours.
 */
const DERIVED = ["symbols", "symbol_edges", "graph_repos", "contract_edges", "contract_orphans", "usage_log"];

/** Where the bundle keeps each piece, and what each piece is for. */
const PARTS = [
  { file: "data/memory.db",           what: "facts, scenarios, persona, and the review queue" },
  { file: "ui.json",                  what: "which projects you have" },
  { file: "models.json",              what: "which model runs which kind of task" },
  { file: "refresh-settings.json",    what: "whether graphs refresh themselves" },
];

const MANIFEST = "amalgam-transfer.json";

/**
 * Copy the portable half of this machine into a folder.
 *
 * A folder rather than an archive: there is no archiver in the runtime, a
 * directory copies over any transport somebody already has, and being able to
 * see what is in it beats being told.
 */
export function exportTo(dir) {
  const out = path.resolve(dir);
  fs.mkdirSync(out, { recursive: true });

  const carried = [];
  for (const part of PARTS) {
    const from = path.join(home(), part.file);
    if (!fs.existsSync(from)) continue;
    const to = path.join(out, path.basename(part.file));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    carried.push({ ...part, bytes: fs.statSync(to).size });
  }

  fs.writeFileSync(path.join(out, MANIFEST), JSON.stringify({
    at: new Date().toISOString(),
    from: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "a machine",
    carried: carried.map((c) => c.file),
    // Said out loud in the bundle itself, so somebody reading it later knows
    // what they are NOT holding.
    notCarried: [
      "the code index — derived from repositories, rebuilt by amalgam graph",
      "build timings — how long a rebuild takes is a fact about a machine",
      "downloaded models and runtimes — amalgam install fetches those",
      "the agent CLI and its sign-in",
    ],
  }, null, 2));

  return carried;
}

/** The same, with the derived half of the database left behind. */
export async function exportBundle(dir) {
  const carried = exportTo(dir);
  const db = carried.find((c) => c.file.endsWith("memory.db"));
  if (!db) return carried;

  const file = path.join(path.resolve(dir), "memory.db");
  const before = fs.statSync(file).size;
  const copy = await openAt(file);
  try {
    for (const table of DERIVED) {
      try { copy.exec(`DELETE FROM ${table}`); } catch { /* an older bundle may not have it */ }
    }
    copy.exec("VACUUM");
  } finally {
    try { copy.close(); } catch { /* already gone */ }
  }
  db.bytes = fs.statSync(file).size;
  db.freed = before - db.bytes;
  return carried;
}

/** Open a database file directly, without going through the shared handle. */
async function openAt(file) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file);
}

const liveFacts = (db) => db.prepare(
  `SELECT kind, content, context, priority, verify_state, verify_note
     FROM l1_facts WHERE superseded_by IS NULL ORDER BY id`).all();

/**
 * Bring a bundle in.
 *
 * Memory is the only part with a real decision in it. An empty machine takes
 * the file wholesale, which preserves everything including the supersede
 * chains that say which corrections replaced what. A machine that already has
 * facts of its own cannot take the file — that would delete them — so it
 * merges the live facts instead, skipping anything it already knows, and says
 * plainly that the queue and the raw log did not come with them.
 */
export async function importFrom(dir, { replace = false, embed = null, similarity = null } = {}) {
  const from = path.resolve(dir);
  if (!fs.existsSync(path.join(from, MANIFEST))) {
    return { error: `${from} does not look like a transfer bundle (no ${MANIFEST})` };
  }

  const done = [];

  // Projects: a union, never a replacement. Arriving with a bundle should not
  // remove a project somebody added here.
  const incomingUi = path.join(from, "ui.json");
  if (fs.existsSync(incomingUi)) {
    let mine = { projects: [] };
    try { mine = JSON.parse(fs.readFileSync(path.join(home(), "ui.json"), "utf8")); } catch { /* first import */ }
    const theirs = JSON.parse(fs.readFileSync(incomingUi, "utf8")).projects ?? [];
    const before = (mine.projects ?? []).length;
    // Only the ones that exist here. A path from another machine is usually
    // just a path that is not on this one.
    // A path from another machine is often just a path this one does not have.
    const here = theirs.filter((p) => fs.existsSync(p));
    const absent = theirs.length - here.length;
    const merged = [...new Set([...(mine.projects ?? []), ...here])];
    fs.writeFileSync(path.join(home(), "ui.json"), JSON.stringify({ ...mine, projects: merged }, null, 2));
    done.push(`projects: ${merged.length} now (${before} already here, ${merged.length - before} added` +
              (absent ? `, ${absent} in the bundle whose folder is not on this machine` : "") + ")");
  }

  // Settings: taken only where this machine has expressed no preference.
  for (const f of ["models.json", "refresh-settings.json"]) {
    const src = path.join(from, f);
    const dst = path.join(home(), f);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst) && !replace) { done.push(`${f}: kept this machine's`); continue; }
    fs.copyFileSync(src, dst);
    done.push(`${f}: taken from the bundle`);
  }

  // Memory.
  const incomingDb = path.join(from, "memory.db");
  if (fs.existsSync(incomingDb)) {
    const mineDb = path.join(home(), "data", "memory.db");
    fs.mkdirSync(path.dirname(mineDb), { recursive: true });

    let existing = 0;
    if (fs.existsSync(mineDb)) {
      try {
        const db = await openAt(mineDb);
        existing = db.prepare(`SELECT count(*) n FROM l1_facts`).get().n;
        db.close();
      } catch { /* unreadable counts as empty */ }
    }

    if (!existing || replace) {
      fs.copyFileSync(incomingDb, mineDb);
      done.push(existing
        ? `memory: replaced ${existing} fact(s) with the bundle's, whole file`
        : `memory: taken whole, including supersede history`);
    } else {
      const { merged, skipped } = await mergeFacts(incomingDb, mineDb, { embed, similarity });
      done.push(`memory: merged ${merged} fact(s), skipped ${skipped} already known`);
      done.push(`memory: the review queue and raw log stayed behind — only live facts merge`);
    }
  }

  return { done };
}

/**
 * Add the facts this machine does not already have.
 *
 * Compared by meaning where the embedding model is installed, and by text
 * otherwise, on the same bar the proposal queue uses. Supersede chains cannot
 * survive a merge — the ids they point at do not exist here — so what arrives
 * is the set of things currently believed, which is what those chains resolve
 * to anyway.
 */
async function mergeFacts(fromFile, intoFile, { embed = null, similarity = null } = {}) {
  const src = await openAt(fromFile);
  const dst = await openAt(intoFile);
  try {
    const incoming = liveFacts(src);
    const mine = liveFacts(dst);
    const flat = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const known = new Set(mine.map((f) => flat(f.content)));

    let vectors = null;
    if (embed && similarity && mine.length && incoming.length) {
      try {
        const all = await embed([...mine.map((f) => f.content), ...incoming.map((f) => f.content)]);
        if (all) vectors = { mine: all.slice(0, mine.length), incoming: all.slice(mine.length) };
      } catch { /* text comparison is enough */ }
    }

    const insert = dst.prepare(
      `INSERT INTO l1_facts (kind, content, context, priority, verify_state, verify_note, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);

    let merged = 0, skipped = 0;
    const keptVectors = [];
    incoming.forEach((f, i) => {
      if (known.has(flat(f.content))) { skipped++; return; }
      if (vectors) {
        const v = vectors.incoming[i];
        if ([...vectors.mine, ...keptVectors].some((o) => similarity(v, o) >= 0.88)) { skipped++; return; }
        keptVectors.push(v);
      }
      insert.run(f.kind, f.content, f.context, f.priority ?? 50, f.verify_state, f.verify_note);
      known.add(flat(f.content));
      merged++;
    });
    return { merged, skipped };
  } finally {
    try { src.close(); } catch { /* already gone */ }
    try { dst.close(); } catch { /* already gone */ }
  }
}

export { PARTS, MANIFEST };
