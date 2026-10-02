import { readFileSync, existsSync } from "node:fs";
const load = (f) => { if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; } };
load(new URL("../../../.env", import.meta.url).pathname);
process.env.VAULT_TOKEN_ID ??= readFileSync(new URL("../.deploy-state/vault-token-id", import.meta.url), "utf8").trim();
process.env.TABLE ??= "holdfast";
