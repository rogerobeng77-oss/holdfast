// Bedrock Converse tool-use agents. The model plans and calls tools in a bounded loop; every tool call is
// logged to a trace that the UI shows. Anything that becomes money or a claim is re-checked in code.
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { br, MODEL, priceLines } from "./ai.mjs";
import { PRICES, BUNDLES, SPONSORS } from "./data.mjs";
import { cents, money } from "./paypal.mjs";

const tool = (name, description, properties, required = []) => ({ toolSpec: { name, description, inputSchema: { json: { type: "object", properties, required } } } });

export async function runAgent({ system, user, tools, handlers, maxTurns = 6, isDone, maxTokens = 1500 }) {
  const trace = []; const messages = [{ role: "user", content: [{ text: user }] }];
  let finalText = "", turns = 0, stop = "";
  while (turns < maxTurns) {
    turns++;
    const t0 = Date.now();
    const r = await br.send(new ConverseCommand({ modelId: MODEL, system: [{ text: system }], messages, toolConfig: { tools },
      inferenceConfig: { maxTokens, temperature: 0.1 } }));
    const msg = r.output.message; messages.push(msg);
    const text = msg.content.filter((c) => c.text).map((c) => c.text).join("").trim();
    const uses = msg.content.filter((c) => c.toolUse);
    if (text) trace.push({ turn: turns, kind: "model", text: text.slice(0, 600), ms: Date.now() - t0 });
    if (!uses.length) { finalText = text; stop = "end_turn"; break; }
    const results = [];
    for (const u of uses) {
      const t1 = Date.now(); let out, ok = true;
      try { out = await handlers[u.toolUse.name](u.toolUse.input || {}); } catch (e) { ok = false; out = { error: String(e.message || e) }; }
      trace.push({ turn: turns, kind: "tool", name: u.toolUse.name, input: u.toolUse.input, output: summarize(out), ok, ms: Date.now() - t1 });
      results.push({ toolResult: { toolUseId: u.toolUse.toolUseId, content: [{ json: out }], status: ok ? "success" : "error" } });
    }
    messages.push({ role: "user", content: results });
    if (isDone?.()) { stop = "done"; break; }
  }
  if (!stop) stop = "max_turns";
  return { trace, finalText, turns, stop };
}
const summarize = (o) => { const t = JSON.stringify(o); return t.length > 700 ? JSON.parse(JSON.stringify({ truncated: t.slice(0, 700) + "…" })) : o; };

