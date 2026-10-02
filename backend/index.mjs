import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import * as pp from "./paypal.mjs";
import { SCENARIOS, SPONSORS, PRICES, HOSPITAL, MESSY_SAMPLE } from "./data.mjs";
import { draftAudit, priceLines } from "./ai.mjs";
import { sizeWithAgent, reconstruct } from "./agent.mjs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = () => process.env.TABLE || "holdfast";
const MAX_CASES = 300, DAY = 86400000, HONOR_DAYS = 3, AUTH_DAYS = 29;
const OPEN = ["authorized", "accepted", "partially_captured"];

const get = async (pk) => (await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk } }))).Item?.v;
const put = (pk, v) => ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk, v, ts: Date.now() } }));
const del = (pk) => ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk } }));
const scan = async (prefix) => {
  const out = []; let key;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: TABLE(), ExclusiveStartKey: key, FilterExpression: "begins_with(pk, :p)", ExpressionAttributeValues: { ":p": prefix } }));
    out.push(...r.Items); key = r.LastEvaluatedKey;
  } while (key);
  return out;
};
const J = (status, body) => ({ statusCode: status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
const httpErr = (s, m) => Object.assign(new Error(m), { status: s });
const nowIso = (at) => new Date(at ?? Date.now()).toISOString();
const ev = (c, type, text, at) => { c.events.push({ t: nowIso(at), type, text }); };
const D = (v) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const track = (c, op, id) => { (c.requests ||= []).push({ op, id, t: nowIso() }); return id; };

/* ---------- sponsors ---------- */
async function sponsorToken(sp) { return (await get(`sponsor#${sp.id}`))?.vaultId || process.env[sp.tokenEnv]; }
async function sponsorView() {
  const out = [];
  for (const s of SPONSORS) out.push({ ...s, vaultId: await sponsorToken(s) });
  for (const e of await scan("sponsor-live#")) out.push(e.v);
  return out;
}
const findSponsor = async (id) => (await sponsorView()).find((s) => s.id === id);
const heldCents = (c) => pp.cents(c.auth.amount) - (c.captures || []).reduce((a, x) => a + pp.cents(x.amount), 0);
async function openHolds() {
  const cutoff = Date.now() - 2 * 3600 * 1000; // a demo hold abandoned for 2 hours stops counting
  return (await scan("case#")).map((i) => i.v).filter((c) => OPEN.includes(c.state) && c.auth && !c.auth.pool && new Date(c.created) > cutoff).reduce((a, c) => a + heldCents(c), 0);
}

/* ---------- fund pool: one authorization, many partial captures ---------- */
const poolKey = (spId) => `pool#${spId}`;
const reservedCents = async (spId) => (await scan("case#")).map((i) => i.v).filter((c) => c.auth?.pool && c.sponsorId === spId && OPEN.includes(c.state)).reduce((a, c) => a + heldCents(c), 0);
async function poolView(spId) {
  const p = await get(poolKey(spId)); if (!p) return null;
  const reserved = await reservedCents(spId);
  const authLeft = pp.cents(p.authAmount) - pp.cents(p.authCaptured);
  return { ...p, reserved: pp.money(reserved), remaining: pp.money(Math.max(0, authLeft - reserved)), authLeft: pp.money(authLeft) };
}
async function openPool(spId, amount) {
  const sp = await findSponsor(spId); if (!sp?.vaultId) throw httpErr(400, "sponsor has no vaulted instrument");
  const existing = await get(poolKey(spId)); if (existing?.status === "open") return poolView(spId);
  const amt = Number(amount || 250000); if (!(amt >= 1000 && amt <= 500000)) throw httpErr(400, "Choose a fund between $1,000 and $500,000.");
  const n = (existing?.generation || 0) + 1;
  const t0 = Date.now();
  const r = await pp.authorizeWithVault({ vaultId: sp.vaultId, amount: pp.money(pp.cents(amt)), description: `Fund authorization, ${sp.name}`, customId: `pool-${spId}`, requestId: `hf-pool-${spId}-${n}` });
  const a = authFrom(r);
  await put(poolKey(spId), { sponsorId: spId, sponsorName: sp.name, status: "open", generation: n, amount: pp.money(pp.cents(amt)), authAmount: a.amount, authCaptured: "0.00", drawn: "0.00", lifetimeDrawn: existing ? pp.money(pp.cents(existing.lifetimeDrawn || "0") + pp.cents(existing.drawn || "0")) : "0.00", orderId: a.orderId, authId: a.authId, created: a.created, expires: a.expires, honorUntil: a.honorUntil, reauths: [], reissues: 0, log: [{ t: nowIso(), text: `Fund of ${D(a.amount)} authorized once on ${sp.name}'s vaulted instrument (${a.authId}, ${Date.now() - t0} ms).` }] });
  return poolView(spId);
}
async function closePool(spId) {
  const p = await get(poolKey(spId)); if (!p || p.status !== "open") throw httpErr(409, "No open fund to close.");
  const view = await poolView(spId);
  if (pp.cents(view.reserved) > 0) throw httpErr(409, `Close or settle the open guarantees first: ${D(view.reserved)} is still reserved.`);
  const left = view.authLeft;
  await pp.voidAuth(p.authId, `hf-pool-${spId}-${p.generation}-close`);
  p.status = "closed"; p.log.push({ t: nowIso(), text: `Fund closed. Authorization ${p.authId} voided; ${D(left)} released to the sponsor. Total drawn ${D(p.drawn)}.` });
  await put(poolKey(spId), p);
  return poolView(spId);
}
async function poolEnsureLive(p, needCents) {
  let status; try { status = (await pp.getAuthorization(p.authId)).status; } catch (e) { status = "UNKNOWN:" + e.issue; }
  if (["CREATED", "PENDING", "PARTIALLY_CAPTURED"].includes(status)) return false;
  const sp = await findSponsor(p.sponsorId);
  const left = pp.cents(p.authAmount) - pp.cents(p.authCaptured);
  const r = await pp.authorizeWithVault({ vaultId: sp.vaultId, amount: pp.money(Math.max(left, needCents)), description: `Fund re-issued, ${sp.name}`, customId: `pool-${p.sponsorId}`, requestId: `hf-pool-${p.sponsorId}-${p.generation}-reissue-${p.reissues + 1}` });
  const a = authFrom(r), old = p.authId;
  Object.assign(p, { authId: a.authId, orderId: a.orderId, authAmount: a.amount, authCaptured: "0.00", created: a.created, expires: a.expires, honorUntil: a.honorUntil, reissues: p.reissues + 1 });
  p.log.push({ t: nowIso(), text: `Fund authorization ${old} was ${status}. Re-issued ${D(a.amount)} as ${a.authId}.` });
  return true;
}
async function sweepPool(spId, at = Date.now()) {
  const p = await get(poolKey(spId)); if (!p || p.status !== "open") return { action: "none" };
  if (at < new Date(p.honorUntil).getTime()) return { action: "none", note: `inside honor period until ${p.honorUntil}` };
  const left = pp.cents(p.authAmount) - pp.cents(p.authCaptured);
  if (at - new Date(p.created).getTime() >= AUTH_DAYS * DAY) { await poolEnsureLive(p, left); await put(poolKey(spId), p); return { action: "reissued" }; }
  const n = p.reauths.length + 1;
  try {
    const r = await pp.reauthorize(p.authId, pp.money(left), `hf-pool-${spId}-${p.generation}-reauth-${n}`);
    p.reauths.push({ t: nowIso(at), ok: true, id: r.id }); p.honorUntil = nowIso(at + HONOR_DAYS * DAY); if (r.id) p.authId = r.id;
    p.log.push({ t: nowIso(at), text: `Honor period ended; fund reauthorized for ${D(pp.money(left))}. New honor period to ${p.honorUntil.slice(0, 10)}.` });
    await put(poolKey(spId), p); return { action: "reauthorized" };
  } catch (e) {
    p.reauths.push({ t: nowIso(at), ok: false, issue: e.issue, status: e.status });
    p.log.push({ t: nowIso(at), text: `Fund reauthorization refused by PayPal (${e.issue}). The fund stays in place; the sweep retries on its next run.` });
    await put(poolKey(spId), p); return { action: "refused", issue: e.issue, paypal: e.body?.details?.[0]?.description };
  }
}

const saveCase = (c) => put(`case#${c.id}`, c);
const loadCase = async (id) => { const c = await get(`case#${id}`); if (!c) throw httpErr(404, "case not found"); return c; };
const scOf = (c) => SCENARIOS.find((s) => s.id === c.scenarioId);

/* ---------- lifecycle ---------- */
// One writer per transition. A conditional put claims the step; a concurrent caller waits for the winner and
// returns the same result, so a double click or a retry can never move money twice.
async function once(id, key, done, fn) {
  const pk = `lock#${id}#${key}`;
  try { await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk, v: nowIso(), ts: Date.now() }, ConditionExpression: "attribute_not_exists(pk)" })); }
  catch (e) {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    for (let i = 0; i < 40; i++) { const c = await loadCase(id); if (done(c)) return c; await new Promise((r) => setTimeout(r, 500)); }
    throw httpErr(409, "that step is already in progress");
  }
  try { return await fn(); } catch (e) { await del(pk); throw e; }
}
const stateIs = (...s) => (c) => s.includes(c.state);
async function createCase({ scenarioId, sponsorId, idempotencyKey, sizing: mode, mode: fundMode }) {
  const deterministic = mode === "deterministic";
  const sc = SCENARIOS.find((s) => s.id === scenarioId); if (!sc) throw httpErr(400, "unknown scenario");
  if (idempotencyKey) { const prev = await get(`idem#${idempotencyKey}`); if (prev) return { ...(await loadCase(prev)), replayed: true }; }
  let sp = await findSponsor(sponsorId || SPONSORS[0].id); if (!sp?.vaultId) throw httpErr(400, "sponsor has no vaulted instrument");
  if ((await scan("case#")).length >= MAX_CASES) throw httpErr(429, "demo case limit reached; POST /api/reset");
  const id = randomUUID().slice(0, 8);
  const c = { id, scenarioId, patient: sc.patient, hospital: HOSPITAL.name, sponsorId: sp.id, sponsorName: sp.name, state: "presented", events: [], created: nowIso(), captures: [], requests: [] };
  if (idempotencyKey) await put(`idem#${idempotencyKey}`, id);
  ev(c, "presented", `Patient ${sc.patient} presented to ${HOSPITAL.name}. ED physician documented the emergency condition and requested ${sc.specialty}.`);
  const pool = fundMode === "pool" ? await poolView(sp.id) : null;
  if (fundMode === "pool" && pool?.status !== "open") throw httpErr(409, "Open the fund first, then size guarantees against it.");
  c.mode = pool ? "pool" : "hold";
  const holds = pool ? pp.cents(pool.authAmount) - pp.cents(pool.remaining) : await openHolds();
  if (pool) sp = { ...sp, pledge: Number(pool.authAmount), name: sp.name + " (fund pool)" };
  let sizing = deterministic ? await sizeWithAgent({ scenario: sc, sponsor: sp, openHoldsCents: holds, skipAgent: true }) : await sizeWithAgent({ scenario: sc, sponsor: sp, openHoldsCents: holds });
  if (sizing.source === "agent") await put(`lastsize#${scenarioId}`, { ...sizing, at: nowIso() });
  else if (!deterministic) { // the model account is rate limited: reuse the last agent plan for this scenario, re-priced and re-checked here
    const prev = await get(`lastsize#${scenarioId}`);
    if (prev) {
      const { lines, subtotalCents } = priceLines(prev.lines.map((l) => ({ code: l.code, units: l.units })));
      const total = Math.round(subtotalCents * (1 + prev.contingencyPct / 100));
      if (total <= pp.cents(sp.perCaseCap) && total <= pp.cents(sp.pledge) - holds) sizing = { ...prev, lines, subtotal: pp.money(subtotalCents), amount: pp.money(total), source: "replayed", replayedFrom: prev.at, error: sizing.error, ms: sizing.ms };
    }
  }
  c.sizing = sizing;
  ev(c, "sized", `Guarantee sized at ${D(sizing.amount)} from ${sizing.lines.length} published price lines plus ${sizing.contingencyPct}% contingency by ${sizing.source === "agent" ? `the sizing agent (${sizing.agent.toolCalls} tool calls over ${sizing.agent.turns} turns)` : sizing.source === "replayed" ? `a stored agent plan from ${sizing.replayedFrom} (model capacity was limited)` : "deterministic sizing"} in ${sizing.ms} ms.`);
  c.state = "sized";
  await saveCase(c);
  return c;
}

