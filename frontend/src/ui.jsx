import React, { useEffect, useRef, useState } from "react";

export const usd = (v, d = 0) => (v == null || v === "" ? "n/a" : Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d }));
export const clock = (iso) => new Date(iso).toISOString().slice(11, 19) + "Z";
export const secs = (ms) => (ms / 1000).toFixed(1) + " s";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P = {
  check: "M20 6 9 17l-5-5",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  x: "M18 6 6 18M6 6l12 12",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  dot: "M12 12h.01",
  ring: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  pulse: "M2 12h5l3-8 4 16 3-8h5",
  gap: "M4 12h4M16 12h4M10 8l4 8",
};
export const Icon = ({ n, ...p }) => (
  <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d={P[n]} /></svg>
);
export const Badge = ({ tone = "", icon, children }) => <span className={"badge " + tone}>{icon && <Icon n={icon} />}{children}</span>;
export const Spinner = () => <span className="spin" aria-hidden="true" />;
export const Skeleton = ({ lines = 3 }) => <div aria-hidden="true">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${92 - i * 14}%` }} />)}</div>;

export function useWidth() {
  const ref = useRef(null); const [w, setW] = useState(900);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current); return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function friendly(msg) {
  if (/too many requests|throttl/i.test(msg)) return "The model account allows 10 requests a minute and the limit was hit. Wait about a minute, then run this step again.";
  if (/case is (\w+)/.test(msg)) return `That step is not available while the case is ${msg.match(/case is (\w+)/)[1].replace("_", " ")}. Use the highlighted next step.`;
  return msg;
}

// A disclosure that mounts its children only after it is first opened, so closed panels cost no API calls.
export function Disclose({ title, children }) {
  const [seen, setSeen] = useState(false);
  return (
    <details className="disclose" onToggle={(e) => { if (e.currentTarget.open) setSeen(true); }}>
      <summary>{title}</summary>
      {seen && children}
    </details>
  );
}
