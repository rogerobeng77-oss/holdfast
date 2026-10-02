import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { Badge, Icon, Skeleton, Spinner, clock, secs, usd, useWidth } from "./ui.jsx";

export const commitmentMs = (c) => {
  const a = c?.events?.find((e) => e.type === "authorized");
  return a ? new Date(a.t) - new Date(c.events[0].t) : null;
};
const reauthsOk = (c) => (c?.auth?.reauths || []).filter((r) => r.ok).length;
const reauthsRefused = (c) => (c?.auth?.reauths || []).filter((r) => !r.ok).length;
const held = (c) => (c?.auth ? Number(c.auth.amount) - (c.captures || []).reduce((a, x) => a + Number(x.amount), 0) : 0);

/* ---------------- tiles ---------------- */
export function Tiles({ c, sc, elapsed, running }) {
  const ms = commitmentMs(c);
  const resp = c?.events?.find((e) => e.type === "oncall_response");
  const clockTile = running && !c?.auth ? ["Running", secs(elapsed ?? 0), "pending", "since presentation", "clock"]
    : ms != null ? ["To honoured commitment", secs(ms), "settled", "presentation to authorization", "check"]
    : ["To honoured commitment", "Not started", "dim", "starts at presentation", null];
  const cap = c?.state === "captured" ? [usd(c.capture.amount, 2), "settled", `Captured. ${usd(c.capture.released, 2)} released`, "check"]
    : c?.state === "partially_captured" ? [usd(c.capture.amount, 2), "pending", `Partly captured. ${usd(held(c), 2)} still held`, "clock"]
    : c?.state === "voided" ? [usd(c.captures.reduce((a, x) => a + Number(x.amount), 0), 2), "settled", `Voided. ${usd(c.void.released, 2)} released`, "check"]
    : c?.auth ? ["Held", "pending", "Nothing charged yet", "clock"] : ["No hold", "dim", "Nothing authorized", null];
  return (
    <section className="tilesbar" aria-label="Live state of the case"><div className="wrap tiles">
      <div className="tile"><div className="k">Amount authorized</div><div className={"v " + (c?.auth ? "pending" : "dim")}>{c?.auth ? <><Icon n="clock" />{usd(c.auth.amount, 2)}</> : c?.sizing ? "Sized " + usd(c.sizing.amount) : "Not started"}</div><div className="s">{c?.auth ? `PayPal guarantees the funds until ${c.auth.honorUntil.slice(0, 10)}` : "On the sponsor's vaulted instrument"}</div></div>
      <div className="tile"><div className="k">{clockTile[0]}</div><div className={"v " + clockTile[2]}>{clockTile[4] && <Icon n={clockTile[4]} />}{clockTile[1]}</div><div className="s">{clockTile[3]}</div></div>
      <div className="tile"><div className="k">On-call response</div><div className={"v " + (resp ? "settled" : "dim")}>{resp ? <><Icon n="check" />Accepts</> : c?.auth ? "Awaiting" : "Not asked"}</div><div className="s">{sc.onCall.split(",")[0]}</div></div>
      <div className="tile"><div className="k">Capture status</div><div className={"v " + cap[1]}>{cap[3] && <Icon n={cap[3]} />}{cap[0]}</div><div className="s">{cap[2]}</div></div>
    </div></section>
  );
}