const authFrom = (r, extra = {}) => ({ orderId: r.orderId, authId: r.authorization.id, amount: r.authorization.amount.value, status: r.authorization.status, created: r.authorization.create_time, expires: r.authorization.expiration_time, honorUntil: nowIso(new Date(r.authorization.create_time).getTime() + HONOR_DAYS * DAY), reauths: [], ...extra });

async function authorize(c0) {
  if (c0.auth) return c0; // replay: the hold already exists, never a second one
  if (c0.state !== "sized") throw httpErr(409, `case is ${c0.state}`);
  return once(c0.id, "authorize", (c) => !!c.auth, () => authorizeNow(c0));
}
async function authorizeNow(c) {
  const sp = await findSponsor(c.sponsorId);
  const t0 = Date.now();
  if (c.mode === "pool") { // no new PayPal authorization: the guarantee is reserved against the fund already authorized
    const p = await poolView(c.sponsorId);
    if (!p || p.status !== "open") throw httpErr(409, "The fund is closed. Open the fund first.");
    if (pp.cents(c.sizing.amount) > pp.cents(p.remaining)) throw httpErr(409, `The fund has ${D(p.remaining)} left and this guarantee needs ${D(c.sizing.amount)}. Open a larger fund.`);
    c.auth = { orderId: p.orderId, authId: p.authId, amount: c.sizing.amount, status: "RESERVED", created: nowIso(), expires: p.expires, honorUntil: p.honorUntil, reauths: [], pool: true, ms: Date.now() - t0 };
    c.state = "authorized";
    ev(c, "authorized", `${D(c.auth.amount)} reserved against the sponsor's fund (PayPal authorization ${p.authId}, authorized once for ${D(p.amount)}) in ${c.auth.ms} ms. ${D(pp.money(pp.cents(p.remaining) - pp.cents(c.auth.amount)))} of the fund stays free. Hospital notified of honoured commitment.`);
    await saveCase(c);
    return c;
  }
  const r = await pp.authorizeWithVault({ vaultId: sp.vaultId, amount: c.sizing.amount, description: `Emergency surgery guarantee, case ${c.id}`, customId: c.id, requestId: track(c, "authorize", `hf-${c.id}-auth`) });
  c.auth = authFrom(r, { ms: Date.now() - t0 });
  c.state = "authorized";
  ev(c, "authorized", `Guarantee of ${D(c.auth.amount)} authorized on ${c.sponsorName}'s vaulted instrument in ${c.auth.ms} ms. PayPal authorization ${c.auth.authId}. Funds guaranteed by PayPal for ${HONOR_DAYS} days (to ${c.auth.honorUntil.slice(0, 10)}), authorization valid to ${c.auth.expires.slice(0, 10)}. Hospital notified of honoured commitment.`);
  await saveCase(c);
  return c;
}

