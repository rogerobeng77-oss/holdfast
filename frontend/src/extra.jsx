import React, { useEffect, useState } from "react";
import { api } from "./api.js";
import { Badge, Icon, Spinner, usd } from "./ui.jsx";

export function Evidence() {
  return (
    <section id="evidence" className="sect">
      <div className="eyebrow">The evidence</div>
      <h2>What the settlements show</h2>
      <p className="lede">EMTALA requires a hospital with an emergency department to screen and stabilise anyone who presents. HHS-OIG enforces it with civil monetary penalties and publishes each settlement.</p>
      <div className="evlist" role="list">
        {[
          ["~100", "OIG EMTALA settlements", "Roughly one hundred published civil monetary penalty settlements for patient dumping and refusal."],
          ["$100,000", "Spartanburg Medical Center", "Conduct in May 2024, settled 12 November 2025. An actively bleeding carotid hematoma was narrowing the airway and the on-call vascular surgeon would not come in. Surgeons were available."],
          ["$150,000", "Flowers Hospital, Dothan", "Conduct in May 2021, settled 25 July 2025. The on-call oral and maxillofacial surgeon declined a patient with bilateral jaw fractures. Surgeons were available."],
          ["$400,000", "WMCHealth, 21 April 2025", "New York's Attorney General called it \"the first settlement in the nation reached by an attorney general\" under EMTALA. It concerned mental-health emergency care, not surgery."],
          ["$500,000", "NewYork-Presbyterian, 13 April 2026", "A second New York Attorney General EMTALA settlement. State enforcement now runs beside OIG."],
        ].map(([n, w, t]) => <div className="evrow" role="listitem" key={w}><b>{n}</b><div><h3>{w}</h3><p>{t}</p></div></div>)}
      </div>
      <div id="limits" className="limits" role="note">
        <h3><Icon n="alert" />What this product does not claim</h3>
        <ol>
          <li><b>EMTALA covers refusal and delay, not diagnostic error.</b> In <i>Rodriguez v. Ascension Seton</i> (W.D. Tex., September 2025) EMTALA claims were dismissed with prejudice because a misdiagnosis defeats a failure-to-stabilise claim: the hospital never acquires actual knowledge of an emergency condition. Holdfast starts after the treating physician has documented the emergency and the needed procedure. It does nothing about misdiagnosis and does not diagnose.</li>
          <li><b>No court has held that an on-call surgeon's refusal over payment violates EMTALA.</b> The closest case, <i>Williams v. Dimensions Health Corp.</i> (4th Cir., No. 18-2139), involved an insured patient and the hospital won. Everything cited here is an administrative settlement, not a judicial holding, and the two settlements above do not say payment was the reason.</li>
        </ol>
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section id="how" className="sect">
      <div className="eyebrow">How it works</div>
      <h2>Approve once, authorize without anyone present</h2>
      <p className="lede">An agent cannot start a new PayPal-wallet payment without a person in a browser. So the sponsor approves once, PayPal stores a token, and the agent authorizes against it from then on.</p>
      <ol className="flow">
        <li><b>Sponsor vaults once</b><p><code>/v3/vault/setup-tokens</code>, then <code>/v3/vault/payment-tokens</code>.</p></li>
        <li><b>Agent sizes the guarantee</b><p>Claude Sonnet 4.5 on Bedrock reads the price file and fund balance through tools.</p></li>
        <li><b>Hold or fund</b><p>One authorization per patient, or one large fund drawn down by partial captures.</p></li>
        <li><b>Capture, reauthorize, void</b><p>Capture when care is documented. Reauthorize from day 4. Void releases the rest.</p></li>
      </ol>
    </section>
  );
}