/* ======================= 1. SIZING AGENT ======================= */
export async function sizeWithAgent({ scenario, sponsor, openHoldsCents, skipAgent = false }) {
  const t0 = Date.now();
  const remaining = () => Math.max(0, cents(sponsor.pledge) - openHoldsCents);
  let best = null;
  const tools = [
    tool("get_price_record", "Search the hospital's published price file by code or keyword (query \"all\" returns the whole file). Returns lines with unit and standard charge.", { query: { type: "string" } }, ["query"]),
    tool("lookup_procedure_bundle", "Typical resource use (code, min units, max units) for an emergency procedure of this kind. Use it as a starting point; it is a range, not a quote.", { specialty: { type: "string" }, procedure: { type: "string" } }, ["specialty"]),
    tool("check_sponsor_balance", "The sponsor's pledged balance, holds already open, what remains, and the per-case limit.", { sponsor_id: { type: "string" } }, ["sponsor_id"]),
    tool("propose_guarantee", "Price a guarantee. lines are [{code, units}]; contingency_pct is 5 to 25. Returns the computed total and any problems. Call again with fixes until ok is true. Your final action must be a successful call; include a short rationale.", {
      lines: { type: "array", items: { type: "object", properties: { code: { type: "string" }, units: { type: "number" } }, required: ["code", "units"] } },
      contingency_pct: { type: "number" }, rationale: { type: "string" } }, ["lines", "contingency_pct"]),
  ];
  const handlers = {
    get_price_record: ({ query }) => {
      const q = String(query || "").toLowerCase();
      if (!q || q === "all" || q === "*") return { matches: PRICES.map((p) => ({ code: p.code, description: p.desc, per: p.unit, standard_charge_usd: p.price })) };
      const m = PRICES.filter((p) => p.code.toLowerCase() === q || p.desc.toLowerCase().includes(q) || q.split(/\s+/).some((w) => w.length > 3 && p.desc.toLowerCase().includes(w))).slice(0, 8);
      return { matches: m.map((p) => ({ code: p.code, description: p.desc, per: p.unit, standard_charge_usd: p.price })) };
    },
    lookup_procedure_bundle: ({ specialty = "", procedure = "" }) => {
      const key = Object.keys(BUNDLES).find((k) => BUNDLES[k].match.test(`${specialty} ${procedure}`));
      if (!key) return { found: false, hint: "No bundle on file; search the price file." };
      return { found: true, bundle: key, lines: BUNDLES[key].lines.map(([code, min, max]) => ({ code, min_units: min, max_units: max, description: PRICES.find((p) => p.code === code)?.desc })) };
    },
    check_sponsor_balance: () => ({ sponsor: sponsor.name, pledge_usd: sponsor.pledge, open_holds_usd: money(openHoldsCents), remaining_usd: money(remaining()), per_case_limit_usd: sponsor.perCaseCap }),
    propose_guarantee: ({ lines, contingency_pct, rationale }) => {
      const { lines: priced, subtotalCents } = priceLines(lines || []);
      const issues = [];
      const unknown = (lines || []).filter((l) => !PRICES.find((p) => p.code === l.code)).map((l) => l.code);
      if (unknown.length) issues.push(`unknown codes: ${unknown.join(", ")}`);
      if (!priced.length) issues.push("no valid lines");
      const pct = Number(contingency_pct); if (!(pct >= 5 && pct <= 25)) issues.push("contingency_pct must be between 5 and 25");
      const total = Math.round(subtotalCents * (1 + (pct || 0) / 100));
      if (total > cents(sponsor.perCaseCap)) issues.push(`total $${money(total)} exceeds the per-case limit $${sponsor.perCaseCap}`);
      if (total > remaining()) issues.push(`total $${money(total)} exceeds the sponsor's remaining balance $${money(remaining())}`);
      const ok = issues.length === 0;
      if (ok) best = { lines: priced, subtotalCents, pct, total, rationale: String(rationale || "").slice(0, 500) };
      return { ok, subtotal_usd: money(subtotalCents), contingency_pct: pct, total_usd: money(total), issues };
    },
  };
  const system = `You are the sizing agent for an emergency-surgery payment guarantee. You do not diagnose and you never question the treating physician: the emergency condition and the requested procedure are already documented.
Be fast. Write NO commentary between tool calls. In your FIRST turn call get_price_record with query "all", lookup_procedure_bundle and check_sponsor_balance together, in parallel. In your SECOND turn call propose_guarantee with the lines the procedure and the first 48 hours of care will realistically need. If propose_guarantee reports issues, fix them and call it again. Put a rationale of under 35 words in the rationale field of propose_guarantee; there is no turn after a successful proposal. Use only codes from the price file.`;
  const user = `Documented case: ${scenario.presentation}\nRequested specialty: ${scenario.specialty}\nSponsor id: ${sponsor.id}`;
  let run, error = null;
  try { if (skipAgent) throw new Error("deterministic sizing requested"); run = await runAgent({ system, user, tools, handlers, maxTurns: 6, isDone: () => !!best, maxTokens: 900 }); }
  catch (e) { error = String(e.message || e).slice(0, 200); run = { trace: [], turns: 0, stop: "error", finalText: "" }; }
  let source = "agent";
  if (!best) { // deterministic fallback, flagged
    source = "fallback";
    const lines = (scenario.expected || [...scenario.procedure, ...scenario.stay]).map(([code, units]) => ({ code, units }));
    const { lines: priced, subtotalCents } = priceLines(lines);
    best = { lines: priced, subtotalCents, pct: 15, total: Math.min(Math.round(subtotalCents * 1.15), cents(sponsor.perCaseCap)), rationale: "Agent unavailable or did not produce a valid proposal. Sized deterministically from expected lines plus 15 percent." };
  }
  return {
    lines: best.lines, subtotal: money(best.subtotalCents), contingencyPct: best.pct, amount: money(best.total),
    rationale: (best.rationale || run.finalText).replace(/\*+/g, "").trim(), source, error, ms: Date.now() - t0, model: MODEL,
    agent: { turns: run.turns, stop: run.stop, toolCalls: run.trace.filter((t) => t.kind === "tool").length, trace: run.trace },
    balance: { pledge: sponsor.pledge, openHolds: money(openHoldsCents) },
  };
}