async function contact(c0) {
  if (c0.state !== "authorized") throw httpErr(409, `case is ${c0.state}`);
  return once(c0.id, "contact", (c) => c.state !== "authorized", () => contactNow(c0));
}
async function contactNow(c) {
  const sc = scOf(c);
  ev(c, "oncall_contacted", `On-call specialist contacted: ${sc.onCall}. Honoured guarantee ${c.auth.authId} of ${D(c.auth.amount)} shared with the request.`);
  ev(c, "oncall_response", `${sc.onCall} responded: "${sc.acceptNote}" (scripted demo response)`);
  c.state = "accepted";
  await saveCase(c);
  return c;
}

// A hold that PayPal no longer considers live (expired, or voided out from under us) is re-issued from the
// vaulted token before capture, so a long stay never fails at the moment the hospital bills.
async function ensureLive(c, needCents) {
  let status;
  try { status = (await pp.getAuthorization(c.auth.authId)).status; } catch (e) { status = "UNKNOWN:" + e.issue; }
  c.auth.status = status;
  if (["CREATED", "PENDING", "PARTIALLY_CAPTURED"].includes(status)) return;
  const sp = await findSponsor(c.sponsorId);
  const reqId = track(c, "reissue", `hf-${c.id}-reissue-${(c.auth.reissues || 0) + 1}`);
  const r = await pp.authorizeWithVault({ vaultId: sp.vaultId, amount: pp.money(needCents), description: `Re-issued guarantee, case ${c.id}`, customId: c.id, requestId: reqId });
  const old = c.auth.authId;
  c.auth = authFrom(r, { ms: c.auth.ms, reissues: (c.auth.reissues || 0) + 1, prior: [...(c.auth.prior || []), { authId: old, status }], amount: pp.money(needCents + (c.captures || []).reduce((a, x) => a + pp.cents(x.amount), 0)) });
  ev(c, "reissued", `Authorization ${old} was ${status} before capture. Re-issued ${D(pp.money(needCents))} from the vaulted token as ${c.auth.authId}.`);
}

