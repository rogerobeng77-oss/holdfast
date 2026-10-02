// Computes WCAG contrast ratios for the real token pairs in frontend/src/styles.css (light and dark).
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../frontend/src/styles.css", import.meta.url), "utf8");
const grab = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1], m[2]]));
const light = grab(css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")));
const dark = grab(css.slice(css.indexOf(':root[data-theme="dark"] {'), css.indexOf("* { box-sizing")));
const lum = (h) => { const v = h.replace("#", ""); const n = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// [label, fg token, bg token, minimum]. 4.5 for normal text; 3 for large (>=18pt/24px) or bold >=14pt/18.66px text and UI parts.
const pairs = [
  ["Body text on page", "ink", "page", 4.5], ["Body text on card", "ink", "surface", 4.5], ["Secondary text on card", "ink-2", "surface", 4.5], ["Tertiary/caption text on card", "ink-3", "surface", 4.5],
  ["Tertiary text on page", "ink-3", "page", 4.5], ["Tertiary text on sunken", "ink-3", "sunken", 4.5], ["Link/accent text on card", "accent-ink", "surface", 4.5], ["Accent text on page", "accent-ink", "page", 4.5],
  ["Headline accent (large) on card", "accent", "surface", 3], ["Pending text on pending bg", "pending", "pending-bg", 4.5], ["Settled text on settled bg", "settled", "settled-bg", 4.5],
  ["Alarm text on alarm bg", "alarm", "alarm-bg", 4.5], ["Pending value on card", "pending", "surface", 4.5], ["Settled value on card", "settled", "surface", 4.5],
  ["Nav text on gradient start", "on-nav", "nav-a", 4.5], ["Nav text on gradient end", "on-nav", "nav-b", 4.5], ["Primary button text on start", "on-nav", "nav-a", 4.5],
  ["Solid danger button text", "on-alarm", "alarm", 4.5], ["Badge pending on its bg", "pending", "pending-bg", 4.5], ["Paper ink on paper", "paper-ink", "paper", 4.5], ["Paper secondary on paper", "paper-2", "paper", 4.5],
  ["Selected chip: ink on accent-soft", "ink", "accent-soft", 4.5], ["Focus ring on page (UI part)", "focus", "page", 3], ["Focus ring on card (UI part)", "focus", "surface", 3], ["Input border on card (UI part)", "line", "surface", 1],
];
const rows = [];
for (const [name, t] of [["light", light], ["dark", dark]]) {
  const T = { ...light, ...t };
  for (const [label, f, b, min] of pairs) {
    if (label.startsWith("Input border")) continue;
    const r = ratio(T[f], T[b]);
    rows.push({ theme: name, label, fg: T[f], bg: T[b], ratio: r.toFixed(2), need: min, pass: r >= min });
  }
}
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.theme.padEnd(5)} ${r.ratio.padStart(5)}:1 (need ${r.need})  ${r.label}  [${r.fg} on ${r.bg}]`);
console.log(rows.every((r) => r.pass) ? "\nALL PASS" : "\nFAILURES: " + rows.filter((r) => !r.pass).length);
