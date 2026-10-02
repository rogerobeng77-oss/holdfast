const BASE = (import.meta.env.VITE_API || "").replace(/\/$/, "");
async function req(method, path, body) {
  let r;
  try { r = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error("Cannot reach the API. Check your connection and run the step again."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `The API answered ${r.status}. Run the step again.`);
  return j;
}
export const api = {
  config: () => req("GET", "/api/config"),
  cases: () => req("GET", "/api/cases"),
  getCase: (id) => req("GET", `/api/cases/${id}`),
  webhooks: () => req("GET", "/api/webhooks"),
  create: (scenarioId, mode) => req("POST", "/api/cases", { scenarioId, mode }),
  pool: (name, body = {}) => req("POST", `/api/pool/${name}`, body),
  step: (id, name, body = {}) => req("POST", `/api/cases/${id}/${name}`, body),
  reconstruct: (entries) => req("POST", "/api/reconstruct", entries ? { entries } : {}),
  setup: (returnUrl) => req("POST", "/api/sponsors/setup", { returnUrl }),
  vault: (setupTokenId) => req("POST", "/api/sponsors/vault", { setupTokenId }),
};
