import React, { useState } from "react";
import { api } from "./api.js";
import { Badge, Icon, Skeleton, Spinner, friendly } from "./ui.jsx";
import { Trace } from "./sections.jsx";

const safeCount = (t) => { try { const a = JSON.parse(t); return Array.isArray(a) ? a.length : 0; } catch { return 0; } };
const hm = (iso) => iso.slice(11, 16);
const KIND_LABEL = { contact: "Contact", clinical: "Clinical", note: "Note" };

export function Reconstruct({ sample, initial }) {
  const [text, setText] = useState(JSON.stringify(sample, null, 2));
  const [res, setRes] = useState(initial || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [fieldErr, setFieldErr] = useState(null);

  async function run() {
    let entries;
    try { entries = JSON.parse(text); } catch (e) { setFieldErr(`This is not valid JSON (${e.message}). Fix the syntax or choose Load sample log.`); return; }
    if (!Array.isArray(entries) || !entries.length) { setFieldErr("Paste a JSON array with at least one entry. Each entry needs an id, a source, a time (or null) and text."); return; }
    if (entries.length > 40) { setFieldErr("Paste 40 entries or fewer."); return; }
    if (entries.some((x) => !x || typeof x.text !== "string" || !x.text.trim())) { setFieldErr("Every entry needs a text field with the log wording."); return; }
    setFieldErr(null); setErr(null); setBusy(true);
    const isSample = JSON.stringify(entries) === JSON.stringify(sample);
    try { setRes(await api.reconstruct(isSample ? null : entries)); } catch (e) { setErr(friendly(e.message)); }
    setBusy(false);
  }
  const counts = res && [
    res.gaps.length && ["alarm", "gap", `${res.gaps.length} unlogged gap${res.gaps.length > 1 ? "s" : ""}`],
    res.repeated.length && ["pending", "alert", res.repeated.map((r) => `${r.outboundAttempts.length} contact attempts to ${r.person}`).join(", ")],
    res.unplaceable.length && ["pending", "alert", `${res.unplaceable.length} entry with no usable time`],
    res.entries.filter((e) => e.outOfOrder).length && ["pending", "alert", `${res.entries.filter((e) => e.outOfOrder).length} entries logged after a later-timed one`],
    res.entries.filter((e) => e.secondHand).length + res.unplaceable.filter((e) => /\bper\b|think|not sure/i.test(e.text)).length && ["pending", "alert", "second-hand statements present"],
  ].filter(Boolean);

  // interleave gaps between entries
  const rows = [];
  if (res) res.entries.forEach((e, i) => {
    const g = res.gaps.find((x) => x.to === e.id);
    if (g) rows.push({ gap: g, key: "g" + g.to });
    rows.push({ e, key: e.id });
  });

  return (
    <div>
      <div>
        <div className="card">
          <h3>Hospital log, as received</h3>
          <p className="sub">Nine entries from five sources. Edit the log or paste your own JSON array.</p>
          <details open={!!fieldErr}>
            <summary style={{ cursor: "pointer", minHeight: "2.25rem", fontWeight: 600 }}>Show the log ({safeCount(text)} entries)</summary>
            <label htmlFor="log" className="sr">Log entries as JSON</label>
            <textarea id="log" value={text} onChange={(e) => { setText(e.target.value); setFieldErr(null); }} aria-invalid={!!fieldErr} aria-describedby={fieldErr ? "log-err" : undefined} spellCheck="false" />
          </details>
          {fieldErr && <p id="log-err" className="field-err" role="alert"><Icon n="alert" />{fieldErr}</p>}
          <div className="actions">
            <button type="button" className="btn primary" onClick={run} disabled={busy}>{busy ? <><Spinner />Reconstructing…</> : "Reconstruct record"}</button>
            <button type="button" className="btn" onClick={() => { setText(JSON.stringify(sample, null, 2)); setFieldErr(null); }} disabled={busy}>Load sample log</button>
          </div>
        </div>
        <div className="card" aria-live="polite">
          <h3>Reconstructed timeline</h3>
          {err && <p className="field-err" role="alert"><Icon n="alert" />{err}</p>}
          {busy ? <><p className="sub">The agent is reading the log and calling its tools. This takes 20 to 60 seconds.</p><Skeleton lines={6} /></> : !res ? <div className="empty">Nothing reconstructed yet. Choose Reconstruct record to run the agent on the log.</div> : <>
            <div className="chips-flag">{counts.map((c, i) => <Badge key={i} tone={c[0]} icon={c[1] === "gap" ? "gap" : "alert"}>{c[2]}</Badge>)}</div>
            <ol className="tl">
              {rows.map((r) => r.gap ? (
                <li className="gap" key={r.key}><Icon n="gap" />Nothing logged for {r.gap.minutes} minutes ({r.gap.fromTime} to {r.gap.toTime})</li>
              ) : (
                <li className="entry" key={r.key}>
                  <span className="t">{hm(r.e.time)}</span>
                  <div><div>{r.e.text}</div><div className="src">{r.e.id} · {r.e.source}{r.e.person ? ` · ${r.e.direction} contact, ${r.e.person}` : ""}</div>
                    {r.e.secondHand && <div className="flags"><Badge tone="pending" icon="alert">Second-hand statement</Badge></div>}</div>
                </li>
              ))}
              {res.unplaceable.map((e) => (
                <li className="entry" key={e.id}><span className="t" aria-label="no time">--:--</span><div><div>{e.text}</div><div className="src">{e.id} · {e.source}</div><div className="flags"><Badge tone="alarm" icon="alert">No time recorded, cannot be placed</Badge></div></div></li>
              ))}
            </ol>
          </>}
        </div>
      </div>

      {res && !busy && <>
        <article className="paper">
          <h3>Reconstructed access record</h3>
          <div className="meta"><span>{res.entries.length + res.unplaceable.length} log entries</span><span>{res.source === "agent" ? "Written by the reconstruction agent" : res.source === "replayed" ? "Stored agent output (model rate limit reached)" : "Deterministic summary (agent unavailable)"}</span></div>
          <p className="body">{res.record.narrative}</p>
          <h4 style={{ margin: "1rem 0 .4rem", fontFamily: "var(--cond)", letterSpacing: ".06em", textTransform: "uppercase" }}>Not recorded</h4>
          {res.record.notRecorded.length ? <ul style={{ margin: 0, paddingLeft: "1.2rem", fontFamily: "Georgia, serif" }}>{res.record.notRecorded.map((n, i) => <li key={i}>{n}</li>)}</ul> : <p className="body">The agent listed no unrecorded items.</p>}
          <div className="stamp">Every clock time and duration above was checked in code against the log before the record was accepted. Gaps, repeated contacts and out-of-order entries come from deterministic analysis, not from the model.</div>
        </article>
        <details className="disclose"><summary>How the agent decided</summary><Trace bare agent={res.agent} title={`${res.findings.length} findings recorded`} intro="Each finding cites log entries. The agent can only finish when its narrative passes the grounding check." /></details>
      </>}
    </div>
  );
}
