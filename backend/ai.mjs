import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PRICES } from "./data.mjs";
import { cents, money } from "./paypal.mjs";

export const br = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 8, retryMode: "adaptive" });
const brShort = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 4, retryMode: "adaptive" }); // narrative: fail over to the template sooner
export const MODEL = process.env.BEDROCK_MODEL || "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export async function ask(system, user, maxTokens = 1200) {
  const r = await brShort.send(new ConverseCommand({
    modelId: MODEL, system: [{ text: system }],
    messages: [{ role: "user", content: [{ text: user }] }],
    inferenceConfig: { maxTokens, temperature: 0.1 },
  }));
  return r.output.message.content.map((c) => c.text || "").join("");
}
const jsonOf = (t) => JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));

const priceOf = (code) => PRICES.find((p) => p.code === code);

// Deterministic arithmetic. The model chooses lines and a contingency; it never states the dollar total
// we authorize. We recompute from the price file so a hallucinated figure cannot reach PayPal.
export function priceLines(lines) {
  const out = []; let total = 0;
  for (const l of lines) {
    const p = priceOf(l.code);
    if (!p) continue;
    const units = Math.max(1, Math.min(20, Math.round(Number(l.units) || 1)));
    out.push({ code: p.code, desc: p.desc, units, unitPrice: p.price, line: p.price * units });
    total += cents(p.price) * units;
  }
  return { lines: out, subtotalCents: total };
}

const T = (iso) => iso.slice(11, 19) + "Z";
// Rule-based summary used when the model account is rate limited. Same facts, no model, flagged as such.
export function templateNarrative(c) {
  const e = (t) => c.events.find((x) => x.type === t);
  const parts = [];
  const p = e("presented"); if (p) parts.push(`At ${T(p.t)}, ${c.patient} presented to ${c.hospital} and the ED physician documented the emergency condition.`);
  const a = e("authorized"); if (a) parts.push(`At ${T(a.t)}, a guarantee of $${Number(c.auth.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} was ${c.auth.pool ? "reserved against the sponsor's fund" : "authorized on the sponsor's vaulted instrument"}.`);
  const o = e("oncall_response"); if (o) parts.push(`At ${T(o.t)}, the on-call specialist responded.`);
  const k = e("captured") || e("voided"); if (k) parts.push(k.type === "captured" ? `At ${T(k.t)}, the final capture was made for the documented care.` : `At ${T(k.t)}, the remaining hold was released.`);
  return parts.join(" ");
}

export async function draftAudit(c) {
  const t0 = Date.now();
  const facts = c.events.map((e) => `${e.t} | ${e.type} | ${e.text}`).join("\n");
  const system = `You draft a factual access-to-care record for a hospital compliance file from a logged event list.
Rules: use only facts in the log; quote timestamps as given; do not infer motives; do not assess clinical judgement; do not state or imply any legal conclusion; do not mention diagnosis accuracy. Write 4 to 6 short sentences in plain past tense, covering: what was requested and when, which on-call specialist was contacted and what they said, what financial commitment existed and when, and how it ended. No headings, no lists.`;
  try {
    const text = await ask(system, `Case ${c.id}. Patient ${c.patient}. Hospital ${c.hospital}.\nEvent log:\n${facts}`, 700);
    return { text: text.trim(), source: "bedrock", ms: Date.now() - t0 };
  } catch (e) {
    return { text: templateNarrative(c), source: "template", ms: Date.now() - t0, error: String(e.message).slice(0, 160) };
  }
}