/* ======================= 2. RECORD RECONSTRUCTION AGENT ======================= */
const HM = (iso) => iso.slice(11, 16);
const mins = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

// Deterministic analysis. This is what makes the flags trustworthy: the model reads these results, it does
// not compute them.
export function analyse(entries, gapMinutes = 20) {
  const placed = entries.filter((e) => e.time && !isNaN(new Date(e.time)));
  const unplaceable = entries.filter((e) => !e.time || isNaN(new Date(e.time)));
  const sorted = [...placed].sort((a, b) => new Date(a.time) - new Date(b.time));
  // An entry is "late" when an entry with a later time was already in the log before it.
  let maxSeen = -Infinity; const outOfOrder = [];
  for (const e of placed) { const t = new Date(e.time).getTime(); if (t < maxSeen) outOfOrder.push(e.id); maxSeen = Math.max(maxSeen, t); }
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const m = mins(sorted[i - 1].time, sorted[i].time);
    if (m >= gapMinutes) gaps.push({ from: sorted[i - 1].id, to: sorted[i].id, fromTime: HM(sorted[i - 1].time), toTime: HM(sorted[i].time), minutes: m });
  }
  const byPerson = {};
  for (const e of sorted) if (e.kind === "contact" && e.person) (byPerson[e.person] ||= []).push(e);
  const repeated = Object.entries(byPerson).map(([person, es]) => {
    const out = es.filter((e) => e.direction === "outbound"), inn = es.filter((e) => e.direction === "inbound");
    return { person, outboundAttempts: out.map((e) => ({ id: e.id, time: HM(e.time), via: e.source })), inbound: inn.map((e) => ({ id: e.id, time: HM(e.time) })) };
  }).filter((r) => r.outboundAttempts.length > 1);
  const secondHand = entries.filter((e) => /\bper\b|told me|i think|not sure|heard/i.test(e.text)).map((e) => e.id);
  const sources = [...new Set(entries.map((e) => e.source))];
  return { sorted, unplaceable, outOfOrder, gaps, repeated, secondHand, sources, firstTime: sorted[0]?.time, lastTime: sorted.at(-1)?.time };
}

