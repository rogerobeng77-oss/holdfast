// Real calls to the PayPal sandbox. No mocks. Run: node --test tests/paypal.sandbox.test.mjs
import "./env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as pp from "../backend/paypal.mjs";

const vaultId = process.env.VAULT_TOKEN_ID;
const run = Date.now().toString(36);
const log = (...a) => console.log("   ", ...a);

test("oauth: client credentials return a token", async () => {
  const t = await pp.accessToken(); assert.ok(t.length > 20); log("token length", t.length);
});

test("vault: the sponsor's payment token exists and is a PayPal wallet", async () => {
  const t = await pp.getPaymentToken(vaultId);
  assert.equal(t.id, vaultId); assert.ok(t.payment_source.paypal.payer_id);
  log("payment token", t.id, "payer", t.payment_source.paypal.payer_id, t.payment_source.paypal.email_address, "usage", t.payment_source.paypal.usage_type);
});

test("vault: a new setup token is created and waits for the sponsor's one-time browser approval", async () => {
  const s = await pp.createSetupToken("https://example.com/ok", "https://example.com/no");
  assert.equal(s.status, "PAYER_ACTION_REQUIRED");
  const approve = s.links.find((l) => l.rel === "approve").href; assert.match(approve, /agreements\/approve/);
  log("setup token", s.id, s.status, approve);
});

test("authorize: vaulted token authorizes with no buyer present", async () => {
  const r = await pp.authorizeWithVault({ vaultId, amount: "1500.00", description: "test authorize", customId: "t-" + run, requestId: `t-${run}-a1` });
  assert.equal(r.authorization.status, "CREATED"); assert.equal(r.authorization.amount.value, "1500.00");
  const got = await pp.getAuthorization(r.authorization.id); assert.equal(got.status, "CREATED");
  log("order", r.orderId, r.orderStatus, "authorization", r.authorization.id, got.status, "expires", r.authorization.expiration_time);
});

test("authorize: same PayPal-Request-Id is idempotent (no second hold)", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "500.00", description: "idem", customId: "i-" + run, requestId: `t-${run}-idem` });
  const b = await pp.authorizeWithVault({ vaultId, amount: "500.00", description: "idem", customId: "i-" + run, requestId: `t-${run}-idem` });
  assert.equal(a.authorization.id, b.authorization.id); log("both calls ->", a.authorization.id);
  await pp.voidAuth(a.authorization.id, `t-${run}-idem-void`);
});

test("capture: partial final capture charges less than the hold", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "2000.00", description: "cap", customId: "c-" + run, requestId: `t-${run}-cap` });
  const c = await pp.capture(a.authorization.id, "1250.00", `t-${run}-cap-c`, "test capture");
  assert.equal(c.status, "COMPLETED");
  const got = await pp.getAuthorization(a.authorization.id);
  log("authorization", a.authorization.id, "capture", c.id, c.status, "authorization now", got.status);
  assert.ok(["CAPTURED", "PARTIALLY_CAPTURED"].includes(got.status));
});

test("void: releases the hold, sponsor charged nothing", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "3000.00", description: "void", customId: "v-" + run, requestId: `t-${run}-void` });
  await pp.voidAuth(a.authorization.id, `t-${run}-void-v`);
  const got = await pp.getAuthorization(a.authorization.id); assert.equal(got.status, "VOIDED");
  log("authorization", a.authorization.id, "->", got.status);
});

test("void after void is rejected (a hold cannot be released twice)", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "100.00", description: "v2", customId: "v2-" + run, requestId: `t-${run}-v2` });
  await pp.voidAuth(a.authorization.id, `t-${run}-v2a`);
  await assert.rejects(() => pp.voidAuth(a.authorization.id, `t-${run}-v2b`), (e) => { log("second void ->", e.status, e.issue); return e.status >= 400; });
});

test("bad vault id is refused by PayPal", async () => {
  await assert.rejects(() => pp.authorizeWithVault({ vaultId: "nope123", amount: "10.00", description: "x", customId: "x", requestId: `t-${run}-bad` }), (e) => { log("->", e.status, e.issue); return e.status >= 400; });
});

test("lifecycle: two-stage partial capture, then final capture releases the rest", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "5000.00", description: "staged", customId: "s-" + run, requestId: `t-${run}-stage` });
  const c1 = await pp.capture(a.authorization.id, "2000.00", `t-${run}-stage-1`, "procedure", false);
  const g1 = await pp.getAuthorization(a.authorization.id);
  const c2 = await pp.capture(a.authorization.id, "1500.00", `t-${run}-stage-2`, "discharge", true);
  const g2 = await pp.getAuthorization(a.authorization.id);
  log("capture 1", c1.id, c1.status, "->", g1.status, "| capture 2 (final)", c2.id, c2.status, "->", g2.status);
  assert.equal(c1.status, "COMPLETED"); assert.equal(g1.status, "PARTIALLY_CAPTURED"); assert.equal(c2.status, "COMPLETED"); assert.equal(g2.status, "CAPTURED");
});

test("lifecycle: void after a partial capture releases only what is left", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "4000.00", description: "void-after-partial", customId: "vp-" + run, requestId: `t-${run}-vp` });
  await pp.capture(a.authorization.id, "1000.00", `t-${run}-vp-c`, "procedure", false);
  await pp.voidAuth(a.authorization.id, `t-${run}-vp-v`);
  const g = await pp.getAuthorization(a.authorization.id);
  log("authorization after partial capture then void ->", g.status); assert.equal(g.status, "VOIDED");
});

test("lifecycle: reauthorization inside the honor period is refused by PayPal (real call)", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "800.00", description: "reauth", customId: "ra-" + run, requestId: `t-${run}-ra` });
  await assert.rejects(() => pp.reauthorize(a.authorization.id, "800.00", `t-${run}-ra-r`), (e) => { log("reauthorize on day 0 ->", e.status, e.issue, "|", e.body.details[0].description); return e.issue === "REAUTHORIZATION_TOO_SOON"; });
  await pp.voidAuth(a.authorization.id, `t-${run}-ra-v`);
});

test("lifecycle: capturing a voided authorization is refused", async () => {
  const a = await pp.authorizeWithVault({ vaultId, amount: "300.00", description: "cap-void", customId: "cv-" + run, requestId: `t-${run}-cv` });
  await pp.voidAuth(a.authorization.id, `t-${run}-cv-v`);
  await assert.rejects(() => pp.capture(a.authorization.id, "300.00", `t-${run}-cv-c`, "x", true), (e) => { log("capture after void ->", e.status, e.issue); return e.status === 422; });
});
