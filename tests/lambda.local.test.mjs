// Runs the real Lambda handler in-process (real DynamoDB, Bedrock and PayPal sandbox), driving it with
// Function-URL-shaped events. Run: node --test tests/lambda.local.test.mjs
// The Bedrock account is limited to 10 requests/minute, so only two tests use the model agents; the rest
// pass sizing:"deterministic" to keep the lifecycle assertions independent of model capacity.
import "./env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "../backend/index.mjs";
import * as pp from "../backend/paypal.mjs";
import { analyse, checkNarrative } from "../backend/agent.mjs";
import { MESSY_SAMPLE } from "../backend/data.mjs";

const call = async (method, path, body, headers = {}) => {
  const r = await handler({ rawPath: path, requestContext: { http: { method } }, headers, body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  return { status: r.statusCode, json: JSON.parse(r.body) };
};
const log = (...a) => console.log("   ", ...a);
const step = async (id, s) => (await call("POST", `/api/cases/${id}/${s}`, {})).json;
const mk = async (scenarioId, extra = {}) => (await call("POST", "/api/cases", { scenarioId, sizing: "deterministic", ...extra })).json;
const prep = async (scenarioId, upTo) => { let c = await mk(scenarioId); for (const s of upTo) c = await step(c.id, s); return c; };

test("health + config; vault token never leaves the server", async () => {
  assert.equal((await call("GET", "/api/health")).json.ok, true);
  const c = (await call("GET", "/api/config")).json;
  assert.equal(c.scenarios.length, 3); assert.ok(c.sponsors[0].vaulted); assert.equal(c.sponsors[0].vaultId, undefined);
  log("scenarios", c.scenarios.map((s) => s.id).join(","), "| price lines", c.prices.length, "| pledge", c.sponsors[0].pledge);
});

test("AGENT sizing + full lifecycle: size -> authorize -> accept -> partial capture -> final capture -> audit", async () => {
  let c = (await call("POST", "/api/cases", { scenarioId: "neck-bleed" })).json;
  assert.equal(c.state, "sized");
  log("sizing source:", c.sizing.source, "| amount", c.sizing.amount, "| agent turns", c.sizing.agent?.turns, "tool calls", c.sizing.agent?.toolCalls, "| ms", c.sizing.ms);
  for (const t of c.sizing.agent?.trace || []) if (t.kind === "tool") log("  tool", t.name, JSON.stringify(t.input).slice(0, 90), "->", t.ok ? "ok" : "error");
  assert.ok(Number(c.sizing.amount) > 0 && Number(c.sizing.amount) <= 120000);
  if (c.sizing.source === "agent") assert.ok(c.sizing.agent.toolCalls >= 3);
  for (const s of ["authorize", "contact", "document"]) c = await step(c.id, s);
  assert.equal(c.state, "partially_captured"); assert.equal(c.captures[0].final, false);
  log("partial capture", c.captures[0].id, c.captures[0].amount, "| still held", pp.money(pp.cents(c.auth.amount) - pp.cents(c.captures[0].amount)));
  c = await step(c.id, "discharge"); assert.equal(c.state, "captured"); assert.equal(c.captures.length, 2);
  assert.ok(Number(c.capture.amount) <= Number(c.auth.amount));
  const g = await pp.getAuthorization(c.auth.authId); log("PayPal authorization status:", g.status, "| total charged", c.capture.amount, "released", c.capture.released);
  c = await step(c.id, "audit"); assert.ok(c.audit.text.length > 80); log("audit source:", c.audit.source, "|", c.audit.text.slice(0, 140) + "...");
});

test("void exit from authorized/accepted: transfer before incision releases the whole hold", async () => {
  let c = await prep("transfer", ["authorize", "contact"]);
  c = await step(c.id, "void"); assert.equal(c.state, "voided"); assert.equal(c.captures.length, 0);
  assert.equal((await pp.getAuthorization(c.auth.authId)).status, "VOIDED"); log("voided", c.auth.authId, "hold", c.auth.amount, "charged $0.00");
});

test("void exit from partially captured: remaining hold released, earlier capture stands", async () => {
  let c = await prep("jaw", ["authorize", "contact", "document"]);
  assert.equal(c.state, "partially_captured");
  c = await step(c.id, "void"); assert.equal(c.state, "voided"); assert.equal(c.captures.length, 1);
  log("charged", c.captures[0].amount, "| released", c.void.released);
});

test("state machine: out-of-order calls are refused with 409", async () => {
  const c = await mk("jaw");
  for (const s of ["contact", "document", "discharge", "void"]) { const r = await call("POST", `/api/cases/${c.id}/${s}`); assert.equal(r.status, 409); log(s, "before authorize ->", r.status, r.json.error); }
  const done = await prep("jaw", ["authorize", "contact", "document", "discharge"]);
  const r = await call("POST", `/api/cases/${done.id}/discharge`); assert.equal(r.status, 409); log("second final capture ->", r.status, r.json.error);
});

test("IDEMPOTENCY: same idempotency key returns the same case; concurrent authorize makes one hold", async () => {
  const key = "idem-" + Date.now();
  const a = await mk("jaw", { idempotencyKey: key }), b = await mk("jaw", { idempotencyKey: key });
  assert.equal(a.id, b.id); assert.equal(b.replayed, true); log("two create calls, one case:", a.id, "replayed:", b.replayed);
  const rs = await Promise.all([1, 2, 3].map(() => call("POST", `/api/cases/${a.id}/authorize`, {})));
  const ids = new Set(rs.map((r) => r.json.auth?.authId)); log("three concurrent authorize calls ->", [...ids].join(","), "statuses", rs.map((r) => r.status).join(","));
  assert.equal(ids.size, 1, "exactly one PayPal authorization");
  const again = await step(a.id, "authorize"); assert.equal(again.auth.authId, [...ids][0]); log("fourth call replays the existing hold, no new money movement");
});

test("REAUTHORIZATION: sweep after the honor period asks PayPal; the real refusal is recorded and the hold survives", async () => {
  let c = await prep("jaw", ["authorize", "contact"]);
  const r = (await call("POST", `/api/cases/${c.id}/sweep`, { simulateDays: 4 })).json;
  log("simulated day 4 ->", r.sweep.action, r.sweep.issue, "|", r.sweep.paypal);
  assert.equal(r.sweep.action, "refused"); assert.equal(r.sweep.issue, "REAUTHORIZATION_TOO_SOON");
  assert.ok(r.events.some((e) => e.type === "reauth_refused")); assert.equal(r.state, "accepted");
  const inside = (await call("POST", `/api/cases/${c.id}/sweep`, { simulateDays: 1 })).json; assert.equal(inside.sweep.action, "none"); log("simulated day 1 ->", inside.sweep.action, "(inside honor period)");
  c = await step(c.id, "document"); assert.equal(c.state, "partially_captured"); log("capture still works after the refused reauth");
});

test("EXPIRED/LOST AUTHORIZATION: a hold PayPal no longer honours is re-issued from the vault before capture", async () => {
  let c = await prep("jaw", ["authorize", "contact"]);
  const lost = c.auth.authId;
  await pp.voidAuth(lost, `lost-${c.id}`); // stand-in for expiry: PayPal now treats the hold as dead
  c = await step(c.id, "document");
  assert.equal(c.state, "partially_captured"); assert.equal(c.auth.reissues, 1); assert.notEqual(c.auth.authId, lost);
  log("old", lost, "-> re-issued", c.auth.authId, "| event:", c.events.find((e) => e.type === "reissued").text.slice(0, 120));
  c = await step(c.id, "discharge"); assert.equal(c.state, "captured"); log("final capture succeeded on the new hold:", c.capture.amount);
});

test("WEBHOOK SIGNATURE: a tampered payload is rejected, the genuine one is accepted, replays store once", async () => {
  const raw = (await call("GET", "/api/webhooks/raw")).json;
  assert.ok(raw.raw && raw.headers["paypal-transmission-sig"], "needs one delivered webhook; run a capture first and wait for delivery");
  const orig = JSON.parse(raw.raw); raw.event = raw.raw;
  log("replaying delivered event", orig.id, orig.event_type);
  const before = (await call("GET", "/api/webhooks")).json.rejected;
  const tampered = structuredClone(orig); tampered.resource.amount = { currency_code: "USD", value: "1.00" }; tampered.summary = "tampered";
  const bad = await call("POST", "/api/webhook", tampered, raw.headers);
  log("tampered ->", JSON.stringify(bad.json)); assert.equal(bad.json.stored, false); assert.equal(bad.json.verifyStatus, "FAILURE");
  const forged = await call("POST", "/api/webhook", { id: "WH-FORGED", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "X", amount: { value: "99999.00" } } }, { "paypal-transmission-sig": "AAAA" });
  log("forged, no valid headers ->", JSON.stringify(forged.json)); assert.equal(forged.json.stored, false);
  const good = await call("POST", "/api/webhook", raw.event, raw.headers);
  log("genuine replay ->", JSON.stringify(good.json)); assert.equal(good.json.stored, true); assert.equal(good.json.verifyStatus, "SUCCESS"); assert.equal(good.json.duplicate, true);
  assert.equal((await call("GET", "/api/webhooks")).json.rejected, before + 2); log("rejected-delivery counter rose by 2");
});

test("RECORD RECONSTRUCTION, deterministic part: order, gap, repeats and unplaceable entries are found by code", () => {
  const A = analyse(MESSY_SAMPLE);
  assert.deepEqual(A.sorted.map((e) => e.id), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E9"]);
  assert.deepEqual(A.outOfOrder, ["E1", "E3", "E2", "E4", "E5", "E6"], "entries logged after a later-timed entry");
  assert.equal(A.gaps.length, 1); assert.equal(A.gaps[0].minutes, 74); assert.equal(A.gaps[0].fromTime, "02:26"); assert.equal(A.gaps[0].toTime, "03:40");
  assert.equal(A.repeated[0].person, "Dr. Okafor"); assert.equal(A.repeated[0].outboundAttempts.length, 3);
  assert.deepEqual(A.unplaceable.map((e) => e.id), ["E8"]); assert.ok(A.secondHand.includes("E7") && A.secondHand.includes("E8"));
  log("gap:", A.gaps[0].fromTime, "to", A.gaps[0].toTime, A.gaps[0].minutes, "min | repeated contacts:", A.repeated[0].outboundAttempts.map((a) => a.time).join(", "), "| unplaceable:", A.unplaceable.map((e) => e.id).join(","));
});

test("RECORD RECONSTRUCTION, grounding check rejects an invented time and an invented duration", () => {
  const A = analyse(MESSY_SAMPLE);
  const ok = checkNarrative("Dr. Okafor was paged at 02:11 and 02:26. Nothing is logged for 74 minutes after 02:26.", A);
  const bad = checkNarrative("Dr. Okafor was reached at 03:05 after a 45 minutes wait.", A);
  log("grounded ->", JSON.stringify(ok), "| invented ->", JSON.stringify(bad));
  assert.equal(ok.ok, true); assert.equal(bad.ok, false); assert.deepEqual(bad.badTimes, ["03:05"]); assert.deepEqual(bad.badDurations, ["45"]);
});

test("RECORD RECONSTRUCTION, AGENT: flags the gap instead of filling it", async () => {
  const r = (await call("POST", "/api/reconstruct", {})).json;
  log("source:", r.source, "| turns", r.agent?.turns, "tool calls", r.agent?.toolCalls, "| findings", r.findings.length, "| ms", r.ms);
  log("narrative:", r.record.narrative);
  log("not recorded:", JSON.stringify(r.record.notRecorded));
  assert.equal(r.gaps[0].minutes, 74);
  if (r.source === "agent") {
    assert.ok(checkNarrative(r.record.narrative, analyse(MESSY_SAMPLE)).ok, "narrative is grounded");
    assert.ok(r.findings.some((f) => f.kind === "unlogged_gap"), "gap recorded as a finding");
    const stated = r.record.notRecorded.join(" ") + " " + r.record.narrative;
    assert.ok(/02:26/.test(stated) && /03:40/.test(stated) && (r.record.notRecorded.some((n) => /02:26.*03:40/.test(n)) || /nothing (is |was )?(recorded|logged)|not recorded/i.test(r.record.narrative)), "the 02:26 to 03:40 gap is listed as not recorded");
  }
});

test("bad input: unknown scenario 400, unknown case 404, unknown route 404, oversize reconstruct 400", async () => {
  assert.equal((await call("POST", "/api/cases", { scenarioId: "nope" })).status, 400);
  assert.equal((await call("GET", "/api/cases/zzzz")).status, 404);
  assert.equal((await call("GET", "/api/nothing")).status, 404);
  assert.equal((await call("POST", "/api/reconstruct", { entries: Array.from({ length: 41 }, (_, i) => ({ id: "x" + i, text: "t" })) })).status, 400);
});

/* ---------------- fund pool: one authorization, many partial captures ---------------- */
const SP = "fund-test";
test("POOL: one $250,000 authorization funds several guarantees; each draws with partial captures", async () => {
  const closed = await call("POST", "/api/pool/close", { sponsorId: SP }); // clean slate from an earlier run, ignore result
  const open = (await call("POST", "/api/pool/open", { sponsorId: SP, amount: 250000 })).json.pool;
  assert.equal(open.status, "open"); assert.equal(open.amount, "250000.00");
  log("fund opened: authorization", open.authId, "$" + open.amount, "remaining", open.remaining);
  const again = (await call("POST", "/api/pool/open", { sponsorId: SP, amount: 250000 })).json.pool; assert.equal(again.authId, open.authId); log("opening again is idempotent: same authorization", again.authId);
  const mk2 = async (sc) => (await call("POST", "/api/cases", { scenarioId: sc, sponsorId: SP, mode: "pool", sizing: "deterministic" })).json;
  let a = await mk2("neck-bleed"), b = await mk2("jaw");
  assert.equal(a.mode, "pool");
  a = await step(a.id, "authorize"); b = await step(b.id, "authorize");
  assert.equal(a.auth.authId, open.authId); assert.equal(b.auth.authId, open.authId); assert.equal(a.auth.status, "RESERVED");
  let view = (await call("GET", "/api/pool", { sponsorId: SP })).json.pool;
  log("two guarantees reserved against ONE authorization", open.authId, "| reserved", view.reserved, "| remaining", view.remaining);
  assert.equal(Number(view.reserved), Number(a.auth.amount) + Number(b.auth.amount));
  for (const c of [a, b]) await step(c.id, "contact");
  a = await step(a.id, "document"); assert.equal(a.state, "partially_captured");
  b = await step(b.id, "document"); b = await step(b.id, "discharge"); assert.equal(b.state, "captured");
  a = await step(a.id, "discharge"); assert.equal(a.state, "captured");
  view = (await call("GET", "/api/pool", { sponsorId: SP })).json.pool;
  const g = await pp.getAuthorization(open.authId);
  log("drawn", view.drawn, "| PayPal authorization status", g.status, "| reserved", view.reserved, "| remaining on the fund", view.remaining);
  assert.equal(Number((Number(view.drawn) - Number(open.drawn)).toFixed(2)), Number((Number(a.capture.amount) + Number(b.capture.amount)).toFixed(2)), "drawn rose by exactly what the two cases captured"); assert.equal(g.status, "PARTIALLY_CAPTURED"); assert.equal(view.reserved, "0.00");
});

test("POOL: void of a pool case releases only a reservation; the fund survives", async () => {
  let c = (await call("POST", "/api/cases", { scenarioId: "transfer", sponsorId: SP, mode: "pool", sizing: "deterministic" })).json;
  for (const s of ["authorize", "contact", "void"]) c = await step(c.id, s);
  assert.equal(c.state, "voided");
  const view = (await call("GET", "/api/pool", { sponsorId: SP })).json.pool; assert.equal(view.status, "open");
  assert.notEqual((await pp.getAuthorization(view.authId)).status, "VOIDED"); log("case voided; fund authorization", view.authId, "still live");
});

test("POOL: a guarantee larger than the free fund is refused with the amount short", async () => {
  const c = (await call("POST", "/api/cases", { scenarioId: "neck-bleed", sponsorId: SP, mode: "pool", sizing: "deterministic" })).json;
  // fill the fund with reservations until one more cannot fit
  let n = 0, last;
  for (; n < 8; n++) { const x = (await call("POST", "/api/cases", { scenarioId: "neck-bleed", sponsorId: SP, mode: "pool", sizing: "deterministic" })).json; last = await call("POST", `/api/cases/${x.id}/authorize`, {}); if (last.status !== 200) break; }
  log("reservations accepted before refusal:", n, "| refusal:", last.status, last.json.error);
  assert.equal(last.status, 409); assert.match(last.json.error, /fund has \$/);
});

test("POOL: sweep after day 4 asks PayPal to reauthorize the fund; the real refusal is recorded", async () => {
  const r = (await call("POST", "/api/pool/sweep", { sponsorId: SP, simulateDays: 4 })).json;
  log("fund sweep, simulated day 4 ->", r.sweep.action, r.sweep.issue); assert.equal(r.sweep.action, "refused"); assert.equal(r.sweep.issue, "REAUTHORIZATION_TOO_SOON");
  assert.ok(r.pool.log.some((l) => /refused by PayPal/.test(l.text)));
});

test("POOL: closing the fund is blocked while guarantees are open, then voids the authorization", async () => {
  const blocked = await call("POST", "/api/pool/close", { sponsorId: SP });
  log("close with open reservations ->", blocked.status, blocked.json.error); assert.equal(blocked.status, 409);
  await call("POST", "/api/reset", {}); // clears cases (and their reservations); the fund itself stays
  const closed = (await call("POST", "/api/pool/close", { sponsorId: SP })).json.pool;
  assert.equal(closed.status, "closed"); assert.equal((await pp.getAuthorization(closed.authId)).status, "VOIDED"); log("fund closed; authorization", closed.authId, "VOIDED");
});
