/**
 * Serving the interactive graph graphify already builds.
 *
 * graphify writes a genuinely good page — force-directed, coloured by
 * community, with a sidebar you can filter and search and a panel that
 * inspects a node. There is no reason to rebuild that, so amalgam serves it
 * instead of competing with it.
 *
 * Two things have to be dealt with to make it usable from here.
 *
 * The first is location: the page sits on disk inside the project it
 * describes, and a browser will not open a file:// page from an http:// one.
 * So it is proxied, along with anything beside it that it asks for.
 *
 * The second is the one real incompatibility. The page loads its drawing
 * library from a CDN, which means it needs the internet — and amalgam's
 * standing promise is that the only thing reaching the network is the
 * frontier model. A copy kept beside the graph fixes that permanently, so
 * the script tag is rewritten to point at it whenever one exists, and the
 * page says plainly when it is about to reach out instead.
 */
import fs from "node:fs";
import path from "node:path";

import { readRegistry, projectKey } from "./uiserver.mjs";
import { services, isWorkspace } from "./workspace.mjs";
import { HOME } from "./services.mjs";

/** Where a vendored copy of the drawing library lives, if it has been fetched. */
export const VENDOR_DIR = path.join(HOME, "vendor");
export const VIS_FILE = path.join(VENDOR_DIR, "vis-network.min.js");
export const visVendored = () => fs.existsSync(VIS_FILE);

/** Anything the page is allowed to ask for beside itself. */
const SAFE = /\.(html|js|css|map|json|svg|png|woff2?)$/i;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

/**
 * Every place a built graph could be, keyed by how a URL names it.
 *
 * A project is a workspace, so its graphs belong to its services — each with
 * its own page. The key is the project, the rest of the path picks the
 * service.
 */
export function builtGraphs(projectRoot) {
  const root = path.resolve(projectRoot);
  const parts = isWorkspace(root)
    ? services(root).map((s) => ({ name: s.name, path: s.path }))
    : [{ name: path.basename(root), path: root }];

  return parts.map((part) => {
    const page = path.join(part.path, "graphify-out", "graph.html");
    const report = path.join(part.path, "graphify-out", "GRAPH_REPORT.md");
    return {
      service: part.name,
      hasPage: fs.existsSync(page),
      hasReport: fs.existsSync(report),
      // Only meaningful once the page exists; cheap enough to answer anyway.
      needsNetwork: fs.existsSync(page) && !visVendored() && usesCdn(page),
    };
  });
}

const usesCdn = (file) => {
  try { return /https?:\/\/[^"']*vis-network/i.test(fs.readFileSync(file, "utf8")); }
  catch { return false; }
};

/** The directory holding a service's built graph, or null. */
function graphDirFor(key, service) {
  const dir = readRegistry().projects.find((p) => projectKey(p) === key);
  if (!dir) return null;
  const root = path.resolve(dir);
  if (!service) return path.join(root, "graphify-out");

  const match = (isWorkspace(root) ? services(root) : []).find((s) => s.name === service);
  return match ? path.join(match.path, "graphify-out") : null;
}

/**
 * Serve the page, or a file beside it.
 *
 * `rest` is empty for the page itself, the service name for a workspace, or
 * `service/file` for something the page asked for.
 */
export function serveBuiltGraph(res, key, rest) {
  const bits = String(rest ?? "").split("/").filter(Boolean);

  // The vendored library is served from amalgam's own directory rather than
  // from the project, since it belongs to no project in particular. It is the
  // last segment, not the first: a workspace names its service before it.
  if (bits[bits.length - 1] === "_vendor") {
    if (!visVendored()) return plain(res, 404, "not vendored");
    res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "public, max-age=31536000, immutable" });
    return fs.createReadStream(VIS_FILE).pipe(res);
  }

  // A workspace names the service first; a lone repository names nothing.
  const first = bits[0] ?? "";
  const looksLikeFile = SAFE.test(first);
  const service = looksLikeFile ? "" : first;
  const relative = (looksLikeFile ? bits : bits.slice(1)).join("/");

  const dir = graphDirFor(key, service);
  if (!dir) return plain(res, 404, "no such project or service");

  const file = path.join(dir, relative || "graph.html");
  if (!path.resolve(file).startsWith(path.resolve(dir))) return plain(res, 403, "outside the graph directory");
  if (relative && !SAFE.test(relative)) return plain(res, 403, "not a servable file");
  if (!fs.existsSync(file)) {
    return plain(res, 404,
      "No interactive graph here yet. Build one with `amalgam graph`, which now clusters as well as extracts.");
  }

  const ext = path.extname(file).toLowerCase();
  if (ext !== ".html") {
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    return fs.createReadStream(file).pipe(res);
  }

  let html = fs.readFileSync(file, "utf8");
  const base = `/graph/${encodeURIComponent(key)}${service ? `/${service}` : ""}`;
  if (visVendored()) {
    // Point at the copy that is already here. Nothing about the page changes
    // except where it gets its library from.
    html = html.replace(/https?:\/\/[^"']*vis-network[^"']*\.js/gi, `${base}/_vendor`);
  } else {
    html = html.replace("</body>", `${cdnNotice()}</body>`);
  }
  res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
  res.end(html);
}

/**
 * Say it out loud rather than letting a blank canvas be the explanation.
 *
 * A page that silently needs the internet is indistinguishable from a broken
 * one when it does not have it, and amalgam's whole claim is that it works
 * without any.
 */
const cdnNotice = () => `
<div style="position:fixed;left:12px;bottom:12px;z-index:9999;max-width:34rem;
  font:13px/1.5 system-ui,sans-serif;background:#1a1408;color:#f5d78e;
  border:1px solid #6b5320;border-radius:8px;padding:.6rem .8rem">
  This page loads its drawing library from the internet, so it will be blank offline.
  Run <code style="background:#0a0c10;padding:.05rem .3rem;border-radius:3px">amalgam vendor-graph</code>
  once to keep a copy locally, and it will never need the network again.
</div>`;

const plain = (res, code, message) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
};