async function captureStage(c0, stage) {
  if (stage === "procedure" ? c0.state !== "accepted" : c0.state !== "partially_captured") throw httpErr(409, `case is ${c0.state}`);
  return once(c0.id, `capture-${stage}`, (c) => c.state !== c0.state, () => captureNow(c0, stage));
}
async function captureNow(c, stage) {
  const sc = scOf(c);
  const isFinal = stage === "discharge" || sc.stay.length === 0;
  const lineSet = stage === "procedure" ? sc.procedure : sc.stay;
  const { lines, subtotalCents } = priceLines(lineSet.map(([code, units]) => ({ code, units })));
  const remaining = heldCents(c);
  const amount = Math.min(subtotalCents, remaining);
  ev(c, "documented", stage === "procedure" ? `Procedure documented: ${sc.procedureNote} Procedure lines total ${D(pp.money(subtotalCents))}.` : `Discharge documented. Inpatient stay lines total ${D(pp.money(subtotalCents))}.`);
  const pool = c.mode === "pool" ? await get(poolKey(c.sponsorId)) : null;
  if (pool) { if (await poolEnsureLive(pool, amount)) ev(c, "reissued", `The fund's authorization had lapsed; it was re-issued as ${pool.authId} before capture.`); c.auth.authId = pool.authId; }
  else await ensureLive(c, remaining);
  const t0 = Date.now();
  const cap = await pp.capture(c.auth.authId, pp.money(amount), track(c, `capture-${stage}`, `hf-${c.id}-capture-${stage}-${pool ? pool.generation + "-" + pool.reissues : c.auth.reissues || 0}`), `Emergency surgery, case ${c.id}`, isFinal && !pool);
  if (pool) { pool.authCaptured = pp.money(pp.cents(pool.authCaptured) + amount); pool.drawn = pp.money(pp.cents(pool.drawn) + amount); pool.log.push({ t: nowIso(), text: `Case ${c.id}: partial capture ${cap.id} of ${D(pp.money(amount))} (final_capture false). Fund drawn to ${D(pool.drawn)}.` }); await put(poolKey(c.sponsorId), pool); }
  c.captures.push({ id: cap.id, stage, amount: pp.money(amount), final: isFinal, status: cap.status, ms: Date.now() - t0, lines });
  const total = c.captures.reduce((a, x) => a + pp.cents(x.amount), 0);
  const released = isFinal ? pp.cents(c.auth.amount) - total : 0;
  c.capture = { id: c.captures.map((x) => x.id).join(" + "), amount: pp.money(total), status: cap.status, released: pp.money(Math.max(0, released)), lines: c.captures.flatMap((x) => x.lines), ms: c.captures.reduce((a, x) => a + x.ms, 0), parts: c.captures.length };
  if (isFinal) {
    c.state = "captured";
    ev(c, "captured", pool ? `Capture ${cap.id} for ${D(pp.money(amount))} closes the case. Total charged ${D(c.capture.amount)}; the unused ${D(c.capture.released)} of the reservation returns to the fund.` : `Final capture ${cap.id} for ${D(pp.money(amount))}. Total charged ${D(c.capture.amount)}; the unused ${D(c.capture.released)} of the hold is released to the sponsor.`);
  } else {
    c.state = "partially_captured";
    ev(c, "partially_captured", `Partial capture ${cap.id} for ${D(pp.money(amount))} (not final). ${D(pp.money(heldCents(c)))} of the hold remains open for the inpatient stay.`);
  }
  await saveCase(c);
  return c;
}

