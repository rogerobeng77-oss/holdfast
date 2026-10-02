# Holdfast

An instant payment guarantee for emergency surgery, so ability to pay cannot be the reason a hospital or an on-call surgeon refuses.

A patient presents to an emergency department and needs surgery. An agent sizes a guarantee from the hospital's published price data, authorizes that amount against a sponsor's vaulted PayPal account, and the hospital sees a real honoured commitment. The money is captured only when the procedure is documented, so no sponsor is charged for care that was not given. Along the way the agent builds the audit record that the federal settlements show is hard to reconstruct afterwards: what was requested, when, which on-call specialist was contacted, and what they said.

The sponsor is a charity fund, an employer, a hospital's uncompensated-care pool or a mutual-aid group. It is never the patient.

- Site: https://d2xm2cdvyum4cx.cloudfront.net
- API (Lambda Function URL): https://hmse6gxn43ybbd5lwqd335g7tu0bsuah.lambda-url.us-east-1.on.aws
- Everything runs against the PayPal **sandbox**. All money is fake. The hospital, clinicians and patients are fictional.
- Licence: MIT (`LICENSE`).

## The problem, with the verified figures

| Fact | Source |
|---|---|
| HHS-OIG has roughly **100** EMTALA civil monetary penalty settlements. | oig.hhs.gov enforcement listing |
| **Spartanburg Medical Center, $100,000.** Conduct in May 2024 (settled 12 November 2025): an actively bleeding carotid hematoma narrowed the airway and the on-call vascular surgeon would not come in. | HHS-OIG |
| **Flowers Hospital, Dothan, $150,000.** Conduct in May 2021 (settled 25 July 2025): the on-call oral and maxillofacial surgeon declined a patient with bilateral jaw fractures. | HHS-OIG |
| In both cases surgeons were available. | HHS-OIG |
| State attorneys general now enforce EMTALA: **WMCHealth $400,000** (21 April 2025), described by the New York OAG as "the first settlement in the nation reached by an attorney general"; **NewYork-Presbyterian $500,000** (13 April 2026). Both concerned mental-health emergency care, not surgery. | NY Attorney General press releases |

Full research and sources are in `../../research/health/FINDINGS.md`. The figures are used exactly as verified there. One claim from the original brief, that the two state settlements are "larger than all but three of OIG's hundred", could not be re-verified from that file and is not used.

### What this product does not claim

1. **EMTALA covers refusal and delay, not diagnostic error.** In *Rodriguez v. Ascension Seton* (W.D. Tex., September 2025) EMTALA claims were dismissed with prejudice because a misdiagnosis defeats a failure-to-stabilise claim: the hospital never acquires "actual knowledge" of an emergency condition. Holdfast starts after the treating physician has documented the emergency and the needed procedure. It does nothing about misdiagnosis and the agents are instructed not to diagnose.
2. **No court has held that an on-call surgeon's refusal over payment violates EMTALA.** The closest case, *Williams v. Dimensions Health Corp.* (4th Cir., No. 18-2139), involved an insured patient and the hospital won. Everything cited here is an administrative settlement, not a judicial holding, and the two surgical settlements above do not say payment was the reason. The "without a guarantee" lane in the demo is the published finding, not a simulated refusal.

## How it uses PayPal

An agent cannot start a new PayPal-wallet payment without a person in a browser. Holdfast is built around that limit, not against it: the sponsor approves **once**, PayPal stores a token, and from then on the agent authorizes without anyone present.

