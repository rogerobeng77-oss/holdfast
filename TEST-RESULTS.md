# TEST-RESULTS

Run on 2026-10-02 against the PayPal **sandbox**, Amazon Bedrock, DynamoDB and the deployed Lambda and CloudFront. No mocks. The output below is pasted from the files in `test-output/`; nothing is summarised in place of output.

## Summary

| Suite | Result |
|---|---|
| PayPal sandbox (`tests/paypal.sandbox.test.mjs`) | 13 of 13 passed |
| Lambda handler, in process, real services (`tests/lambda.local.test.mjs`) | 17 of 18 passed on the full run; the 1 failure was a test assertion that was too narrow, fixed, and that test then passed on re-run (both outputs below) |
| Deployed end to end (`tests/e2e.deployed.mjs`, CloudFront + Function URL) | all checks passed (final run below) |
| Contrast of the real colour tokens (`scripts/contrast.mjs`) | every pair passes in light and dark |
| Click-through of every control on the deployed site | all controls work; see the list below |
| Breakpoints | no horizontal scroll at 360, 640, 768, 1280, 1920; screenshots in `screenshots/round1` to `round6` |

### Failures found along the way (and what they were)

These came up during development and were fixed before the final runs. They are listed because the passing output below hides them.

1. Deterministic sizing crashed for the transfer scenario (it had no expected price lines). Fixed with an explicit `expected` list.
2. Three concurrent `authorize` calls produced three different results. PayPal-Request-Id alone was not enough because the handlers raced before the first call finished. Fixed with a DynamoDB conditional-write lock per transition; the idempotency test now asserts exactly one authorization.
3. A genuine webhook replayed in the tamper test failed verification, because the body had been re-serialised from DynamoDB with its keys in a different order. Fixed by storing and replaying the raw body.
4. A search-and-replace aimed at one function also rewrote the `/api/config` route. The unit tests did not touch that route; the deployed recording script did and failed with `fundMode is not defined`. Fixed, and `/api/config` is now asserted by both suites.
5. The pool test assumed a fresh fund; the fund's "drawn" figure carried over from an earlier fund. Fund generations now start at zero.
6. On the last full run the reconstruction test failed its own assertion: it searched the narrative for the words "not recorded" while the agent had (correctly) put the gap in the separate `notRecorded` list. The assertion now checks that the 02:26 to 03:40 gap is listed as not recorded. Re-run output is below.
7. The Bedrock account allows 10 requests a minute. Under load the narrative step falls back to a labelled template (visible in the e2e output below, `source=template`). That is the behaviour of the shipped system, not a test artefact.

## 1. PayPal sandbox tests

Vault token read back, setup token created, authorization with no buyer present, idempotent replay, partial and final capture, void, reauthorization refused inside the honor period, capture after void refused.

```
    token length 97
✔ oauth: client credentials return a token (1053.095735ms)
    payment token 9me21520kn045363h payer PE7HVYAQSEA96 aid.fund.demo2026@example.com usage MERCHANT
✔ vault: the sponsor's payment token exists and is a PayPal wallet (1197.377261ms)
    setup token 2MK02573601649140 PAYER_ACTION_REQUIRED https://www.sandbox.paypal.com/agreements/approve?approval_session_id=2MK02573601649140
✔ vault: a new setup token is created and waits for the sponsor's one-time browser approval (1087.132297ms)
    order 4H702202BY5502155 COMPLETED authorization 98C58712GV3608257 CREATED expires 2026-10-31T02:14:02Z
✔ authorize: vaulted token authorizes with no buyer present (4517.717637ms)
    both calls -> 8FX753822M8040455
✔ authorize: same PayPal-Request-Id is idempotent (no second hold) (6229.52582ms)
    authorization 1RY39927KN978680U capture 36A82064180822304 COMPLETED authorization now CAPTURED
✔ capture: partial final capture charges less than the hold (5898.698924ms)
    authorization 9E965892XY436503V -> VOIDED
✔ void: releases the hold, sponsor charged nothing (5457.085231ms)
    second void -> 422 PREVIOUSLY_VOIDED
✔ void after void is rejected (a hold cannot be released twice) (4880.622261ms)
    -> 403 PERMISSION_DENIED
✔ bad vault id is refused by PayPal (3127.153512ms)
    capture 1 9AS83575WH5803042 COMPLETED -> PARTIALLY_CAPTURED | capture 2 (final) 23K40191GV393963B COMPLETED -> CAPTURED
✔ lifecycle: two-stage partial capture, then final capture releases the rest (8893.064397ms)
    authorization after partial capture then void -> VOIDED
✔ lifecycle: void after a partial capture releases only what is left (7425.952833ms)
    reauthorize on day 0 -> 422 REAUTHORIZATION_TOO_SOON | A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization.
✔ lifecycle: reauthorization inside the honor period is refused by PayPal (real call) (5232.922593ms)
    capture after void -> 422 AUTHORIZATION_VOIDED
✔ lifecycle: capturing a voided authorization is refused (5535.126243ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 60633.351108
```