export function Fund({ pool, busy, onOpen, onClose, onSweep, note }) {
  const open = pool?.status === "open";
  const drawn = Number(pool?.drawn || 0), reserved = Number(pool?.reserved || 0), amount = Number(pool?.amount || 0), remaining = Number(pool?.remaining || 0);
  const pct = (v) => (amount ? Math.max(0, Math.min(100, (v / amount) * 100)) : 0);
  return (
    <div className="card">
      <h3>Sponsor fund</h3>
      <p className="sub">One authorization funds many guarantees. Each guarantee reserves part of it; each documented procedure draws it down with a partial capture.</p>
      {!open ? <div className="empty"><span>{pool?.status === "closed" ? "The fund is closed and its remainder was released." : "No fund is authorized yet."}</span><button type="button" className="btn primary" disabled={busy === "pool-open"} onClick={onOpen}>{busy === "pool-open" ? <><Spinner />Authorizing…</> : "Authorize $250,000 fund"}</button></div> : <>
        <div className="totals" style={{ marginTop: 0, borderTop: 0, paddingTop: 0 }}>
          <span>Authorized <b>{usd(amount)}</b></span><span>Drawn <b>{usd(drawn, 2)}</b></span><span>Reserved <b>{usd(reserved, 2)}</b></span><span>Free <b>{usd(remaining, 2)}</b></span>
        </div>
        <div className="progress" style={{ height: ".9rem", display: "flex" }} role="img" aria-label={`Fund: ${usd(drawn)} drawn, ${usd(reserved)} reserved, ${usd(remaining)} free`}>
          <i style={{ width: pct(drawn) + "%", background: "var(--settled)" }} /><i style={{ width: pct(reserved) + "%", background: "var(--pending)" }} />
        </div>
        <div className="legend"><span><i style={{ borderColor: "var(--settled)" }} />Drawn (captured)</span><span><i style={{ borderColor: "var(--pending)" }} />Reserved for open cases</span><span><i style={{ borderColor: "var(--line)" }} />Free</span></div>
        <p className="fine">PayPal authorization <code>{pool.authId}</code>. Guaranteed to {pool.honorUntil.slice(0, 10)}, valid to {pool.expires.slice(0, 10)}. Reauthorized {pool.reauths.filter((r) => r.ok).length} times, refused {pool.reauths.filter((r) => !r.ok).length}. Re-issued {pool.reissues}.</p>
        <div className="actions">
          <button type="button" className="btn" disabled={busy === "pool-sweep"} onClick={onSweep}>{busy === "pool-sweep" ? <><Spinner />Asking PayPal…</> : "Skip 4 days and reauthorize fund"}</button>
          <button type="button" className="btn danger" disabled={busy === "pool-close"} onClick={onClose}>{busy === "pool-close" ? <><Spinner />Closing…</> : "Close fund and release remainder"}</button>
        </div>
        {note && <p className="notice" role="status">{note}</p>}
        <details style={{ marginTop: ".9rem" }}><summary style={{ cursor: "pointer", minHeight: "2rem" }}>Fund activity ({pool.log.length})</summary><ol className="trail" style={{ marginTop: ".8rem" }}>{pool.log.slice().reverse().map((l, i) => <li key={i} className="plain"><Icon n="dot" /><time>{l.t.slice(11, 19)}Z</time>{l.text}</li>)}</ol></details>
      </>}
    </div>
  );
}

export function Onboard() {
  const [msg, setMsg] = useState(null);
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = new URLSearchParams(location.search).get("approval_token_id");
    if (t) { setBusy(true); setMsg("Vaulting the approved account…"); api.vault(t).then((r) => { setOut(r.sponsor); setMsg(null); history.replaceState({}, "", location.pathname + "#sponsor"); }).catch((e) => setMsg(`${e.message} Start the approval again.`)).finally(() => setBusy(false)); }
  }, []);
  async function start() {
    setBusy(true); setMsg("Creating a setup token…");
    try { const r = await api.setup(location.origin + location.pathname); location.href = r.approveUrl; } catch (e) { setMsg(e.message); setBusy(false); }
  }
  return (
    <section id="sponsor" aria-label="Sponsor onboarding" style={{ marginTop: "1.75rem" }}>
      <div className="card" style={{ marginTop: 0 }}>
        <h3>The one step that needs a person</h3>
        <p className="sub">Vaulting needs a buyer login, so this uses a sponsor vaulted earlier.</p>
        <button type="button" className="btn" onClick={start} disabled={busy}>{busy ? <><Spinner />Working…</> : "Vault a sponsor's PayPal account"}</button>
        {msg && <p className="notice" role="status">{msg}</p>}
        {out && <div className="banner settled" role="status"><Icon n="check" /><div><b>Vaulted</b>{out.name} is stored server-side. The token never reaches the browser; the API accepts sponsor id <code>{out.id}</code> for new guarantees.</div></div>}
      </div>
    </section>
  );
}
