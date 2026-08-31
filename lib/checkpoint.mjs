/**
 * What starting over would cost, and what it would lose.
 *
 * Everything else here reduces what a call ADDS to a conversation: a packet
 * instead of two files, an exit code instead of a build log. None of it
 * removes anything already said, because a transcript is append-only — so the
 * context indicator climbs no matter how efficient each addition was. amalgam
 * flattens the slope and cannot change the direction.
 *
 * The only thing that changes the direction is a session boundary, and the
 * memory layers exist to make crossing one cheap: persona, the project's
 * scenario documents and the open work items are what a fresh session reads
 * instead of scrolling back. Measured here, that is a few hundred tokens
 * against a conversation of tens of thousands.
 *
 * Which is a good trade only if what would be restored is actually current.
 * It usually is not, and nothing said so: the scenario for this repository was
 * six days and forty-odd commits old while the work that outdated it was being
 * done. So this reports both halves — what a fresh session would get, and how
 * far behind it has fallen — and leaves the decision where it belongs.
 *
 * It cannot see the conversation. No process here can; the transcript belongs
 * to the agent's harness. What it can say is what the other side of a boundary
 * looks like, which is the half nobody could see before.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Tokens, roughly. Four characters is the usual approximation for prose. */
const tokens = (chars) => Math.round(chars / 4);

/** How many code commits have landed in a repository since a moment. */
function commitsSince(repo, isoDate) {
  const r = spawnSync("git", ["-C", repo, "rev-list", "--count", "--since", isoDate, "HEAD"],
                      { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Everything a fresh session would begin with, and what it costs.
 *
 * `repo` decides which scenarios count as this project's: they are addressed
 * by a virtual path whose first segment is the project, so a machine holding
 * six projects does not report all six as the cost of resuming one.
 */
export async function restorePoint(repo = process.cwd()) {
  const { open } = await import("./db.mjs");
  const db = open();

  const name = path.basename(path.resolve(repo)).toLowerCase();
  const persona = db.prepare(`SELECT content, created_at FROM l3_persona`).all();

  const scenarios = db.prepare(
    `SELECT path, content, summary, updated_at FROM l2_scenarios ORDER BY path`).all()
    .map((s) => ({
      path: s.path,
      chars: s.content.length,
      updatedAt: s.updated_at,
      // Only the ones addressed to this project. Matched loosely on purpose:
      // a scenario is filed under the project's NAME while the check runs in
      // its DIRECTORY, and those differ the moment a clone is called
      // amalgam-pkg and the project is called amalgam. Requiring them to be
      // equal reported "nothing has been written for this project" about a
      // project with two scenarios.
      mine: (() => {
        const seg = String(s.path).toLowerCase().split("/")[0];
        return seg === name || name.startsWith(seg) || seg.startsWith(name);
      })(),
      behind: commitsSince(repo, s.updated_at),
    }));

  // Work items live in a table that lib/tasks.mjs creates the first time a task
  // is started, so on a machine where nobody ever started one it does not exist
  // yet. Asking what a fresh session would restore is exactly the question a
  // brand-new install asks, and crashing on the answer would be the worst
  // possible moment for it.
  const open_ = (() => {
    try {
      return db.prepare(
        `SELECT id, title, state, updated_at FROM tasks WHERE state != 'done' ORDER BY id`).all();
    } catch { return []; }
  })();

  const facts = db.prepare(
    `SELECT count(*) n FROM l1_facts WHERE superseded_by IS NULL`).get().n;

  const mine = scenarios.filter((s) => s.mine);
  const chars = persona.reduce((n, p) => n + p.content.length, 0)
              + mine.reduce((n, s) => n + s.chars, 0)
              + open_.reduce((n, t) => n + t.title.length + 20, 0);

  return {
    persona: { rows: persona.length, chars: persona.reduce((n, p) => n + p.content.length, 0) },
    scenarios: mine,
    others: scenarios.length - mine.length,
    tasks: open_,
    facts,
    chars,
    tokens: tokens(chars),
    // The oldest thing a resume would rely on, which is what decides whether
    // the resume is worth having.
    stalest: mine.reduce((worst, s) => (s.behind ?? 0) > (worst?.behind ?? -1) ? s : worst, null),
  };
}

/** The same, as something to read. */
export function renderRestorePoint(r) {
  const lines = [];
  lines.push("What a fresh session would start with");
  lines.push("");
  lines.push(`  persona            ${String(r.persona.chars).padStart(6)} chars   ${r.persona.rows} row(s)`);

  if (!r.scenarios.length) {
    lines.push(`  project state           none   nothing has been written for this project`);
  } else {
    for (const s of r.scenarios) {
      const age = s.behind === null ? "" : s.behind === 0
        ? "current with the code"
        : `${s.behind} commit(s) behind`;
      lines.push(`  ${s.path.padEnd(18)} ${String(s.chars).padStart(6)} chars   ${s.updatedAt.slice(0, 10)}${age ? " — " + age : ""}`);
    }
  }

  lines.push(`  open work items    ${String(r.tasks.length).padStart(6)}         ${r.tasks.map((t) => t.title.slice(0, 40)).join("; ") || "none"}`);
  lines.push(`  facts recallable   ${String(r.facts).padStart(6)}         searched, not loaded`);
  lines.push("");
  lines.push(`  about ${r.tokens} tokens to be back where you are.`);

  if (r.stalest && (r.stalest.behind ?? 0) > 0) {
    lines.push("");
    lines.push(`  But ${r.stalest.path} was written ${r.stalest.behind} commit(s) ago, so that is where`);
    lines.push(`  a fresh session would think the project is. Ask for it to be brought up to`);
    lines.push(`  date before starting over, or starting over costs more than it saves.`);
  }

  lines.push("");
  lines.push("  This does not measure your conversation — nothing here can see it. It");
  lines.push("  measures the other side of the boundary, which is the half that was");
  lines.push("  invisible when deciding whether to cross one.");
  return lines.join("\n");
}