| Step | Endpoint (checked against the live schema) |
|---|---|
| Sponsor approves once, in a browser | `POST /v3/vault/setup-tokens` (PayPal wallet, `usage_type MERCHANT`) |
| Exchange for a reusable token | `POST /v3/vault/payment-tokens` |
| Authorize with no buyer present | `POST /v2/checkout/orders` with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` plus `stored_credential` (MERCHANT / SUBSEQUENT) |
| Capture documented care (partial, then final) | `POST /v2/payments/authorizations/{id}/capture` with `final_capture` false, then true |
| Keep a hold alive | `POST /v2/payments/authorizations/{id}/reauthorize` |
| Release what is left | `POST /v2/payments/authorizations/{id}/void` |
| State changes | webhooks, verified with `POST /v1/notifications/verify-webhook-signature` |

Corrections to the brief, found by reading the live schemas (`developer.paypal.com/api/<product>/<version>/schema.json`):

- Vault is **v3** (`/v3/vault/...`), not v2.
- With a vaulted PayPal-wallet token, `POST /v2/checkout/orders` returns the order `COMPLETED` with the authorization already created. A separate `/authorize` call then returns `ORDER_ALREADY_AUTHORIZED`. The code treats the first response as the authorization and only calls `/authorize` if none is present.
- **Card vaulting is not available on this account** (`NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`, and `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` for raw cards). Nothing in the code touches a card. The sponsor's PayPal account is what is vaulted.
- The sandbox had no buyer account, so one was created through PayPal's own guest sign-up in the approval page (verification code `111111`). Its vaulted token is `9me21520kn045363h`.

### Two funding modes

- **Per-case hold.** One authorization per patient, sized to that patient. The sponsor's money is held only as long as the case is open.
- **Fund pool.** The sponsor authorizes one large amount once (the demo uses $250,000). Each guarantee *reserves* part of it with no new PayPal call, so commitment is instant; each documented procedure draws it down with a partial capture (`final_capture: false`). Voiding a pool case releases only the reservation, because voiding the PayPal authorization would end the whole fund. Closing the fund voids the authorization and releases the remainder. The fund panel shows authorized, drawn, reserved and free.

### Authorization lifecycle

States: sized, authorized, accepted, partially captured, captured, with **voided** as an exit from authorized, accepted and partially captured, and **reauthorized** and **re-issued** as events. The UI shows the machine for the current case.

- PayPal's live spec: a three-day **honor period** (funds guaranteed), a 29-day authorization life, reauthorization from day 4, and a new authorization after day 29. Holdfast tells the hospital the guarantee holds until the end of the honor period, not for 29 days.
- A **daily EventBridge sweep** (`holdfast-sweep`) reauthorizes any open hold or fund whose honor period has ended, and re-issues one older than 29 days.
- Before every capture the live authorization status is read; if PayPal no longer honours the hold, a new authorization is created from the vaulted token and the event is logged.
- **Partial capture:** the procedure lines are captured first, the inpatient stay at discharge, and the unused remainder is released.
- **What could not be demonstrated:** a *successful* reauthorization. The sandbox enforces its real clock, so day 0 is refused with `REAUTHORIZATION_TOO_SOON`. The tests and the "Skip 4 days" button move Holdfast's clock and record PayPal's real refusal. The PayPal text says reauthorization is allowed "multiple" times; the sandbox error says "only once". An open watch case is left authorized so the daily sweep performs a genuine day-4 reauthorization (see `TEST-RESULTS.md`, "Open item").

### Idempotency

Every mutating PayPal call sends `PayPal-Request-Id`, derived from the case id and the step (for example `hf-<case>-capture-procedure-0`), and the ids are stored on the case and listed in the UI. A replayed request returns PayPal's original result. PayPal's own documents give three different lifetimes for this header: **6 hours** (Orders spec), **3 hours** (Vault spec) and **45 days** (the generic requests page). Holdfast is designed for the shortest, 3 hours, and does not rely on PayPal alone: a DynamoDB conditional write claims each state transition, so a double click, a retry or three concurrent calls make one authorization or one capture. `POST /api/cases` also accepts an idempotency key. Both are tested.

### Webhooks

`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED` and `VAULT.PAYMENT-TOKEN.CREATED` are delivered to `/api/webhook`. Each delivery is verified with PayPal's verify endpoint using the transmission id, time, signature, certificate URL, algorithm, the stored webhook id and the **raw event body** (a re-serialised body fails the check). Failed deliveries are counted and dropped, a genuine replay is accepted and stored once, and the handler answers right after the write: no model call or other slow work sits in the path. A tampered payload is rejected in a test.

## Views and deep links

The tab bar routes to separate views, one at a time: `#case` (default), `#record`, `#reconstruct`, `#details` (PayPal), `#evidence` (`#limits` also lands here) and `#how`. Each can be linked directly. Unknown hashes (including the removed `#contrast`) fall back to the Case view.

## The two agents

