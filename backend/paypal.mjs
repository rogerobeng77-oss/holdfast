// Thin PayPal REST client. Endpoints verified against the LIVE schemas:
//   developer.paypal.com/api/payment-tokens/v3/schema.json  (vault is /v3, not /v2)
//   developer.paypal.com/api/orders/v2/schema.json
//   developer.paypal.com/api/payments/v2/schema.json
// The PayPal-Request-Id header makes every money-moving call idempotent.
let cached = { token: null, exp: 0 };

export function cfg(env = process.env) {
  return { api: env.PAYPAL_API || "https://api-m.sandbox.paypal.com", id: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET };
}

export async function accessToken(c = cfg()) {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`${c.api}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${c.id}:${c.secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new PayPalError("oauth", r.status, j);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

export class PayPalError extends Error {
  constructor(where, status, body) {
    const issue = body?.details?.[0]?.issue || body?.name || "error";
    super(`PayPal ${where} ${status} ${issue}: ${body?.message || body?.details?.[0]?.description || ""}`);
    this.where = where; this.status = status; this.body = body; this.issue = issue;
  }
}

async function call(method, path, body, requestId, c = cfg()) {
  const t = await accessToken(c);
  const headers = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const r = await fetch(`${c.api}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new PayPalError(`${method} ${path}`, r.status, j);
  return j;
}

// ---- Vault (sponsor approves ONCE in a browser; everything after is hands-free)
export const createSetupToken = (returnUrl, cancelUrl, c) =>
  call("POST", "/v3/vault/setup-tokens", {
    payment_source: { paypal: { usage_type: "MERCHANT", usage_pattern: "UNSCHEDULED_POSTPAID",
      experience_context: { return_url: returnUrl, cancel_url: cancelUrl } } },
  }, null, c);
export const createPaymentToken = (setupTokenId, requestId, c) =>
  call("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, requestId, c);
export const getPaymentToken = (id, c) => call("GET", `/v3/vault/payment-tokens/${id}`, null, null, c);

// ---- Authorize against the vaulted token. No buyer, no browser.
// Observed in sandbox: with a vault_id + stored_credential the order comes back COMPLETED with the
// authorization already created, so a separate /authorize call returns ORDER_ALREADY_AUTHORIZED.
export async function authorizeWithVault({ vaultId, amount, description, customId, requestId }, c) {
  const order = await call("POST", "/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [{ description, custom_id: customId, amount: { currency_code: "USD", value: amount } }],
    payment_source: { paypal: { vault_id: vaultId,
      stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_POSTPAID" } } },
  }, requestId, c);
  let authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!authorization) { // not yet authorized: call the explicit endpoint
    const a = await call("POST", `/v2/checkout/orders/${order.id}/authorize`, {}, `${requestId}-authz`, c);
    authorization = a.purchase_units?.[0]?.payments?.authorizations?.[0];
  }
  if (!authorization || authorization.status !== "CREATED") throw new Error(`authorization not created: ${JSON.stringify(order).slice(0, 300)}`);
  return { orderId: order.id, orderStatus: order.status, authorization };
}
export const getAuthorization = (id, c) => call("GET", `/v2/payments/authorizations/${id}`, null, null, c);
export const capture = (authId, amount, requestId, note, finalCapture = true, c) =>
  call("POST", `/v2/payments/authorizations/${authId}/capture`,
    { amount: { currency_code: "USD", value: amount }, final_capture: finalCapture, note_to_payer: note }, requestId, c);
// Honor period is 3 days; the authorization itself is valid 29 days. Reauthorize from day 4; after day 29
// a brand-new authorization is needed (live spec: payments/v2 reauthorize).
export const reauthorize = (authId, amount, requestId, c) =>
  call("POST", `/v2/payments/authorizations/${authId}/reauthorize`, { amount: { currency_code: "USD", value: amount } }, requestId, c);
export const voidAuth = (authId, requestId, c) => call("POST", `/v2/payments/authorizations/${authId}/void`, null, requestId, c);

// ---- Webhooks
export const registerWebhook = (url, types, c) => call("POST", "/v1/notifications/webhooks", { url, event_types: types.map((name) => ({ name })) }, null, c);
export const listWebhooks = (c) => call("GET", "/v1/notifications/webhooks", null, null, c);
export const deleteWebhook = (id, c) => call("DELETE", `/v1/notifications/webhooks/${id}`, null, null, c);
export const verifyWebhook = (webhookId, headers, event, c) =>
  call("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"], transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"], transmission_time: headers["paypal-transmission-time"],
    webhook_id: webhookId, webhook_event: event,
  }, null, c);

export const cents = (v) => Math.round(Number(v) * 100);
export const money = (c) => (c / 100).toFixed(2);