async function voidCase(c0) {
  if (!OPEN.includes(c0.state)) throw httpErr(409, `case is ${c0.state}`);
  return once(c0.id, "void", (c) => c.state === "voided", () => voidNow(c0));
}
async function voidNow(c) {
  const sc = scOf(c);
  if (c.state !== "partially_captured") ev(c, "not_performed", sc.outcome === "void" ? sc.procedureNote : "Procedure not performed. The case was closed before the procedure was documented."); else ev(c, "stay_ended", "Remaining care cancelled before the final capture; the open hold is released.");
  const left = heldCents(c);
  const t0 = Date.now();
  if (!c.auth.pool) await pp.voidAuth(c.auth.authId, track(c, "void", `hf-${c.id}-void`)); // pool cases only release a reservation; voiding would end the whole fund
  c.void = { ms: Date.now() - t0, released: pp.money(left) };
  c.state = "voided";
  ev(c, "voided", c.auth.pool ? `Reservation released back to the fund. Sponsor charged ${D(pp.money(c.captures.reduce((a, x) => a + pp.cents(x.amount), 0)))} in total; ${D(pp.money(left))} returned to the fund.` : `Authorization ${c.auth.authId} voided. Sponsor charged ${D(pp.money(c.captures.reduce((a, x) => a + pp.cents(x.amount), 0)))} in total; ${D(pp.money(left))} of hold released.`);
  await saveCase(c);
  return c;
}