/* ---------------- banner ---------------- */
const BUSY = { start: ["Sizing the guarantee", "The sizing agent is calling its tools: the price file, the procedure bundle and the fund balance. This takes 10 to 25 seconds."], authorize: ["Authorizing the guarantee", "PayPal is creating the authorization on the sponsor's vaulted account."], contact: ["Contacting the on-call surgeon", "Writing the request and the answer to the record."], document: ["Capturing for the documented procedure", "PayPal is capturing the amount billed for the documented care."], discharge: ["Making the final capture", "PayPal is capturing the stay and releasing the rest."], void: ["Voiding the hold", "PayPal is releasing what is left of the hold."], skip: ["Asking PayPal to reauthorize", "The clock moved four days here; PayPal will answer for its own clock."], audit: ["Drafting the narrative", "The model is writing the record from the logged events."] };
export function Banner({ c, err, sc, prog, busy }) {
  let tone = "pending", icon = "clock", head, body;
  if (err) { tone = "alarm"; icon = "alert"; head = "The step did not finish"; body = err; }
  else if (busy && BUSY[busy]) { head = BUSY[busy][0]; body = BUSY[busy][1]; icon = "clock"; }
  else if (prog) { head = prog.label; body = <>{`Step ${prog.i} of ${prog.n}`}<div className="progress" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax={prog.n} aria-valuenow={prog.i}><i style={{ width: (prog.i / prog.n) * 100 + "%" }} /></div></>; }
  else if (!c) { head = "No case started"; body = "Choose Start case to size a guarantee for this patient. No money moves until the next step."; icon = "ring"; }
  else if (c.state === "sized") { head = "Guarantee sized, not yet committed"; body = `${usd(c.sizing.amount, 2)} calculated from ${c.sizing.lines.length} published price lines. No money has moved. Authorize the guarantee to show the hospital a honoured commitment.`; }
  else if (c.state === "authorized") { head = "Commitment honoured, specialist not yet asked"; body = `The hospital can see ${usd(c.auth.amount, 2)} held on the sponsor's vaulted instrument (authorization ${c.auth.authId}). Nothing has been charged.`; }
  else if (c.state === "accepted") { head = "On-call specialist has accepted"; body = "The request, the guarantee and the answer are in the record. Capture waits for the procedure note."; }
  else if (c.state === "partially_captured") { head = "Procedure captured, hold stays open for the stay"; body = `${usd(c.capture.amount, 2)} captured for the documented procedure. ${usd(held(c), 2)} remains held for inpatient care and is released at discharge.`; }
  else if (c.state === "captured") { tone = "settled"; icon = "check"; head = "Settled: the sponsor paid only for care that was given"; body = `${usd(c.capture.amount, 2)} captured in ${c.capture.parts} part${c.capture.parts > 1 ? "s" : ""}. The unused ${usd(c.capture.released, 2)} of the ${c.mode === "pool" ? "reservation returned to the fund" : "hold went back to the sponsor"}.`; }
  else if (c.state === "voided") { tone = "settled"; icon = "check"; const ch = c.captures.reduce((a, x) => a + Number(x.amount), 0); head = ch ? "Closed: only the documented care was charged" : "Released: the sponsor was charged nothing"; body = ch ? `${usd(ch, 2)} was captured earlier; the remaining ${usd(c.void.released, 2)} was voided.` : `The procedure did not happen${sc.outcome === "void" ? ` (${sc.procedureNote.replace("Procedure not performed. ", "")})` : ""}, so the whole ${usd(c.void.released, 2)} ${c.mode === "pool" ? "reservation returned to the fund" : "hold was voided"}.`; }
  return <div className={"banner " + tone} role="status"><Icon n={icon} /><div><b>{head}</b>{body}</div></div>;
}

/* ---------------- state machine + actions ---------------- */
const STAGES = [["sized", "Sized"], ["authorized", "Authorized"], ["accepted", "Accepted"], ["partially_captured", "Partially captured"], ["captured", "Captured"]];
function reachedRank(c) {
  if (!c) return -1;
  if (c.state === "voided") return c.captures?.length ? 3 : c.events.some((e) => e.type === "oncall_response") ? 2 : c.auth ? 1 : 0;
  return { presented: -1, sized: 0, authorized: 1, accepted: 2, partially_captured: 3, captured: 4 }[c.state];
}
export function Machine({ c }) {
  const r = reachedRank(c);
  const ok = reauthsOk(c), refused = reauthsRefused(c);
  return (
    <>
      <ol className="machine" aria-label="Authorization lifecycle">
        {STAGES.map(([k, label], i) => {
          const cls = i < r || (c?.state === "captured" && i === 4) ? "done" : i === r && c?.state !== "voided" ? "now" : "";
          return (
            <React.Fragment key={k}>
              <li><span className={"node " + cls} aria-current={cls === "now" ? "step" : undefined}>{cls === "done" ? <Icon n="check" /> : cls === "now" ? <Icon n="clock" /> : <Icon n="ring" />}{label}{cls === "done" ? <span className="sr"> (reached)</span> : cls === "now" ? <span className="sr"> (current)</span> : null}</span>{i < STAGES.length - 1 && <span className="arrow" aria-hidden="true" />}</li>
              {k === "authorized" && <li><span className={"node exit " + (ok ? "done" : "")}><Icon n="pulse" />Reauthorized ×{ok}</span><span className="arrow" aria-hidden="true" /></li>}
            </React.Fragment>
          );
        })}
        <li><span className="sep" aria-hidden="true" /><span className={"node exit " + (c?.state === "voided" ? "now" : "")}>{c?.state === "voided" ? <Icon n="check" /> : <Icon n="x" />}Voided<span className="sr">{c?.state === "voided" ? " (current)" : " (exit state)"}</span></span></li>
      </ol>
      <p className="machine-note">
        {c?.auth ? <>PayPal guarantees the funds until {c.auth.honorUntil.slice(0, 10)}; the hold stays valid to {c.auth.expires.slice(0, 10)}. Reauthorized {ok}, refused {refused}.</> : "PayPal guarantees a hold for 3 days and keeps it valid for 29. Reauthorization starts on day 4."}
      </p>
    </>
  );
}