## 2. Lambda handler tests (real DynamoDB, Bedrock, PayPal)

Full run:

```
    scenarios neck-bleed,jaw,transfer | price lines 15 | pledge 1000000
✔ health + config; vault token never leaves the server (4735.205174ms)
    sizing source: agent | amount 98106.50 | agent turns 2 tool calls 4 | ms 23671
      tool get_price_record {"query":"all"} -> ok
      tool lookup_procedure_bundle {"specialty":"Vascular surgery","procedure":"carotid exploration and repair"} -> ok
      tool check_sponsor_balance {"sponsor_id":"fund-1"} -> ok
      tool propose_guarantee {"lines":[{"code":"99285","units":1},{"code":"00350","units":1},{"code":"35701","units":1} -> ok
    partial capture 49T297582S6599945 61210.00 | still held 36896.50
    PayPal authorization status: CAPTURED | total charged 77010.00 released 21096.50
    audit source: bedrock | On 2026-10-02 at 02:35:29, patient A.R. presented to St. Aldric Regional Medical Center and the ED physician requested Vascular surgery. At ...
✔ AGENT sizing + full lifecycle: size -> authorize -> accept -> partial capture -> final capture -> audit (51649.110966ms)
    voided 1MP77206FD201105L hold 73082.50 charged $0.00
✔ void exit from authorized/accepted: transfer before incision releases the whole hold (12315.455871ms)
    charged 60750.00 | released 16242.50
✔ void exit from partially captured: remaining hold released, earlier capture stands (12766.815517ms)
case is sized 
    contact before authorize -> 409 case is sized
case is sized 
    document before authorize -> 409 case is sized
case is sized 
    discharge before authorize -> 409 case is sized
case is sized 
    void before authorize -> 409 case is sized
case is captured 
    second final capture -> 409 case is captured
✔ state machine: out-of-order calls are refused with 409 (19316.070707ms)
    two create calls, one case: 33695dbb replayed: true
    three concurrent authorize calls -> 61277802G2328262U statuses 200,200,200
    fourth call replays the existing hold, no new money movement
✔ IDEMPOTENCY: same idempotency key returns the same case; concurrent authorize makes one hold (7806.98816ms)
    simulated day 4 -> refused REAUTHORIZATION_TOO_SOON | A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization.
    simulated day 1 -> none (inside honor period)
    capture still works after the refused reauth
✔ REAUTHORIZATION: sweep after the honor period asks PayPal; the real refusal is recorded and the hold survives (14964.48183ms)
    old 88268303T6655905E -> re-issued 7D429898RM654660N | event: Authorization 88268303T6655905E was VOIDED before capture. Re-issued $76,992.50 from the vaulted token as 7D429898RM6546
    final capture succeeded on the new hold: 66950.00
✔ EXPIRED/LOST AUTHORIZATION: a hold PayPal no longer honours is re-issued from the vault before capture (20064.800645ms)
    replaying delivered event WH-5H817763YH7503130-9HD74771VA579593J PAYMENT.AUTHORIZATION.CREATED
    tampered -> {"stored":false,"verifyStatus":"FAILURE"}
    forged, no valid headers -> {"stored":false,"verifyStatus":"verify error: PayPal POST /v1/notifications/verify-webhook-signature 400 Required field cannot be blank: Invalid d"}
    genuine replay -> {"stored":true,"duplicate":true,"verifyStatus":"SUCCESS"}
    rejected-delivery counter rose by 2
    gap: 02:26 to 03:40 74 min | repeated contacts: 02:11, 02:14, 02:26 | unplaceable: E8
    grounded -> {"ok":true,"badTimes":[],"badDurations":[]} | invented -> {"ok":false,"badTimes":["03:05"],"badDurations":["45"]}
✔ WEBHOOK SIGNATURE: a tampered payload is rejected, the genuine one is accepted, replays store once (6546.722511ms)
✔ RECORD RECONSTRUCTION, deterministic part: order, gap, repeats and unplaceable entries are found by code (1.632099ms)
✔ RECORD RECONSTRUCTION, grounding check rejects an invented time and an invented duration (0.480578ms)
    source: agent | turns 3 tool calls 9 | findings 6 | ms 50906
    narrative: The patient arrived by ambulance at 02:02 with expanding neck swelling, voice changing, and airway narrowing noted. A vascular surgery consult was requested at 02:09. A page was sent to on-call vascular surgeon Dr. Okafor at 02:11, a call was placed at 02:14 with no answer, and a page was re-sent at 02:26. Dr. Okafor returned the call at 03:40, and at 03:45 the ED physician documented that Dr. Okafor would not come in and a backup surgeon was being arranged. The patient went to the OR with Dr. Reyes (backup vascular) at 03:52.
    not recorded: ["What occurred between 02:26 and 03:40 during the 74-minute gap","When or how Dr. Reyes was contacted","The content of the conversation between Dr. Okafor and the ED physician at 03:40","Who arranged for the backup surgeon","Clinical assessments or interventions between 02:02 and 03:52"]
unknown scenario 
✖ RECORD RECONSTRUCTION, AGENT: flags the gap instead of filling it (51392.37891ms)
case not found 
at most 40 entries 
✔ bad input: unknown scenario 400, unknown case 404, unknown route 404, oversize reconstruct 400 (361.43826ms)
No open fund to close. 
    fund opened: authorization 37C955816U278510J $250000.00 remaining 250000.00
    opening again is idempotent: same authorization 37C955816U278510J
    two guarantees reserved against ONE authorization 37C955816U278510J | reserved 165554.00 | remaining 84446.00
    drawn 143960.00 | PayPal authorization status PARTIALLY_CAPTURED | reserved 0.00 | remaining on the fund 106040.00
✔ POOL: one $250,000 authorization funds several guarantees; each draws with partial captures (40375.3422ms)
    case voided; fund authorization 37C955816U278510J still live
✔ POOL: void of a pool case releases only a reservation; the fund survives (8324.934376ms)
The fund has $17,478.50 left and this guarantee needs $88,561.50. Open a larger fund. 
    reservations accepted before refusal: 1 | refusal: 409 The fund has $17,478.50 left and this guarantee needs $88,561.50. Open a larger fund.
✔ POOL: a guarantee larger than the free fund is refused with the amount short (11812.518309ms)
    fund sweep, simulated day 4 -> refused REAUTHORIZATION_TOO_SOON
✔ POOL: sweep after day 4 asks PayPal to reauthorize the fund; the real refusal is recorded (3260.578587ms)
Close or settle the open guarantees first: $88,561.50 is still reserved. 
    close with open reservations -> 409 Close or settle the open guarantees first: $88,561.50 is still reserved.
    fund closed; authorization 37C955816U278510J VOIDED
✔ POOL: closing the fund is blocked while guarantees are open, then voids the authorization (8690.46331ms)
ℹ tests 18
ℹ suites 0
ℹ pass 17
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 274557.677641

✖ failing tests:

test at tests/lambda.local.test.mjs:129:1
✖ RECORD RECONSTRUCTION, AGENT: flags the gap instead of filling it (51392.37891ms)
  AssertionError [ERR_ASSERTION]: says the gap is unrecorded
      at TestContext.<anonymous> (file:///home/rogerkorantenng/dev/Hackathons/paypal/projects/guarantee/tests/lambda.local.test.mjs:138:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1125:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:787:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

Re-run of the one test whose assertion was corrected:

```
    source: agent | turns 3 tool calls 9 | findings 6 | ms 17509
    narrative: The patient arrived by ambulance at 02:02 with expanding neck swelling, voice changes, and airway narrowing. A vascular surgery consult was requested at 02:09. Staff paged the on-call vascular surgeon Dr. Okafor at 02:11, called with no answer at 02:14, and re-paged at 02:26. Dr. Okafor returned the call at 03:40 and spoke with the ED physician. At 03:45 the ED physician documented that Dr. Okafor would not come in and a backup surgeon was being arranged. The patient went to the OR with Dr. Reyes at 03:52.
    not recorded: ["What occurred between 02:26 and 03:40","When or how Dr. Reyes was contacted","Who arranged for the backup surgeon","What time Dr. Reyes agreed to come in"]