Both use the Amazon Bedrock Converse API with tool use (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`), a bounded loop and a visible trace.

1. **Sizing agent.** Tools: `get_price_record`, `lookup_procedure_bundle`, `check_sponsor_balance`, `propose_guarantee`. It plans, calls the lookups in parallel, then proposes lines and a contingency. `propose_guarantee` re-prices every line from the price file in code and rejects a proposal over the per-case limit or the fund's remaining balance; the model never states the dollar figure that reaches PayPal. The trace is shown under "How this was decided".
2. **Record reconstruction agent.** Given a messy log (entries out of order, one specialist paged three times, a 74-minute stretch with nothing logged, an entry with no time, a second-hand report), deterministic tools find the order problems, gaps, repeated contacts and unplaceable entries. The agent records findings that must cite real entry ids and writes a narrative. `write_record` **rejects** any clock time or duration that is not in the log, so the agent cannot fill a gap with a guess; it must list what is "not recorded". The sample output says plainly that nothing is logged between 02:26 and 03:40.

When the model account is rate limited the sizing step reuses the last agent plan for that scenario (re-priced and re-checked, labelled "stored agent plan"), the audit narrative falls back to a labelled template, and reconstruction falls back to a stored result. None of these fall back silently.

## Architecture

```
CloudFront + S3 (React, Vite)  ->  Lambda Function URL (Node 22, one function)
                                      |-- PayPal sandbox (vault, orders, payments, webhooks)
                                      |-- Amazon Bedrock (sizing agent, reconstruction agent, narrative)
                                      |-- DynamoDB on demand (cases, funds, locks, webhook store)
EventBridge daily rule -> same Lambda (reauthorization sweep)
```

AWS account 854924711083, us-east-1. No SAM, no CDK: `deploy.sh` is plain `aws` CLI. The PayPal secret lives only in the Lambda environment (it is read from `../../.env` at deploy time and never committed or sent to the browser). Moving it to Secrets Manager would add about $0.40 a month; it was left in the environment to keep the running cost near zero.

## Run it

```bash
./deploy.sh all              # backend (table, role, Lambda, Function URL, daily rule) then frontend (S3, CloudFront)
node scripts/register-webhook.mjs "$(cat .deploy-state/api-url)"   # once, registers the PayPal webhook
node scripts/record-runs.mjs "$(cat .deploy-state/api-url)"        # refresh the first-load data from real runs
cd frontend && npm install && VITE_API="$(cat ../.deploy-state/api-url)" npm run dev
```

Tests (real PayPal sandbox, Bedrock and DynamoDB, no mocks):

```bash
node --test tests/paypal.sandbox.test.mjs   # 13 tests against PayPal
node --test tests/lambda.local.test.mjs     # 18 tests of the Lambda handler in-process
node tests/e2e.deployed.mjs                 # the deployed CloudFront site and Function URL
node scripts/contrast.mjs                   # WCAG contrast of the real tokens
```

Results with the real output are in `TEST-RESULTS.md`.

## Interface, accessibility and writing

The interface is a monitoring surface: a coloured top bar, four tiles that answer "is this covered, and for how much", one status banner, the lifecycle machine with the actions that are valid right now, and the money chart. Reasoning, price lines, PayPal ids and webhook payloads sit behind disclosures. Light and dark are driven by semantic tokens and follow the system, with a manual switch.

Measured, not estimated (`scripts/contrast.mjs`, real hex values from `styles.css`; full output in `test-output/contrast.txt`):

| Pair | Light | Dark | Needs |
|---|---|---|---|
| Body text on page | 16.84 : 1 | 16.44 : 1 | 4.5 |
| Secondary text on card | 9.74 : 1 | 9.92 : 1 | 4.5 |
| Caption text on card | 6.20 : 1 | 6.93 : 1 | 4.5 |
| Link and accent text on card | 7.54 : 1 | 8.06 : 1 | 4.5 |
| Pending text on its background | 6.54 : 1 | 8.58 : 1 | 4.5 |
| Settled text on its background | 6.04 : 1 | 9.00 : 1 | 4.5 |
| Alarm text on its background | 6.08 : 1 | 7.14 : 1 | 4.5 |
| White text on the top bar (lightest end) | 5.20 : 1 | 6.99 : 1 | 4.5 |
| Headline accent (large text) | 5.72 : 1 | 6.69 : 1 | 3 |
| Focus ring against page | 5.67 : 1 | 9.06 : 1 | 3 |

Every checked pair passes. Smallest text is 13 px (caption and uppercase labels); body text is 16 px. On the deployed site at 360, 640, 768, 1280 and 1920 px wide, all 48 visible controls measured at least 61 by 36 px (the floor is 28 by 28), the smallest text including chart labels is 13 px, and there is no horizontal scroll. Status is never colour alone: each state carries an icon and a word. Every control has a visible 3 px focus ring, icon-only buttons have labels, text sizes are in rem so they follow the browser setting, and animation stops under `prefers-reduced-motion`.

## Known gaps

- **Bedrock is limited to 10 requests a minute on this account** (Sonnet 4.5, quota `L-4A6BFAB1`), and Lambda to 10 concurrent executions. A run uses about three model calls, so a few simultaneous visitors will hit the rate limit and see the labelled fallbacks. AWS support cases for both increases are open (Bedrock `75a887caad49464f9c8bf0a90f9fdab4emT9tJYD`, Lambda `4660347d12a849749b290901a0df3f5f8Hjzh5WF`). The service-quota API would only accept a requested value above the default, so the requests are for 10,001 and 1,001.
- The page shows a recorded real run on first load (so it never opens empty) and runs live on request. The live run takes about 10 to 30 seconds, most of it the sizing agent.
- Specialist replies are scripted. In production they would come from a paging or phone system.
- The public API has no authentication and `POST /api/reset` clears demo cases. It is a sandbox demo; a real deployment needs sign-in, per-sponsor permissions and the secret in Secrets Manager.
- Sponsors other than the seeded one can be vaulted from the page but the case picker uses the seeded sponsor; vaulting a second one proves the flow rather than adding a sponsor chooser.
- Price lines are an illustrative sample in the shape of a hospital price file. Ingesting a real hospital's machine-readable file is the first production task.

## For the submission

Pitch copy removed from the app (the app opens on the state of the case instead). Ready to paste into Devpost and the video script.

**Headline.** Whether the patient can pay should never be the reason a surgeon doesn't come.

**Pitch.** Holdfast sizes a guarantee from the hospital's published prices, holds it on a sponsor's PayPal account, and shows the hospital an honoured commitment. Money moves only when the procedure is documented. Two hospitals paid $100,000 and $150,000 after on-call surgeons would not come in.

**Evidence.** Spartanburg Medical Center, $100,000 (conduct May 2024): the on-call vascular surgeon would not come in for an airway-threatening carotid hematoma. Flowers Hospital, Dothan, $150,000 (conduct May 2021): the on-call oral surgeon declined bilateral jaw fractures. Surgeons were available in both. The full figures, dates and the two limits are on the Evidence tab and in the table above.

**Audit record, as a written statement.** The Record tab keeps the structured timeline as the primary view. The prose version, drafted by Bedrock from the logged events only, sits behind "Read as a written statement" and is the export a lawyer or regulator would read. Example from a real run: "On 2026-10-02 at 02:25:15, a guarantee of $98,106.50 was authorized on Harbor Mutual Aid Fund's vaulted instrument ... with partial capture of $61,210.00 and final capture of $15,800.00, totaling $77,010.00 charged against the guarantee. The unused portion of $21,096.50 was released."

**With a guarantee, and without** (removed from the app, for the write-up and video). Without a guarantee: Spartanburg Medical Center paid $100,000 to HHS-OIG (conduct May 2024, settled 12 November 2025) after the on-call vascular surgeon would not come in for an airway-threatening carotid hematoma. Surgeons were available. No honoured commitment existed, and nothing records what was asked, when, and what the specialist said. The settlement is the published finding, not a simulated refusal, and it does not say payment was the reason. The Flowers Hospital version: $150,000 (conduct May 2021, settled 25 July 2025), the on-call oral surgeon declined bilateral jaw fractures. With Holdfast: the same case reaches an honoured PayPal authorization of $98,106.50 about 10 seconds after presentation (sizing agent turns plus a live PayPal call), the sponsor is charged $77,010.00 only after the care is documented, $21,096.50 is released, and the request, the specialist contacted, their answer and the outcome are on a timestamped record. Specialist replies in the demo are scripted. The third scenario (femur fracture, transfer before incision) shows the void path: nothing charged.