// Reauthorize after the 3-day honor period (day 4 to 29), re-issue after day 29. `at` lets a test or the UI
// fast-forward OUR clock; PayPal's clock is real, so a premature call is refused and we record the refusal.
async function sweepCase(c, at = Date.now()) {
  if (c.auth?.pool) { const r = await sweepPool(c.sponsorId, new Date(c.auth.created).getTime() + (at - new Date(c.created).getTime())); return { c: await loadCase(c.id), ...r }; }
  if (!OPEN.includes(c.state) || !c.auth) return { c, action: "none" };
  const age = at - new Date(c.auth.created).getTime();
  if (at < new Date(c.auth.honorUntil).getTime()) return { c, action: "none", note: `inside honor period until ${c.auth.honorUntil}` };
  const left = heldCents(c);
  if (age >= AUTH_DAYS * DAY) { await ensureLive(c, left); c.auth.status = "REISSUED"; await saveCase(c); return { c, action: "reissued" }; }
  const n = (c.auth.reauths?.length || 0) + 1;
  try {
    const r = await pp.reauthorize(c.auth.authId, pp.money(left), track(c, "reauthorize", `hf-${c.id}-reauth-${n}`));
    c.auth.reauths.push({ t: nowIso(at), ok: true, id: r.id, amount: pp.money(left) });
    c.auth.honorUntil = nowIso(at + HONOR_DAYS * DAY);
    if (r.id) c.auth.authId = r.id;
    ev(c, "reauthorized", `Honor period ended; reauthorized ${D(pp.money(left))} (${r.id}). New honor period to ${c.auth.honorUntil.slice(0, 10)}.`, at);
    await saveCase(c); return { c, action: "reauthorized" };
  } catch (e) {
    c.auth.reauths.push({ t: nowIso(at), ok: false, issue: e.issue, status: e.status });
    ev(c, "reauth_refused", `Reauthorization of ${c.auth.authId} was refused by PayPal (${e.issue}). The hold stays in place; the sweep will try again on its next run.`, at);
    await saveCase(c); return { c, action: "refused", issue: e.issue, paypal: e.body?.details?.[0]?.description };
  }
}
async function sweepAll() {
  const out = [];
  for (const i of await scan("case#")) { const c = i.v; if (OPEN.includes(c.state) && c.auth && Date.now() >= new Date(c.auth.honorUntil).getTime()) { const r = await sweepCase(c); out.push({ id: c.id, action: r.action, issue: r.issue }); } }
  for (const sp of SPONSORS) { const p = await get(poolKey(sp.id)); if (p?.status === "open") out.push({ pool: sp.id, ...(await sweepPool(sp.id)) }); }
  console.log("sweep", JSON.stringify(out));
  return out;
}