✔ RECORD RECONSTRUCTION, AGENT: flags the gap instead of filling it (19185.881036ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19347.463559
```

## 3. Deployed end to end

CloudFront site, Function URL, a full live case through the deployed API with the Bedrock sizing agent, a void case, the reconstruction agent and the webhook store.

```
== CloudFront https://d2xm2cdvyum4cx.cloudfront.net
PASS  CloudFront serves the page  HTTP 200 text/html 1065 bytes
PASS  asset assets/index-BOmlYMC0.js  HTTP 200 text/javascript 235064 bytes
PASS  asset assets/index-E9noogTH.css  HTTP 200 text/css 23542 bytes
PASS  bundle is wired to the deployed Function URL
PASS  served through CloudFront  x-cache: RefreshHit from cloudfront

== Lambda Function URL https://hmse6gxn43ybbd5lwqd335g7tu0bsuah.lambda-url.us-east-1.on.aws
PASS  health  1683 ms {"ok":true,"time":"2026-10-02T02:45:02.544Z","paypal":"https://api-m.sandbox.paypal.com"}
PASS  CORS allows the CloudFront origin  access-control-allow-origin: https://d2xm2cdvyum4cx.cloudfront.net
PASS  config (3 scenarios, no vault token leaked)

== Live flow through the deployed API (real Bedrock agent, real PayPal sandbox)
PASS  agent sized the guarantee  source=agent amount=98106.50 toolCalls=4 turns=2 14675 ms
PASS  authorize -> authorized  2918 ms authId=0FX69683XE2407523
PASS  contact -> accepted  282 ms 
PASS  document -> partially_captured  1715 ms capture 0C49337422846531K $61210.00
PASS  discharge -> captured  2634 ms total charged $77010.00, released $21096.50
PASS  audit narrative drafted  source=bedrock 7391 ms
   narrative: On 2026-10-02 at 02:45:04, patient A.R. presented to St. Aldric Regional Medical Center and the ED physician requested Vascular surgery. At 02:45:22, a financial guarantee of $98,106.50 was authorized on Harbor Mutual Aid Fund's vaulted instrument through PayPal authorization 0FX69683XE2407523, valid for three days to 2026-10-05 and through 2026-10-31, and the hospital was notified of the honored commitment. At 02:45:22, Dr. M. Okafor, the on-call vascular surgeon, was contacted and provided with the guarantee information, and responded that he accepted and would be in the OR within 25 minutes. Neck exploration with direct carotid repair was completed and the patient was transferred to ICU, with procedure charges of $61,210.00 partially captured at 02:45:24. Following discharge, inpatient stay charges of $15,800.00 were captured at 02:45:26, bringing total charges to $77,010.00, with the unused $21,096.50 released to the sponsor.
   whole flow: 30.2 s
PASS  case persisted in DynamoDB and readable again

== Void path
PASS  transfer case voided, sponsor charged nothing  authorization 71P81798UY8882402 hold 70989.50 released 70989.50

== Record reconstruction agent
PASS  gap flagged, not filled  source=agent gap=02:26-03:40 (74 min) findings=6
   narrative: The patient arrived by ambulance at 02:02 with expanding neck swelling, voice changes, and airway narrowing. At 02:09 a vascular surgery consult was requested. Staff paged the on-call vascular surgeon Dr. Okafor at 02:11, called at 02:14 with no answer, and re-paged at 02:26. Dr. Okafor returned the call at 03:40. At 03:45 the ED physician documented that Dr. Okafor would not come in and a backup surgeon was being arranged. The patient went to the OR with Dr. Reyes at 03:52.
   not recorded: ["What occurred between 02:26 and 03:40","Who arranged for the backup surgeon","When Dr. Reyes was contacted","The specific reason Dr. Okafor declined to come in","What clinical interventions occurred during the wait"]

== Webhooks
PASS  webhook store readable  12 verified events, 0 rejected
   PAYMENT.AUTHORIZATION.VOIDED VOIDED 70989.50
   PAYMENT.AUTHORIZATION.CREATED VOIDED 70989.50
   PAYMENT.CAPTURE.COMPLETED COMPLETED 15800.00
   PAYMENT.CAPTURE.COMPLETED COMPLETED 61210.00

ALL PASS
```

## 4. Contrast (real hex values from `frontend/src/styles.css`)

```
PASS  light 16.84:1 (need 4.5)  Body text on page  [#1b1517 on #f8f7f7]
PASS  light 18.01:1 (need 4.5)  Body text on card  [#1b1517 on #ffffff]
PASS  light  9.74:1 (need 4.5)  Secondary text on card  [#4d4144 on #ffffff]
PASS  light  6.20:1 (need 4.5)  Tertiary/caption text on card  [#6a5e61 on #ffffff]
PASS  light  5.80:1 (need 4.5)  Tertiary text on page  [#6a5e61 on #f8f7f7]
PASS  light  5.43:1 (need 4.5)  Tertiary text on sunken  [#6a5e61 on #f3efef]
PASS  light  7.54:1 (need 4.5)  Link/accent text on card  [#a8141f on #ffffff]
PASS  light  7.05:1 (need 4.5)  Accent text on page  [#a8141f on #f8f7f7]
PASS  light  5.72:1 (need 3)  Headline accent (large) on card  [#c81e28 on #ffffff]
PASS  light  6.54:1 (need 4.5)  Pending text on pending bg  [#86470a on #fdf3e1]
PASS  light  6.04:1 (need 4.5)  Settled text on settled bg  [#1c6746 on #e8f4ed]
PASS  light  6.08:1 (need 4.5)  Alarm text on alarm bg  [#b3121c on #fdeceb]
PASS  light  7.19:1 (need 4.5)  Pending value on card  [#86470a on #ffffff]
PASS  light  6.82:1 (need 4.5)  Settled value on card  [#1c6746 on #ffffff]
PASS  light  5.20:1 (need 4.5)  Nav text on gradient start  [#ffffff on #d4202a]
PASS  light  9.22:1 (need 4.5)  Nav text on gradient end  [#ffffff on #8f102c]
PASS  light  5.20:1 (need 4.5)  Primary button text on start  [#ffffff on #d4202a]
PASS  light  6.95:1 (need 4.5)  Solid danger button text  [#ffffff on #b3121c]
PASS  light  6.54:1 (need 4.5)  Badge pending on its bg  [#86470a on #fdf3e1]
PASS  light 16.39:1 (need 4.5)  Paper ink on paper  [#231d18 on #fffdf8]
PASS  light  7.25:1 (need 4.5)  Paper secondary on paper  [#5f5448 on #fffdf8]
PASS  light 15.39:1 (need 4.5)  Selected chip: ink on accent-soft  [#1b1517 on #fbe9ea]
PASS  light  5.67:1 (need 3)  Focus ring on page (UI part)  [#1459d9 on #f8f7f7]
PASS  light  6.07:1 (need 3)  Focus ring on card (UI part)  [#1459d9 on #ffffff]
PASS  dark  16.44:1 (need 4.5)  Body text on page  [#f4eeef on #151012]
PASS  dark  15.37:1 (need 4.5)  Body text on card  [#f4eeef on #1e1719]
PASS  dark   9.92:1 (need 4.5)  Secondary text on card  [#cdbfc2 on #1e1719]
PASS  dark   6.93:1 (need 4.5)  Tertiary/caption text on card  [#ad9fa2 on #1e1719]
PASS  dark   7.41:1 (need 4.5)  Tertiary text on page  [#ad9fa2 on #151012]
PASS  dark   6.46:1 (need 4.5)  Tertiary text on sunken  [#ad9fa2 on #261d20]
PASS  dark   8.06:1 (need 4.5)  Link/accent text on card  [#ff8f93 on #1e1719]
PASS  dark   8.61:1 (need 4.5)  Accent text on page  [#ff8f93 on #151012]
PASS  dark   6.69:1 (need 3)  Headline accent (large) on card  [#ff7378 on #1e1719]
PASS  dark   8.58:1 (need 4.5)  Pending text on pending bg  [#f3b765 on #2f2314]
PASS  dark   9.00:1 (need 4.5)  Settled text on settled bg  [#7fd8aa on #14291f]
PASS  dark   7.14:1 (need 4.5)  Alarm text on alarm bg  [#ff8a8e on #321a1c]
PASS  dark   9.88:1 (need 4.5)  Pending value on card  [#f3b765 on #1e1719]
PASS  dark  10.32:1 (need 4.5)  Settled value on card  [#7fd8aa on #1e1719]
PASS  dark   6.99:1 (need 4.5)  Nav text on gradient start  [#ffffff on #b01825]
PASS  dark  12.85:1 (need 4.5)  Nav text on gradient end  [#ffffff on #650d22]
PASS  dark   6.99:1 (need 4.5)  Primary button text on start  [#ffffff on #b01825]
PASS  dark   7.96:1 (need 4.5)  Solid danger button text  [#1b1517 on #ff8a8e]
PASS  dark   8.58:1 (need 4.5)  Badge pending on its bg  [#f3b765 on #2f2314]
PASS  dark  16.39:1 (need 4.5)  Paper ink on paper  [#231d18 on #fffdf8]
PASS  dark   7.25:1 (need 4.5)  Paper secondary on paper  [#5f5448 on #fffdf8]
PASS  dark  13.39:1 (need 4.5)  Selected chip: ink on accent-soft  [#f4eeef on #3a1c21]
PASS  dark   9.06:1 (need 3)  Focus ring on page (UI part)  [#8db4ff on #151012]
PASS  dark   8.48:1 (need 3)  Focus ring on card (UI part)  [#8db4ff on #1e1719]

ALL PASS
```

## 5. Click-through of every control

```
Click-through of every interactive control on the DEPLOYED site (https://d2xm2cdvyum4cx.cloudfront.net), driven with Playwright, 2026-10-02.
Run 1 (sections, toggles, disclosures, reconstruct):
PASS  theme toggle cycles light -> dark -> auto
PASS  scenario tabs: Vascular, Oral, Orthopaedic each become selected
PASS  funding toggle: Fund pool and Per-case hold each become pressed
PASS  disclosures open: How this was decided, PayPal calls for this case, Verified webhook events, Recent cases, How the agent decided
PASS  Check for new events returns verified rows
PASS  Recent cases > Open case loads a stored case and scrolls to it
PASS  invalid JSON in the log shows an inline fix instruction ("This is not valid JSON ... Fix the syntax or choose Load sample log.")
PASS  Load sample log restores 9 entries and clears the error
PASS  Reconstruct record (live agent) shows "Nothing logged for 74 minutes"
PASS  page errors: none
Run 2 (navigation, after allowing the smooth scroll to finish):
PASS  skip link is the first tab stop
PASS  nav Contrast / Record / Reconstruct / PayPal / Evidence / How it works / Case each land on their section and are marked current
PASS  hero link "Two hospitals paid ..." lands on Evidence
Run 3 (live actions on the deployed site):
PASS  Start case and size guarantee -> "Guarantee sized"
PASS  Authorize guarantee -> "Commitment honoured"
PASS  Contact on-call surgeon -> "has accepted"
PASS  Document procedure, capture first part -> "Procedure captured"
PASS  Document discharge, final capture -> "Settled"
PASS  Authorize $250,000 fund -> fund opens
PASS  Skip 4 days and reauthorize fund -> shows PayPal's REAUTHORIZATION_TOO_SOON answer
PASS  Fund-mode Authorize guarantee -> case events show "$84,007.50 reserved against the sponsor's fund ... in 17 ms" (read back from the API)
PASS  Void hold releases the reservation
PASS  Close fund and release remainder -> fund closed (API: status closed)
PASS  Vault a sponsor's PayPal account (sandbox) -> browser lands on sandbox.paypal.com (https://www.sandbox.paypal.com/pay?approval_session_id=...; it went to /pay rather than /agreements/approve because the browser already held the sandbox buyer's session)
Earlier on localhost, same build: Run all steps (per-case and fund mode), Skip 4 days and reauthorize on a hold, Void hold, Start a new case, the API-unreachable error banner, and the Start button being disabled in fund mode until the fund is authorized.
Not clicked: "Draft narrative now" / "Redraft with the model" (only rendered when a case has no model-drafted narrative; exercised through the API in the e2e test).
```

Measured in the browser on the deployed site at 360, 640, 768, 1280 and 1920 px wide (identical at every width): 48 visible interactive controls, the smallest 61 by 36 px, none under 28 by 28; smallest text 13 px including chart labels; `scrollWidth - clientWidth` 0 (no horizontal scroll). Keyboard: the skip link is the first tab stop and focus draws a solid 3 px ring.

## 6. Responsive check

Full-page screenshots at 360, 768, 1280 and 1920 px in light and dark: `screenshots/round1` (first pass, scored 6.5) through `screenshots/round6` (scored 8.5), plus `screenshots/final-deployed` taken from the CloudFront URL. `scrollWidth - clientWidth` was 0 at every width. 640 px was added as a stand-in for 200% zoom of a 1280 px window.

## Open item: a successful reauthorization has not been observed

PayPal's sandbox enforces its real clock: a reauthorization on day 0 returns `REAUTHORIZATION_TOO_SOON` (shown above, real call). To get a genuine success without faking anything, one case was left open and authorized:

```
2e6d2402 accepted 4SK83180HH784724A 76992.50 2026-10-02T02:40:37Z honorUntil 2026-10-05T02:40:37.000Z
```

(case id, state, PayPal authorization id, amount, authorized-at, honor period end). Its honor period ends 2026-10-05 and PayPal allows reauthorization from day 4. The daily EventBridge sweep (12:00 UTC) will call `reauthorize` on it; on 5 October PayPal may still refuse, and the sweep records the refusal and retries on 6 October. After that, `GET /api/cases/2e6d2402` shows a `reauthorized` or `reauth_refused` event with PayPal's answer. Until that happens the success path of reauthorization is untested. Also open: the PayPal text says reauthorization is allowed multiple times while the sandbox message says "only once".