export function Actions({ c, sc, busy, onStart, onStep, onSkip, onRunAll, running, needFund }) {
  const st = c?.state;
  const needsStay = sc.hasStay;
  const canVoid = ["authorized", "accepted", "partially_captured"].includes(st);
  const next = needFund ? "Authorize the fund first, below, then start the case." : !c ? "Start the case to size a guarantee." : { sized: "Authorize the guarantee.", authorized: "Contact the on-call surgeon.", accepted: needsStay ? "Document the procedure to capture the first part." : sc.outcome === "void" ? "The patient is transferred before incision: void the hold." : "Document the procedure to capture.", partially_captured: "Document discharge to make the final capture.", captured: "The case is settled. Start a new run to repeat it.", voided: "The hold is released. Start a new run to repeat it." }[st];
  const disabled = running || !!busy;
  const B = ({ k, label, onClick, on, kind = "", icon }) => <button type="button" className={"btn " + kind} disabled={disabled || !on} onClick={onClick}>{busy === k ? <Spinner /> : icon}{busy === k ? "Working…" : label}</button>;
  return (
    <div>
      <div className="actions" role="group" aria-label="Case actions">
        <B k="start" label={c && ["captured", "voided"].includes(st) ? "Start a new case" : "Start case and size guarantee"} on={(!c || ["captured", "voided"].includes(st)) && !needFund} onClick={onStart} kind={!c ? "primary" : ""} />
        <B k="authorize" label="Authorize guarantee" on={st === "sized"} onClick={() => onStep("authorize")} kind={st === "sized" ? "primary" : ""} />
        <B k="contact" label="Contact on-call surgeon" on={st === "authorized"} onClick={() => onStep("contact")} kind={st === "authorized" ? "primary" : ""} />
        <B k="document" label={needsStay ? "Document procedure, capture first part" : "Document procedure and capture"} on={st === "accepted" && sc.outcome === "capture"} onClick={() => onStep("document")} kind={st === "accepted" && sc.outcome === "capture" ? "primary" : ""} />
        <B k="discharge" label="Document discharge, final capture" on={st === "partially_captured"} onClick={() => onStep("discharge")} kind={st === "partially_captured" ? "primary" : ""} />
        <B k="void" label={st === "partially_captured" ? "Void remaining hold" : "Void hold"} on={canVoid} onClick={() => onStep("void")} kind={st === "accepted" && sc.outcome === "void" ? "danger solid" : "danger"} />
        <B k="skip" label="Skip 4 days and reauthorize" on={canVoid} onClick={onSkip} />
        <button type="button" className="btn" disabled={disabled} onClick={onRunAll}>{running ? <><Spinner />Running all steps…</> : "Run all steps"}</button>
      </div>
      <p className="next"><b>Next:</b> {next}</p>
    </div>
  );
}

