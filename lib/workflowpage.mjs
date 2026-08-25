/**
 * Serving a workflow's own chooser page.
 *
 * Some BMAD skills ship a self-contained HTML chooser — pick the techniques,
 * press a button, paste the prompt back into a chat. The page is good and
 * there is no reason to rebuild it; what it lacks is somewhere to send the
 * prompt, because it was written for a world where the only place to put text
 * was the clipboard.
 *
 * So it is served as it is, with one shim appended to the served copy that
 * forwards the prompt to whatever embedded it. The file on disk is untouched,
 * the clipboard still gets the text, and the page opened on its own behaves
 * exactly as its author intended.
 */
import fs from "node:fs";
import path from "node:path";

import { readRegistry, projectKey } from "./uiserver.mjs";
import { chooserPath, wireChooser } from "./workflows.mjs";

export function serveChooser(res, key, name) {
  const dir = readRegistry().projects.find((p) => projectKey(p) === key);
  if (!dir) return plain(res, 404, "no such project");

  const file = chooserPath(path.resolve(dir), name);
  if (!file || !fs.existsSync(file)) {
    return plain(res, 404, `${name} does not ship a chooser page`);
  }

  let html;
  try { html = fs.readFileSync(file, "utf8"); }
  catch { return plain(res, 500, "could not read the page"); }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(wireChooser(html));
}

const plain = (res, code, message) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
};
