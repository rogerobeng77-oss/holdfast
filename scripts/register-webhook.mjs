// Registers (or re-registers) the PayPal webhook pointing at the deployed Function URL and stores its id
// in DynamoDB so the Lambda can verify signatures. Usage: node scripts/register-webhook.mjs <function-url>
import * as pp from "../backend/paypal.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const url = process.argv[2].replace(/\/$/, "") + "/api/webhook";
for (const w of (await pp.listWebhooks()).webhooks || []) if (w.url === url) { await pp.deleteWebhook(w.id); console.log("deleted old", w.id); }
const w = await pp.registerWebhook(url, ["PAYMENT.AUTHORIZATION.CREATED", "PAYMENT.AUTHORIZATION.VOIDED", "PAYMENT.CAPTURE.COMPLETED", "VAULT.PAYMENT-TOKEN.CREATED"]);
console.log("registered", w.id, w.url);
execFileSync("aws", ["dynamodb", "put-item", "--table-name", "holdfast", "--region", "us-east-1", "--item",
  JSON.stringify({ pk: { S: "meta#webhook-id" }, v: { S: w.id }, ts: { N: String(Date.now()) } })]);
console.log("stored webhook id in DynamoDB");