/* ---------------- chart ---------------- */
export function FlowChart({ c, cap }) {
  const [ref, W] = useWidth();
  const H = W < 520 ? 210 : 220, L = 52, R = 14, T = 16, B = 46;
  const pts = useMemo(() => {
    if (!c?.events?.length || !c.auth) return null;
    const a = c.events.find((e) => e.type === "authorized");
    const t0 = new Date(a.t).getTime() - 600, x = (iso) => (new Date(iso).getTime() - t0) / 1000;
    const last = x(c.events[c.events.length - 1].t);
    const end = c.events.find((e) => ["captured", "voided"].includes(e.type));
    const stop = end ? x(end.t) : last;
    const heldLine = [[0, 0], [x(a.t), 0], [x(a.t), +c.auth.amount], [stop, +c.auth.amount]];
    let run = 0; const charged = [[x(a.t), 0]];
    for (const e of c.events) if (["partially_captured", "captured"].includes(e.type)) { const m = e.text.match(/(?:for|Total charged) \$([\d,.]+)/); const idx = charged.length; charged.push([x(e.t), run]); const cp = c.captures[Math.min(idx - 1, c.captures.length - 1)]; run += +cp.amount; charged.push([x(e.t), run]); }
    if (charged.length > 1) charged.push([Math.max(stop + 0.5, last), run]);
    const marks = c.events.filter((e) => ["authorized", "oncall_response", "partially_captured", "captured", "voided"].includes(e.type)).map((e) => ({ x: x(e.t), t: e.type }));
    return { heldLine, charged: charged.length > 1 ? charged : null, xmax: Math.max(6, stop + 0.5), marks };
  }, [c]);
  const ymax = cap * 1.1, xmax = pts?.xmax || 10;
  const X = (v) => L + (v / xmax) * (W - L - R), Y = (v) => T + (1 - v / ymax) * (H - T - B);
  const path = (p) => p.map((q, i) => `${i ? "L" : "M"}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join(" ");
  const lab = { authorized: "honoured", oncall_response: "accepts", partially_captured: "part 1", captured: "settled", voided: "voided" };
  let lastLabelX = -999; const marks = pts?.marks || []; const keep = (i) => W >= 640 || i === 0 || i === marks.length - 1;
  return (
    <div className="card">
      <h3>Held for the hospital, charged to the sponsor</h3>
      <div ref={ref}>
        <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={pts ? `Held ${usd(c.auth.amount)} from authorization; charged ${usd(c.capture?.amount || 0)} so far; sponsor limit ${usd(cap)}` : "Chart of held and charged dollars. No hold yet."}>
          {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W - R} y1={Y(cap * f)} y2={Y(cap * f)} stroke="var(--line-soft)" /><text x={L - 8} y={Y(cap * f) + 4} textAnchor="end">{f === 0 ? "$0" : "$" + Math.round((cap * f) / 1000) + "k"}</text></g>)}
          <line x1={L} x2={W - R} y1={Y(cap)} y2={Y(cap)} stroke="var(--accent)" strokeWidth="2" strokeDasharray="7 5" />
          <text className="thr" x={W - R} y={Y(cap) - 6} textAnchor="end">sponsor limit {usd(cap)}</text>
          {pts && <>
            <path d={`${path(pts.heldLine)} L${X(pts.heldLine.at(-1)[0])},${Y(0)} L${X(pts.heldLine[0][0])},${Y(0)} Z`} fill="var(--pending)" opacity=".13" />
            <path d={path(pts.heldLine)} fill="none" stroke="var(--pending)" strokeWidth="2.5" strokeLinejoin="round" />
            {pts.charged && <path d={path(pts.charged)} fill="none" stroke="var(--settled)" strokeWidth="3" strokeDasharray="1 0" strokeLinejoin="round" />}
            {pts.marks.map((m, i) => { const px = X(m.x); const show = keep(i) && px - lastLabelX > 78; if (show) lastLabelX = px; return <g key={i}><line x1={px} x2={px} y1={T} y2={H - B} stroke="var(--line)" strokeDasharray="2 4" />{show && <text x={px > W - 90 ? px - 4 : px + 4} textAnchor={px > W - 90 ? "end" : "start"} y={H - B + 16}>{lab[m.t]}</text>}</g>; })}
          </>}
          {!pts && <text x={W / 2} y={H / 2} textAnchor="middle">No hold yet. Start a case to draw this chart.</text>}
          <text x={W - R} y={H - 2} textAnchor="end">seconds since authorization</text>
        </svg>
      </div>
      <div className="legend"><span><i style={{ borderColor: "var(--pending)" }} />Held (amber)</span><span><i style={{ borderColor: "var(--settled)" }} />Charged (green)</span><span><i style={{ borderColor: "var(--accent)", borderTopStyle: "dashed" }} />Sponsor limit (red, dashed)</span></div>
    </div>
  );
}

/* ---------------- sizing + agent trace ---------------- */
export function Sizing({ c, busy }) {
  const s = c?.sizing; const max = s ? Math.max(...s.lines.map((l) => l.line)) : 1;
  return (
    <div>
      <h4>Price lines</h4>
      <p className="sub">The agent chooses lines from the published price file. Code then re-prices them, so a model cannot invent a figure that reaches PayPal.</p>
      {!s ? (busy === "start" ? <Skeleton lines={5} /> : <div className="empty">No sizing yet. Start a case to see the price lines the agent chooses.</div>) : <>
        <div className="lines">{s.lines.map((l) => <div className="lcard" key={l.code}><div className="k">{l.code} · ×{l.units}</div><div className="v">{usd(l.line)}</div><div className="d">{l.desc}</div><div className="bar" aria-hidden="true"><i style={{ width: (l.line / max) * 100 + "%" }} /></div></div>)}</div>
        <div className="totals"><span>Subtotal <b>{usd(s.subtotal, 2)}</b></span><span>Contingency <b>{s.contingencyPct}%</b></span><span>Guarantee <b>{usd(s.amount, 2)}</b></span>{s.balance && <span>Fund open holds <b>{usd(s.balance.openHolds, 2)}</b> of <b>{usd(s.balance.pledge)}</b></span>}</div>
        <div className="note-ai"><b>{s.source === "agent" ? "Sizing agent" : s.source === "replayed" ? "Stored agent plan" : "Deterministic sizing"}.</b> {s.rationale}{s.source === "replayed" && <> This plan came from an earlier live agent run ({s.replayedFrom?.slice(0, 16).replace("T", " ")} UTC) because the model account hit its rate limit; lines were re-priced and re-checked.</>}</div>
      </>}
    </div>
  );
}

export function Trace({ agent, title, intro, bare }) {
  const items = agent?.trace || [];
  const Wrap = bare ? "div" : "div";
  return (
    <Wrap className={bare ? "" : "card"} style={bare ? { marginTop: "1.25rem" } : undefined}>
      <h4>{title}</h4>
      <p className="sub">{intro}</p>
      {!items.length ? <div className="empty">No agent trace for this case. A replayed or deterministic run has no live tool calls.</div> : <>
        <p className="fine" style={{ marginTop: 0, marginBottom: ".75rem" }}>{agent.toolCalls} tool calls across {agent.turns} model turns. Stopped because: {agent.stop.replace("_", " ")}.</p>
        <div className="trace">
          {items.map((t, i) => t.kind === "model" ? <div className="say" key={i}>Turn {t.turn}: "{t.text}"</div> : (
            <details key={i}>
              <summary><Badge tone={t.ok ? "settled" : "alarm"} icon={t.ok ? "check" : "x"}>{t.name}</Badge><span>{brief(t)}</span><span className="ms">turn {t.turn}</span></summary>
              <pre>{JSON.stringify({ input: t.input, output: t.output }, null, 2)}</pre>
            </details>
          ))}
        </div>
      </>}
    </Wrap>
  );
}
function brief(t) {
  const i = t.input || {}, o = t.output || {};
  if (t.name === "propose_guarantee") return o.ok ? `${(i.lines || []).length} lines, ${i.contingency_pct}% contingency → ${usd(o.total_usd, 2)}` : `rejected: ${(o.issues || []).join("; ")}`;
  if (t.name === "get_price_record") return `query "${i.query}"`;
  if (t.name === "check_sponsor_balance") return o.remaining_usd ? `${usd(o.remaining_usd)} remaining of ${usd(o.pledge_usd)}` : "";
  if (t.name === "lookup_procedure_bundle") return i.specialty || "";
  if (t.name === "record_finding") return `${i.kind}: ${(i.entry_ids || []).join(", ")}`;
  if (t.name === "write_record") return t.ok ? "record accepted" : "rejected: " + (o.error || "").slice(0, 90);
  return "";
}

const kind = { presented: ["plain", "ring"], sized: ["plain", "dot"], authorized: ["pending", "clock"], reauthorized: ["pending", "pulse"], reauth_refused: ["alarm", "alert"], reissued: ["pending", "alert"], oncall_contacted: ["pending", "clock"], oncall_response: ["settled", "check"], documented: ["settled", "check"], partially_captured: ["pending", "clock"], captured: ["settled", "check"], not_performed: ["pending", "alert"], stay_ended: ["pending", "alert"], voided: ["settled", "check"] };
export function Trail({ c, busy }) {
  return (
    <div className="card">
      <h3>Audit trail</h3>
      <p className="sub">Each line is written the moment it happens, with the server's timestamp.</p>
      {!c ? (busy === "start" ? <Skeleton lines={5} /> : <div className="empty">Nothing recorded yet. The first line appears when the case starts.</div>) : (
        <ol className="trail">{c.events.map((e, i) => { const [tone, ic] = kind[e.type] || ["plain", "dot"]; return <li key={i} className={tone}><Icon n={ic} /><time>{clock(e.t)}</time><span className="ty">{e.type.replace(/_/g, " ")}</span><div>{e.text}</div></li>; })}</ol>
      )}
    </div>
  );
}

/* ---------------- record paper ---------------- */
export function Paper({ c, busy, onDraft }) {
  if (!c) return <div className="empty" style={{ marginTop: "1.25rem" }}>No record yet. Start a case and the record writes itself as events happen.</div>;
  return (
    <article className="paper">
      <h3>Emergency surgical access record</h3>
      <div className="meta"><span>Case {c.id}</span><span>{c.hospital}</span><span>Patient {c.patient}</span><span>Sponsor {c.sponsorName}</span></div>
      {c.events.map((e, i) => <div className="row" key={i}><time>{clock(e.t)}</time><span>{e.text}</span></div>)}
      <details className="written">
        <summary>Read as a written statement</summary>
        {c.audit ? <p className="body">{c.audit.text}</p> : <div className="empty"><span>The statement is drafted when the case closes, or on request.</span><button type="button" className="btn small" disabled={busy === "audit"} onClick={onDraft}>{busy === "audit" ? "Drafting…" : "Draft statement now"}</button></div>}
      </details>
      <div className="stamp">{c.audit?.source === "bedrock" ? `Narrative drafted by Claude Sonnet 4.5 on Amazon Bedrock (${secs(c.audit.ms)}) using only the events above. ` : c.audit ? "Narrative built from a template because the model account was rate limited. " : ""}The event rows are the record. The narrative summarises them and makes no clinical or legal finding.{c.audit?.source === "template" && <> <button type="button" className="btn small" disabled={busy === "audit"} onClick={onDraft}>{busy === "audit" ? "Drafting…" : "Redraft with the model"}</button></>}</div>
    </article>
  );
}

/* ---------------- ledger ---------------- */
export function Ledger({ c }) {
  const rows = [];
  if (c?.auth) rows.push(["POST /v2/checkout/orders", `intent AUTHORIZE with the sponsor's vault_id; no buyer, no browser`, `order ${c.auth.orderId}`, `${c.auth.ms} ms`]);
  if (c?.auth) rows.push([c.auth.pool ? "Reserved against the fund" : "Authorization created", `${usd(c.auth.amount, 2)} ${c.auth.pool ? "reserved" : "authorized"}`, c.auth.authId, `valid to ${c.auth.expires.slice(0, 10)}`]);
  for (const r of c?.auth?.reauths || []) rows.push([r.ok ? "POST …/reauthorize" : "POST …/reauthorize (refused)", r.ok ? `${usd(r.amount, 2)} reauthorized` : `${r.issue}, HTTP ${r.status}`, c.auth.authId, r.t.slice(0, 10)]);
  for (const p of c?.captures || []) rows.push([`POST …/capture (${p.final ? "final" : "partial"})`, `${usd(p.amount, 2)} · ${p.stage}`, `capture ${p.id}`, `${p.ms} ms`]);
  if (c?.void) rows.push(["POST …/void", `${usd(c.void.released, 2)} of hold released`, c.auth.authId, `${c.void.ms} ms`]);
  return (
    <div>
      <h4>PayPal calls for this case</h4>
      <p className="sub">The sponsor approved once in a browser (<code>/v3/vault/setup-tokens</code>, then <code>/v3/vault/payment-tokens</code>). Nothing below needed a person.</p>
      {!rows.length ? <div className="empty">No PayPal calls yet. Authorize the guarantee to make the first one.</div> : <div className="rows">{rows.map((r, i) => <div className="rowc" key={i}><span className="c1">{r[0]}</span><span>{r[1]}</span><span className="c3">{r[2]}</span><span className="c4">{r[3]}</span></div>)}</div>}
      {c?.requests?.length > 0 && <details style={{ marginTop: "1rem" }}><summary style={{ cursor: "pointer", minHeight: "2rem" }}>PayPal-Request-Id sent on each money movement ({c.requests.length})</summary><p className="fine">Replaying a request with the same id returns the original result instead of moving money twice.</p><div className="rows">{c.requests.map((r, i) => <div className="rowc" key={i}><span className="c1">{r.op}</span><span className="c3" style={{ gridColumn: "span 3" }}>{r.id}</span></div>)}</div></details>}
    </div>
  );
}

export function Webhooks() {
  const [ev, setEv] = useState(null); const [rej, setRej] = useState(0); const [load, setLoad] = useState(false); const [err, setErr] = useState(null);
  const refresh = () => { setLoad(true); setErr(null); api.webhooks().then((r) => { setEv(r.events); setRej(r.rejected); }).catch((e) => setErr(e.message)).finally(() => setLoad(false)); };
  useEffect(refresh, []);
  return (
    <div>
      <h4>Webhook events</h4>
      <p className="sub">Each delivery is checked with PayPal's verify-webhook-signature endpoint before it is stored. Unsigned or altered deliveries are dropped. Rejected so far: <b>{rej}</b>.</p>
      <button type="button" className="btn small" onClick={refresh} disabled={load}>{load ? "Checking…" : "Check for new events"}</button>
      {err && <p className="field-err"><Icon n="alert" />{err}</p>}
      {ev === null ? <Skeleton lines={3} /> : !ev.length ? <div className="empty" style={{ marginTop: "1rem" }}>No verified events yet. Sandbox deliveries can lag by a minute or two after a capture or void.</div> : (
        <div className="rows" style={{ marginTop: "1rem" }}>{ev.slice(0, 8).map((e) => <div className="rowc" key={e.id}><span className="c1">{e.type}</span><span>{e.status || "no status"}</span><span className="c3">{e.resourceId}</span><span className="c4">{e.amount ? usd(e.amount, 2) : ""}</span></div>)}</div>
      )}
    </div>
  );
}

export function Recent({ onOpen, current }) {
  const [list, setList] = useState(null); const [err, setErr] = useState(null);
  const load = () => api.cases().then((r) => setList(r.cases)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [current]);
  return (
    <div>
      <h4>Recent cases</h4>
      <p className="sub">Cases are stored server-side and survive a reload.</p>
      {err && <p className="field-err"><Icon n="alert" />{err}</p>}
      {list === null ? <Skeleton lines={3} /> : !list.length ? <div className="empty">No live cases stored yet. Run one above and it will be listed here.</div> : (
        <div className="rows">{list.slice(0, 6).map((x) => <div className="rowc" key={x.id}><span className="c1">{x.id}</span><span>{x.patient}</span><span><Badge tone={x.state === "captured" || x.state === "voided" ? "settled" : "pending"} icon={x.state === "captured" || x.state === "voided" ? "check" : "clock"}>{x.state.replace("_", " ")}</Badge></span><button type="button" className="btn small" onClick={() => onOpen(x)}>Open case</button></div>)}</div>
      )}
    </div>
  );
}
