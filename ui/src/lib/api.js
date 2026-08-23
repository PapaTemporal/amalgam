/**
 * Everything the interface knows, it learns from the local API.
 *
 * No client-side caching layer and no store framework: the server is on
 * loopback and answers in single-digit milliseconds, so a refetch is cheaper
 * than the bugs a stale cache would buy.
 */
const json = async (url, options) => {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
};

export const get = (path, params) =>
  json(`/api${path}${params ? "?" + new URLSearchParams(params) : ""}`);

export const post = (path, body) =>
  json(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/**
 * Follow a job to completion.
 *
 * Jobs are the only things here that change a machine, and the reason they
 * stream rather than returning at the end is that a wizard which says
 * "installing…" for two minutes is indistinguishable from one that has hung.
 */
export function watchJob(id, onUpdate) {
  const source = new EventSource(`/api/jobs/${id}/stream`);
  source.onmessage = (e) => {
    const state = JSON.parse(e.data);
    onUpdate(state);
    if (state.state === "done" || state.state === "failed") source.close();
  };
  source.onerror = () => source.close();
  return () => source.close();
}

export const relative = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const bytes = (n) =>
  n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB`
    : n > 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`;

export const tokens = (chars) => Math.round(chars / 4);