async function audit(c) {
  const key = c.events.length;
  if (c.audit?.key === key && c.audit.source === "bedrock") return c;
  c.audit = { ...(await draftAudit(c)), key };
  await saveCase(c);
  return c;
}

/* ---------- webhooks ---------- */
async function webhook(event, rawHeaders, rawBody) {
  const headers = Object.fromEntries(Object.entries(rawHeaders || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const wid = await get("meta#webhook-id");
  let verified = false, verifyStatus = "no webhook id stored";
  if (wid) {
    try { verifyStatus = (await pp.verifyWebhook(wid, headers, event)).verification_status; verified = verifyStatus === "SUCCESS"; }
    catch (e) { verifyStatus = "verify error: " + e.message.slice(0, 100); }
  }
  if (!verified) {
    await put(`hookrej#${Date.now()}-${randomUUID().slice(0, 4)}`, { time: nowIso(), type: event?.event_type, claimedId: event?.id, verifyStatus });
    return { stored: false, verifyStatus };
  }
  const res = event.resource || {};
  const authId = res.supplementary_data?.related_ids?.authorization_id || (event.event_type.startsWith("PAYMENT.AUTHORIZATION") ? res.id : null);
  const dup = !!(await get(`hook#${event.id}`)); // replays of a genuine event are accepted but stored once
  await put(`hook#${event.id}`, { id: event.id, type: event.event_type, resourceId: res.id, authId, amount: res.amount?.value, status: res.status, time: event.create_time });
  if (!dup) await put(`hookraw#${event.id}`, { headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith("paypal-"))), raw: rawBody });
  return { stored: true, duplicate: dup, verifyStatus };
}

