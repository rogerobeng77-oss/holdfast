import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import recorded from "./recorded.json";
import { Disclose, Icon, friendly, sleep } from "./ui.jsx";
import { Actions, Banner, FlowChart, Ledger, Machine, Paper, Recent, Sizing, Tiles, Trace, Trail, Webhooks, commitmentMs } from "./sections.jsx";
import { Reconstruct } from "./reconstruct.jsx";
import { Evidence, Fund, HowItWorks, Onboard } from "./extra.jsx";

const TABS = [["case", "Case"], ["record", "Record"], ["reconstruct", "Reconstruct"], ["details", "PayPal"], ["evidence", "Evidence"], ["how", "How it works"]];
const usd0 = (v) => Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
function headline(c, sc) {
  const who = `${sc.patient} · ${sc.specialty}`;
  if (!c?.sizing) return `${who} · no guarantee yet`;
  if (!c.auth) return `${who} · ${usd0(c.sizing.amount)} sized, not yet authorized`;
  const charged = (c.captures || []).reduce((a, x) => a + Number(x.amount), 0);
  const back = Number(c.auth.amount) - charged;
  // The returned money is the point of the product, so the heading states it rather
  // than leaving a reader to subtract two figures themselves.
  if (charged && back > 0.005 && (c.state === "captured" || c.state === "voided")) {
    return `${usd0(back)} went back to the sponsor. The hospital was paid ${usd0(charged)} of a ${usd0(c.auth.amount)} guarantee.`;
  }
  const tail = c.state === "voided" ? (charged ? `${usd0(charged)} charged, remainder released` : "released, nothing charged") : charged ? `${usd0(charged)} charged` : "nothing charged yet";
  return `${who} · ${usd0(c.auth.amount)} guaranteed, ${tail}`;
}
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } } };

