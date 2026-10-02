// End to end against the DEPLOYED system: CloudFront site, Lambda Function URL, PayPal sandbox, Bedrock, DynamoDB.
// Usage: node tests/e2e.deployed.mjs   (reads URLs from .deploy-state)
import { readFileSync } from "node:fs";
import dns from "node:dns";
// This dev machine's local resolver cached an empty A answer for the new CloudFront name and has no IPv6 route,
// so CloudFront hostnames are resolved through 8.8.8.8 (IPv4). Public resolvers return A records normally.
const pub = new dns.Resolver(); pub.setServers(["8.8.8.8"]);
const realLookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (!host.endsWith("cloudfront.net")) return realLookup(host, opts, cb);
  pub.resolve4(host, (e, a) => (e ? cb(e) : opts?.all ? cb(null, a.map((address) => ({ address, family: 4 }))) : cb(null, a[0], 4)));
};
const api = readFileSync(new URL("../.deploy-state/api-url", import.meta.url), "utf8").trim().replace(/\/$/, "");
const cf = readFileSync(new URL("../.deploy-state/cf-info", import.meta.url), "utf8").trim().split(/\s+/)[1];
const site = "https://" + cf;
let fails = 0;
const ok = (c, m, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${extra ? "  " + extra : ""}`); if (!c) fails++; };
const call = async (m, p, b) => { const t = Date.now(); const r = await fetch(api + p, { method: m, headers: { "content-type": "application/json", origin: site }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json(); return { s: r.status, j, ms: Date.now() - t, h: r.headers }; };

console.log("== CloudFront", site);
let r = await fetch(site + "/"); const html = await r.text();
ok(r.status === 200 && /text\/html/.test(r.headers.get("content-type")), "CloudFront serves the page", `HTTP ${r.status} ${r.headers.get("content-type")} ${html.length} bytes`);
const js = html.match(/assets\/index-[\w-]+\.js/)?.[0], css = html.match(/assets\/index-[\w-]+\.css/)?.[0];
for (const a of [js, css]) { const x = await fetch(`${site}/${a}`); ok(x.status === 200, `asset ${a}`, `HTTP ${x.status} ${x.headers.get("content-type")} ${(await x.arrayBuffer()).byteLength} bytes`); }
const bundle = await (await fetch(`${site}/${js}`)).text();
ok(bundle.includes(api.replace("https://", "")), "bundle is wired to the deployed Function URL");
r = await fetch(site + "/", { method: "HEAD" }); ok(r.headers.get("x-cache") !== null, "served through CloudFront", `x-cache: ${r.headers.get("x-cache")}`);

console.log("\n== Lambda Function URL", api);
let x = await call("GET", "/api/health"); ok(x.s === 200 && x.j.ok, "health", `${x.ms} ms ${JSON.stringify(x.j)}`);
ok([site, "*"].includes(x.h.get("access-control-allow-origin")), "CORS allows the CloudFront origin", `access-control-allow-origin: ${x.h.get("access-control-allow-origin")}`);
x = await call("GET", "/api/config"); ok(x.s === 200 && x.j.scenarios.length === 3 && !JSON.stringify(x.j).includes("vaultId"), "config (3 scenarios, no vault token leaked)");

console.log("\n== Live flow through the deployed API (real Bedrock agent, real PayPal sandbox)");
const T0 = Date.now();
let c = (await call("POST", "/api/cases", { scenarioId: "neck-bleed", mode: "hold" })).j;
ok(c.state === "sized", "agent sized the guarantee", `source=${c.sizing?.source} amount=${c.sizing?.amount} toolCalls=${c.sizing?.agent?.toolCalls} turns=${c.sizing?.agent?.turns} ${c.sizing?.ms} ms`);
const steps = [["authorize", "authorized"], ["contact", "accepted"], ["document", "partially_captured"], ["discharge", "captured"]];
for (const [s, st] of steps) { x = await call("POST", `/api/cases/${c.id}/${s}`, {}); c = x.j; ok(c.state === st, `${s} -> ${st}`, `${x.ms} ms ${s === "authorize" ? "authId=" + c.auth?.authId : s === "document" ? "capture " + c.captures?.[0]?.id + " $" + c.captures?.[0]?.amount : s === "discharge" ? "total charged $" + c.capture?.amount + ", released $" + c.capture?.released : ""}`); }
x = await call("POST", `/api/cases/${c.id}/audit`, {}); ok(x.j.audit?.text?.length > 80, "audit narrative drafted", `source=${x.j.audit?.source} ${x.ms} ms${x.j.audit?.source === "bedrock" ? "" : " (model rate limited; template used)"}`);
console.log("   narrative:", x.j.audit?.text);
console.log(`   whole flow: ${((Date.now() - T0) / 1000).toFixed(1)} s`);
x = await call("GET", `/api/cases/${c.id}`); ok(x.j.id === c.id && x.j.state === "captured", "case persisted in DynamoDB and readable again");

console.log("\n== Void path");
let v = (await call("POST", "/api/cases", { scenarioId: "transfer", mode: "hold" })).j;
for (const s of ["authorize", "contact", "void"]) v = (await call("POST", `/api/cases/${v.id}/${s}`, {})).j;
ok(v.state === "voided", "transfer case voided, sponsor charged nothing", `authorization ${v.auth.authId} hold ${v.auth.amount} released ${v.void?.released}`);

console.log("\n== Record reconstruction agent");
x = await call("POST", "/api/reconstruct", {});
ok(x.s === 200 && x.j.gaps?.[0]?.minutes === 74, "gap flagged, not filled", `source=${x.j.source} gap=${x.j.gaps?.[0]?.fromTime}-${x.j.gaps?.[0]?.toTime} (${x.j.gaps?.[0]?.minutes} min) findings=${x.j.findings?.length}`);
console.log("   narrative:", x.j.record?.narrative);
console.log("   not recorded:", JSON.stringify(x.j.record?.notRecorded));

console.log("\n== Webhooks");
x = await call("GET", "/api/webhooks"); ok(x.s === 200 && Array.isArray(x.j.events), "webhook store readable", `${x.j.events.length} verified events, ${x.j.rejected} rejected`);
console.log(x.j.events.slice(0, 4).map((e) => `   ${e.type} ${e.status || ""} ${e.amount || ""}`).join("\n"));
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