/* ---------- http ---------- */
export async function handler(event) {
  if (event.source === "aws.events") return { sweep: await sweepAll() };
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path = (event.rawPath || event.path || "/").replace(/\/+$/, "") || "/";
  if (method === "OPTIONS") return { statusCode: 204, headers: {}, body: "" };
  let body = {}, rawBody = "";
  try { rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : ""; body = rawBody ? JSON.parse(rawBody) : {}; } catch { return J(400, { error: "bad json" }); }
  try {
    let m;
    if (path === "/api/health") return J(200, { ok: true, time: nowIso(), paypal: pp.cfg().api });
    if (path === "/api/config") {
      const holds = await openHolds();
      return J(200, { hospital: HOSPITAL, scenarios: SCENARIOS.map(({ procedure, stay, ...s }) => ({ ...s, hasStay: stay.length > 0 })), prices: PRICES, messySample: MESSY_SAMPLE,
        pool: await poolView(SPONSORS[0].id), sponsors: (await sponsorView()).filter((x) => !x.hidden).map(({ vaultId, tokenEnv, ...s }) => ({ ...s, vaulted: !!vaultId, openHolds: pp.money(holds) })) });
    }
    if (path === "/api/pool" && method === "GET") return J(200, { pool: await poolView(body.sponsorId || SPONSORS[0].id) });
    if (path === "/api/pool/open" && method === "POST") return J(200, { pool: await openPool(body.sponsorId || SPONSORS[0].id, body.amount) });
    if (path === "/api/pool/close" && method === "POST") return J(200, { pool: await closePool(body.sponsorId || SPONSORS[0].id) });
    if (path === "/api/pool/sweep" && method === "POST") {
      const sp = body.sponsorId || SPONSORS[0].id, pl = await get(poolKey(sp)); if (!pl) throw httpErr(409, "Open the fund first.");
      const days = Math.max(0, Math.min(40, Number(body.simulateDays) || 0));
      const r = await sweepPool(sp, new Date(pl.created).getTime() + days * DAY + 60000);
      return J(200, { sweep: { ...r, simulatedDays: days }, pool: await poolView(sp) });
    }
    if (path === "/api/cases" && method === "GET") return J(200, { cases: (await scan("case#")).map((i) => i.v).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 30) });
    if (path === "/api/cases" && method === "POST") return J(200, await createCase({ ...body, idempotencyKey: body.idempotencyKey || event.headers?.["idempotency-key"] }));
    if ((m = path.match(/^\/api\/cases\/([\w-]+)(?:\/(\w+))?$/))) {
      const c = await loadCase(m[1]);
      if (!m[2]) return J(200, c);
      if (method !== "POST") throw httpErr(405, "POST required");
      switch (m[2]) {
        case "authorize": return J(200, await authorize(c));
        case "contact": return J(200, await contact(c));
        case "document": return J(200, await captureStage(c, "procedure"));
        case "discharge": return J(200, await captureStage(c, "discharge"));
        case "void": return J(200, await voidCase(c));
        case "audit": return J(200, await audit(c));
        case "sweep": { const days = Math.max(0, Math.min(40, Number(body.simulateDays) || 0)); const r = await sweepCase(c, new Date(c.auth?.created || Date.now()).getTime() + days * DAY + 60000); return J(200, { ...r.c, sweep: { action: r.action, issue: r.issue, paypal: r.paypal, simulatedDays: days } }); }
      }
    }
    if (path === "/api/reconstruct" && method === "POST") {
      const entries = Array.isArray(body.entries) && body.entries.length ? body.entries : MESSY_SAMPLE;
      if (entries.length > 40) throw httpErr(400, "at most 40 entries");
      const clean = entries.map((e, i) => ({ id: String(e.id || "X" + i).slice(0, 8), source: String(e.source || "unknown").slice(0, 60), time: e.time || null, kind: e.kind, person: e.person && String(e.person).slice(0, 60), direction: e.direction, text: String(e.text || "").slice(0, 500) }));
      const isSample = !body.entries?.length;
      let out = await reconstruct(clean);
      if (isSample && out.source === "agent") await put("lastrecon#sample", out);
      else if (isSample && out.source !== "agent") { const prev = await get("lastrecon#sample"); if (prev) out = { ...prev, source: "replayed", error: out.error }; }
      return J(200, out);
    }
    if (path === "/api/sponsors/setup" && method === "POST") {
      if (!body.returnUrl?.startsWith("https://")) throw httpErr(400, "returnUrl must be https");
      const t = await pp.createSetupToken(body.returnUrl, body.returnUrl);
      return J(200, { setupTokenId: t.id, approveUrl: t.links.find((l) => l.rel === "approve")?.href });
    }
    if (path === "/api/sponsors/vault" && method === "POST") {
      const t = await pp.createPaymentToken(body.setupTokenId, `hf-vault-${body.setupTokenId}`);
      const name = [t.payment_source?.paypal?.name?.given_name, t.payment_source?.paypal?.name?.surname].filter(Boolean).join(" ") || "Sponsor";
      const sp = { id: "live-" + t.id.slice(0, 6), name: `${name} (just onboarded)`, kind: "sponsor", perCaseCap: 120000, pledge: 250000, vaultId: t.id };
      await put(`sponsor-live#${sp.id}`, sp);
      return J(200, { sponsor: { ...sp, vaultId: undefined, vaulted: true } });
    }
    if (path === "/api/webhook" && method === "POST") return J(200, await webhook(body, event.headers, rawBody));
    if (path === "/api/webhooks") {
      const events = (await scan("hook#")).map((i) => i.v).sort((a, b) => (b.time || "").localeCompare(a.time || "")).slice(0, 40);
      return J(200, { events, rejected: (await scan("hookrej#")).length });
    }
    if (path === "/api/webhooks/raw") { const r = (await scan("hookraw#")).sort((a, b) => b.ts - a.ts)[0]; return J(200, r?.v || {}); }
    if (path === "/api/reset" && method === "POST") {
      const all = [...(await scan("case#")), ...(await scan("lock#")), ...(await scan("hook#")), ...(await scan("hookrej#")), ...(await scan("idem#"))];
      await Promise.all(all.map((i) => del(i.pk)));
      return J(200, { cleared: all.length });
    }
    return J(404, { error: "not found", path });
  } catch (e) {
    const status = e.status || (e.where ? 502 : 500);
    console.error(e.message, e.body ? JSON.stringify(e.body).slice(0, 500) : "");
    return J(status, { error: e.message, paypal: e.body ? { issue: e.issue, debug_id: e.body.debug_id } : undefined });
  }
}