export default function App() {
  const [config, setConfig] = useState(recorded.config);
  const [sel, setSel] = useState("neck-bleed");
  const [mode, setMode] = useState("hold");
  const [cases, setCases] = useState(recorded.cases);
  const [pool, setPool] = useState(recorded.config.pool || null);
  const [live, setLive] = useState({});
  const [busy, setBusy] = useState(null);
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState(store.get("holdfast.theme", "light"));
  const [active, setActive] = useState("case");
  const startRef = useRef(0);
  const restored = useRef({});
  const c = cases[sel];
  const sc = config.scenarios.find((s) => s.id === sel);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme);
    store.set("holdfast.theme", theme);
  }, [theme]);
  useEffect(() => {
    api.config().then((cf) => { if (cf?.scenarios) { setConfig(cf); setPool(cf.pool); } }).catch(() => {});
  }, []);
  useEffect(() => { // restore this scenario's stored case once, when it is first shown
    const id = store.get("holdfast.cases", {})[sel];
    if (!id || restored.current[sel]) return;
    restored.current[sel] = true;
    api.getCase(id).then((x) => { if (x?.events) { setCases((m) => ({ ...m, [sel]: x })); setLive((l) => ({ ...l, [sel]: true })); } }).catch(() => {});
  }, [sel]);
  useEffect(() => { if (!busy && !running) return; const i = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(i); }, [busy, running]);
  useEffect(() => {
    const read = () => { const h = location.hash.slice(1); setActive(h === "limits" ? "evidence" : TABS.some(([k]) => k === h) ? h : "case"); window.scrollTo(0, 0); };
    read(); window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const put = (x, key = sel) => { setCases((m) => ({ ...m, [key]: x })); if (x?.id) { const s = store.get("holdfast.cases", {}); s[key] = x.id; store.set("holdfast.cases", s); } };
  const refreshPool = () => api.config().then((cf) => { if (cf?.scenarios) setPool(cf.pool); }).catch(() => {});

  async function act(key, fn) {
    setErr(null); setNote(null); setBusy(key); startRef.current = startRef.current || Date.now();
    try { await fn(); } catch (e) { setErr(friendly(e.message)); }
    setBusy(null);
  }
  const onStart = () => act("start", async () => {
    if (mode === "pool" && pool?.status !== "open") throw new Error("Authorize the fund first, then start a case in fund mode.");
    startRef.current = Date.now(); put(null); setLive((l) => ({ ...l, [sel]: true }));
    put(await api.create(sel, mode));
  });
  const onStep = (name) => act(name, async () => { const x = await api.step(c.id, name); put(x); if (mode === "pool" || c.mode === "pool") refreshPool(); });
  const onSkip = () => act("skip", async () => {
    const x = await api.step(c.id, "sweep", { simulateDays: 4 }); put(x);
    const s = x.sweep;
    setNote(s.action === "refused" ? `PayPal refused the reauthorization (${s.issue}): ${s.paypal || ""} The clock here jumped four days; PayPal's did not. The hold stays in place and the daily sweep retries it.` : s.action === "reauthorized" ? "PayPal accepted the reauthorization. The honor period restarted." : s.action === "reissued" ? "The authorization was older than 29 days, so a new one was issued from the vault." : "Nothing to do: the hold is still inside its honor period.");
    if (c.mode === "pool") refreshPool();
  });
  const onDraft = () => act("audit", async () => put(await api.step(c.id, "audit")));
  const poolOpen = () => act("pool-open", async () => { const r = await api.pool("open", { amount: 250000 }); setPool(r.pool); });
  const poolClose = () => act("pool-close", async () => { const r = await api.pool("close", {}); setPool(r.pool); });
  const poolSweep = () => act("pool-sweep", async () => { const r = await api.pool("sweep", { simulateDays: 4 }); setPool(r.pool); const s = r.sweep; setNote(s.action === "refused" ? `PayPal refused the fund reauthorization (${s.issue}): ${s.paypal || ""} The fund stays authorized.` : s.action === "reauthorized" ? "PayPal accepted the fund reauthorization." : "Nothing to do yet."); });

  async function onRunAll() {
    setErr(null); setNote(null); setRunning(true); startRef.current = Date.now(); setLive((l) => ({ ...l, [sel]: true }));
    const steps = ["Sizing the guarantee", "Authorizing the guarantee", "Contacting the on-call surgeon", ...(sc.outcome === "capture" ? (sc.hasStay ? ["Documenting the procedure", "Documenting discharge"] : ["Documenting the procedure"]) : ["Voiding the hold"]), "Drafting the record"];
    const tick = (i) => setProg({ i, n: steps.length, label: steps[i - 1] + "…" });
    try {
      if (mode === "pool" && pool?.status !== "open") throw new Error("Authorize the fund first, then run a case in fund mode.");
      tick(1); put(null); let x = await api.create(sel, mode); put(x); await sleep(600);
      tick(2); x = await api.step(x.id, "authorize"); put(x); await sleep(1200);
      tick(3); x = await api.step(x.id, "contact"); put(x); await sleep(1200);
      if (sc.outcome === "capture") { tick(4); x = await api.step(x.id, "document"); put(x); if (sc.hasStay) { await sleep(1200); tick(5); x = await api.step(x.id, "discharge"); put(x); } }
      else { tick(4); x = await api.step(x.id, "void"); put(x); }
      tick(steps.length); x = await api.step(x.id, "audit"); put(x);
      if (mode === "pool") refreshPool();
    } catch (e) { setErr(friendly(e.message)); }
    setProg(null); setRunning(false);
  }
  const elapsed = (busy || running) && !c?.auth ? now - startRef.current : null;

  return (
    <>
      <a className="skip" href="#case">Skip to the case</a>
      <header className="nav">
        <div className="wrap">
          <a className="brand" href="#top" aria-label="Holdfast, top of page">
            <span className="brand-mark"><svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 17h8l3-8 4 15 3-9h10" fill="none" stroke="#b3121c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Holdfast
          </a>
          <nav className="tabs" aria-label="Views">{TABS.map(([k, l]) => <a key={k} href={"#" + k} aria-current={active === k ? "page" : undefined}>{l}</a>)}</nav>
          <span className="pill"><Icon n={running || busy ? "clock" : c?.state === "captured" || c?.state === "voided" ? "check" : "ring"} />{running || busy ? "RUNNING LIVE" : c?.state === "captured" ? "SETTLED" : c?.state === "voided" ? "RELEASED" : "SANDBOX"}</span>
          <button type="button" className="theme" onClick={() => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")} aria-label={`Colour theme: ${theme}. Choose to switch.`}>Theme: {theme}</button>
        </div>
      </header>

      {active === "case" && <>
      <section className="statusline" id="top">
        <div className="wrap">
          <h1>{headline(c, sc)}</h1>
        </div>
      </section>

      <section className="casebar" id="case" aria-label="Choose a case">
        <div className="wrap">
          <div className="chips" role="tablist" aria-label="Demo case">
            {config.scenarios.map((s) => <button key={s.id} role="tab" aria-selected={s.id === sel} className="chip" disabled={running || !!busy} onClick={() => { setSel(s.id); setErr(null); setNote(null); }}><b>{s.promise || s.specialty}</b><small>{s.specialty}</small></button>)}
          </div>
          <div><span className="seg-label" id="fm">Funding</span>
            <div className="seg" role="group" aria-labelledby="fm">
              <button type="button" aria-pressed={mode === "hold"} onClick={() => setMode("hold")} disabled={running || !!busy}>Per-case hold</button>
              <button type="button" aria-pressed={mode === "pool"} onClick={() => setMode("pool")} disabled={running || !!busy}>Fund pool</button>
            </div></div>
          <button type="button" className="btn primary" onClick={onRunAll} disabled={running || !!busy}>{running ? "Running…" : live[sel] ? "Run all steps again" : "Run all steps live"}</button>
        </div>
      </section>

      <Tiles c={c} sc={sc} elapsed={elapsed} running={running || busy === "start"} />
      </>}

      <main className="wrap">
        {active === "case" && (
        <section className="sect" style={{ paddingTop: "1.5rem" }} aria-labelledby="case-h">
          <p className="lede" id="case-h">{sc.presentation}</p>
          <Banner c={c} err={err} sc={sc} prog={prog} busy={busy} />
          <div className="card">
            <Machine c={c} />
            <Actions c={c} sc={sc} busy={busy} running={running} needFund={mode === "pool" && pool?.status !== "open"} onStart={onStart} onStep={onStep} onSkip={onSkip} onRunAll={onRunAll} />
            {note && <p className="notice" role="status">{note}</p>}
          </div>
          {(mode === "pool" || pool?.status === "open") && <Fund pool={pool} busy={busy} onOpen={poolOpen} onClose={poolClose} onSweep={poolSweep} note={null} />}
        </section>
        )}

        {active !== "case" && ["record", "details"].includes(active) && <p className="viewing">Showing {sc.patient}, {sc.specialty.toLowerCase()}. <a href="#case">Change the case</a></p>}

        {active === "record" && <section id="record" className="sect" aria-labelledby="record-h">
          <div className="eyebrow">The audit record</div>
          <h2 id="record-h">What was requested, when, who was contacted, what they said</h2>
          <Paper c={c} busy={busy} onDraft={onDraft} />
          <FlowChart c={c} cap={config.sponsors[0]?.perCaseCap || 120000} />
          <details className="disclose">
            <summary>How this was decided</summary>
            <Sizing c={c} busy={busy || (running && prog?.i === 1 ? "start" : null)} />
            <Trace bare agent={c?.sizing?.agent} title="Sizing agent tool calls" intro="Four tools: the price file, a procedure bundle, the sponsor's remaining balance, and a pricing check that rejects anything over a limit." />
          </details>
        </section>}

        {active === "reconstruct" && <section id="reconstruct" className="sect" aria-labelledby="rec-h">
          <div className="eyebrow">The hard part</div>
          <h2 id="rec-h">Reconstructing a record from a messy log</h2>
          <p className="lede">Logs arrive out of order, repeat a contact, miss a stretch. The agent flags those problems and says a gap is not recorded instead of filling it.</p>
          <Reconstruct sample={config.messySample || recorded.config.messySample} initial={recorded.reconstruct} />
        </section>}

        {active === "details" && <section id="details" className="sect" aria-labelledby="pp-h">
          <div className="eyebrow">Audit details</div>
          <h2 id="pp-h">PayPal ids, webhooks and stored cases</h2>
          <Disclose title="PayPal calls for this case"><Ledger c={c} /></Disclose>
          <Disclose title="Verified webhook events"><Webhooks /></Disclose>
          <Disclose title="Recent cases"><Recent current={c?.id} onOpen={(x) => { put(x, x.scenarioId); setSel(x.scenarioId); setLive((l) => ({ ...l, [x.scenarioId]: true })); location.hash = "case"; }} /></Disclose>
        </section>}

        {active === "evidence" && <Evidence />}
        {active === "how" && <><HowItWorks /><Onboard /></>}
      </main>
      <footer>
        <div className="wrap">
          <span>Holdfast · MIT licence · PayPal AI Hackathon 2026</span>
          
        </div>
      </footer>
    </>
  );
}

