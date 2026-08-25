/**
 * The planning workflows a project has, and the pages some of them ship.
 *
 * BMAD installs as skills, and a few of them come with a self-contained HTML
 * chooser: pick the techniques or the shape of the work, press a button, and
 * it puts a prompt on your clipboard for you to paste back into a chat. That
 * last step only exists because the page had nowhere to send the prompt.
 * Here it does.
 *
 * Nothing is hardcoded. The list is whatever is installed, read from disk
 * each time, so a BMAD upgrade that adds a workflow — or another chooser —
 * appears without amalgam being taught about it.
 */
import fs from "node:fs";
import path from "node:path";

/** Where a project keeps its skills. */
const skillsDir = (root) => path.join(root, ".claude", "skills");

/**
 * The first paragraph of a skill's description.
 *
 * Skills carry YAML front matter with a `description:` that exists to tell an
 * agent when to reach for them — which is also exactly what somebody choosing
 * from a list needs to know.
 */
function describe(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8").slice(0, 4000); } catch { return null; }

  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) {
    // Front matter values may be folded across lines; take everything up to
    // the next key at column zero.
    const m = /^description:\s*(.*(?:\r?\n(?![a-zA-Z_-]+:)[^\r\n]*)*)/m.exec(front[1]);
    if (m) return m[1].replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  }
  const para = text.replace(/^---[\s\S]*?---/, "").split(/\r?\n\r?\n/).map((s) => s.trim()).find(Boolean);
  return para ? para.replace(/^#+\s*/, "").replace(/\s+/g, " ").slice(0, 400) : null;
}

/** A chooser page shipped beside a skill, if it has one. */
function chooserFor(dir) {
  const assets = path.join(dir, "assets");
  let entries;
  try { entries = fs.readdirSync(assets); } catch { return null; }
  // A template is something the skill fills in and writes out; a chooser is
  // something a person opens. Only the second belongs in a menu.
  const page = entries.find((f) => f.endsWith(".html") && !/template/i.test(f));
  return page ? path.join(assets, page) : null;
}

const TITLE = /<title>([^<]+)<\/title>/i;

/**
 * Every installed workflow, and which of them open with a chooser.
 *
 * Deprecated skills are dropped: BMAD keeps forwarding stubs so old names
 * still work, and a menu of forty entries where a third say "deprecated —
 * forwards to" is a menu nobody reads.
 */
export function workflows(projectRoot) {
  const base = skillsDir(path.resolve(projectRoot));
  let names;
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }

  const out = [];
  for (const name of names.sort()) {
    const dir = path.join(base, name);
    const skill = ["SKILL.md", "skill.md"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!skill) continue;

    const description = describe(skill);
    if (description && /^deprecated\b/i.test(description)) continue;

    const chooser = chooserFor(dir);
    let chooserTitle = null;
    if (chooser) {
      try { chooserTitle = TITLE.exec(fs.readFileSync(chooser, "utf8").slice(0, 4000))?.[1]?.trim() ?? null; }
      catch { /* the page is still usable without its title */ }
    }

    out.push({
      name,
      // What you would type in a chat, which is also what gets sent when the
      // interface runs it.
      command: `/${name}`,
      description,
      group: name.startsWith("bmad-") ? "bmad" : "amalgam",
      chooser: chooser ? { file: chooser, title: chooserTitle } : null,
    });
  }
  return out;
}

/** Locate one skill's chooser page, for serving it. */
export function chooserPath(projectRoot, name) {
  if (!/^[\w.-]+$/.test(name)) return null;
  const dir = path.join(skillsDir(path.resolve(projectRoot)), name);
  return chooserFor(dir);
}

/**
 * The chooser, with its prompt wired to the interface instead of a clipboard.
 *
 * The page is left exactly as it is. What is added is a shim, injected into
 * the served copy only: clipboard writes and the last-resort window.prompt
 * both get forwarded to whatever embedded the page. The clipboard still gets
 * the text, so the page's own button keeps working and anyone who wants to
 * paste it somewhere else still can — but the interface no longer has to ask
 * a person to carry text between two windows it is showing them.
 */
export function wireChooser(html) {
  const shim = `
<script>
(function () {
  if (window.parent === window) return;   // opened on its own; leave it alone
  var sent = null;
  var send = function (text) {
    if (typeof text !== "string" || !text.trim() || text === sent) return;
    sent = text;
    try { window.parent.postMessage({ source: "bmad-chooser", prompt: text }, "*"); } catch (e) {}
  };

  // The page copies with the clipboard API where it can.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function (text) { send(text); return write(text); };
  }
  // ...and falls back to execCommand, or to window.prompt on a hard failure.
  var exec = document.execCommand ? document.execCommand.bind(document) : null;
  if (exec) {
    document.execCommand = function (cmd) {
      if (String(cmd).toLowerCase() === "copy") {
        var el = document.activeElement;
        if (el && typeof el.value === "string") send(el.value);
      }
      return exec.apply(document, arguments);
    };
  }
  var ask = window.prompt;
  window.prompt = function (message, value) { send(value); return ask ? ask.apply(window, arguments) : value; };
})();
</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${shim}</body>`) : html + shim;
}