// Grounding check used by write_record and by the tests: every clock time and duration in the narrative must
// come from the log.
export function checkNarrative(narrative, A) {
  const allowedHM = new Set(A.sorted.map((e) => HM(e.time)));
  const allowedMin = new Set(A.gaps.map((g) => String(g.minutes)));
  const quoted = [...String(narrative).matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((m) => m[0].padStart(5, "0"));
  const badT = quoted.filter((t) => !allowedHM.has(t));
  const badM = [...String(narrative).matchAll(/\b(\d{2,3})[- ]minutes?\b/g)].map((m) => m[1]).filter((n) => !allowedMin.has(n));
  return { ok: !badT.length && !badM.length, badTimes: badT, badDurations: badM };
}

export async function reconstruct(entries) {
  const t0 = Date.now();
  const A = analyse(entries);
  const ids = new Set(entries.map((e) => e.id));
  const findings = []; let record = null;
  const tools = [
    tool("list_entries", "All raw log entries exactly as received, in received order. Times may be missing.", {}),
    tool("analyse_timeline", "Deterministic analysis: chronological order, entries logged after an entry with a later time, unplaceable entries (no time), unlogged gaps of 20+ minutes, repeated outbound contact attempts to the same person, and second-hand statements.", {}),
    tool("record_finding", "Record one finding with the entry ids that support it. kind is one of out_of_order, repeated_contact, unlogged_gap, unplaceable, second_hand, conflict, other. Unknown ids are rejected.", {
      kind: { type: "string" }, summary: { type: "string" }, entry_ids: { type: "array", items: { type: "string" } } }, ["kind", "summary", "entry_ids"]),
    tool("write_record", "Write the final access-to-care record. narrative: 4-7 plain past-tense sentences, only facts present in entries, every clock time must be one that appears in an entry, never fill a gap with a guess. not_recorded: list of things the log does not establish. It is rejected if it quotes a time that is not in the log.", {
      narrative: { type: "string" }, not_recorded: { type: "array", items: { type: "string" } } }, ["narrative", "not_recorded"]),
  ];
  const handlers = {
    list_entries: () => ({ entries: entries.map((e) => ({ id: e.id, source: e.source, time: e.time, kind: e.kind, person: e.person, direction: e.direction, text: e.text })) }),
    analyse_timeline: () => ({ chronological: A.sorted.map((e) => `${e.id} ${HM(e.time)} ${e.source}`), out_of_order_ids: A.outOfOrder, unplaceable: A.unplaceable.map((e) => ({ id: e.id, source: e.source, text: e.text })), gaps: A.gaps, repeated_contacts: A.repeated, second_hand_ids: A.secondHand, first_entry: A.firstTime, last_entry: A.lastTime }),
    record_finding: ({ kind, summary, entry_ids = [] }) => {
      const bad = entry_ids.filter((i) => !ids.has(i)); if (bad.length) throw new Error(`unknown entry ids: ${bad.join(", ")}`);
      if (!entry_ids.length) throw new Error("a finding must cite at least one entry id");
      findings.push({ kind, summary: String(summary).slice(0, 400), entry_ids }); return { recorded: findings.length };
    },
    write_record: ({ narrative, not_recorded = [] }) => {
      const g = checkNarrative(narrative, A);
      if (!g.ok) throw new Error(`ungrounded: times not in the log: ${g.badTimes.join(", ") || "none"}; durations not computed from the log: ${g.badDurations.join(", ") || "none"}. Rewrite using only logged times.`);
      record = { narrative: String(narrative).trim(), notRecorded: not_recorded.map(String).slice(0, 10) }; return { accepted: true };
    },
  };
  const system = `You reconstruct a defensible access-to-care record from a messy hospital log for a compliance file. Your standard: never fill a gap. If the log does not say what happened between two times, say it is not recorded.
Procedure: call list_entries and analyse_timeline together first. Then call record_finding for each issue the analysis shows (out-of-order arrival, repeated contact, each unlogged gap, unplaceable entries, second-hand statements), citing entry ids. Then call write_record. If write_record rejects you, fix exactly what it says and call it again. Do not assess clinical judgement, motives, or anything legal.`;
  let run, error = null;
  try { run = await runAgent({ system, user: `Reconstruct the record for ${entries.length} log entries from ${A.sources.length} sources.`, tools, handlers, maxTurns: 7, isDone: () => !!record, maxTokens: 1800 }); }
  catch (e) { error = String(e.message || e).slice(0, 200); run = { trace: [], turns: 0, stop: "error" }; }
  const source = record ? "agent" : "fallback";
  if (!record) record = { narrative: `The log holds ${entries.length} entries from ${A.sources.length} sources between ${A.firstTime ? HM(A.firstTime) : "?"} and ${A.lastTime ? HM(A.lastTime) : "?"}. See the flagged gaps and repeated contacts; no narrative was drafted.`, notRecorded: A.gaps.map((g) => `Nothing logged between ${g.fromTime} and ${g.toTime}.`) };
  return {
    entries: A.sorted.map((e) => ({ ...e, outOfOrder: A.outOfOrder.includes(e.id), secondHand: A.secondHand.includes(e.id) })), unplaceable: A.unplaceable,
    gaps: A.gaps, repeated: A.repeated, findings, record, source, error, ms: Date.now() - t0, model: MODEL,
    agent: { turns: run.turns, stop: run.stop, toolCalls: run.trace.filter((t) => t.kind === "tool").length, trace: run.trace },
  };
}
