// Runs all three demo scenarios against the deployed API and saves the real results as the page's
// first-load data (frontend/src/recorded.json). Usage: node scripts/record-runs.mjs <function-url>
import { readFileSync, writeFileSync } from "node:fs";
const base = process.argv[2].replace(/\/$/, "");
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(p + " " + JSON.stringify(j)); return j; };
const config = await call("GET", "/api/config");
const cases = {};
for (const s of config.scenarios) {
  let c = await call("POST", "/api/cases", { scenarioId: s.id });
  c = await call("POST", `/api/cases/${c.id}/authorize`, {});
  c = await call("POST", `/api/cases/${c.id}/contact`, {});
  if (s.outcome === "capture") { c = await call("POST", `/api/cases/${c.id}/document`, {}); if (s.hasStay) c = await call("POST", `/api/cases/${c.id}/discharge`, {}); }
  else c = await call("POST", `/api/cases/${c.id}/void`, {});
  c = await call("POST", `/api/cases/${c.id}/audit`, {});
  cases[s.id] = c; console.log(s.id, c.id, c.state, c.auth.amount, c.capture?.amount ?? "void");
}
const reconstruct = await call("POST", "/api/reconstruct", {});
console.log("reconstruct", reconstruct.source, reconstruct.gaps.length, "gap(s)");
writeFileSync(new URL("../frontend/src/recorded.json", import.meta.url), JSON.stringify({ recordedAt: new Date().toISOString(), config, cases, reconstruct }, null, 1));
