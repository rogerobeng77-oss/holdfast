# BUILD LOG (running)

## 2026-10-02 PayPal sandbox findings (probed live before coding)
- Brief says `/v2/vault/*`; the LIVE spec (developer.paypal.com/api/payment-tokens/v3/schema.json) is `/v3/vault/setup-tokens` and `/v3/vault/payment-tokens`. Using v3.
- Raw card vaulting: `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`. Raw card orders: `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`. Sandbox app has no card processing.
- PayPal-wallet vaulting WORKS: setup token (usage_type MERCHANT, UNSCHEDULED_POSTPAID) -> buyer approves once in browser -> payment token.
- No sandbox buyer creds existed. Created a throwaway sandbox buyer through the guest "Create an Account" flow in the approval page (OTP 111111, fresh Luhn-valid Visa; common test cards are "already added to another account").
- Vaulted token: 9me21520kn045363h (sandbox, Mutual Aid Fund). Order with `payment_source.paypal.vault_id` + `stored_credential` MERCHANT/SUBSEQUENT and intent AUTHORIZE returns COMPLETED with an authorization in ONE call; a follow-up /authorize returns ORDER_ALREADY_AUTHORIZED. So the "authorize" step is implicit; code treats that as success.
- wrote backend (paypal.mjs, ai.mjs, data.mjs, index.mjs) and deploy.sh; vault token id kept in .deploy-state (gitignored). ADMIN_KEY env optional for webhook id registration
- Function URL needs BOTH lambda:InvokeFunctionUrl and lambda:InvokeFunction grants (403 otherwise); aws cli 2.27 has no --invoked-via-function-url
- webhook registered (id in DynamoDB meta#webhook-id); backend deployed & verified live for neck-bleed capture path and transfer void path
- frontend written (restyled to coordinator's ref: scarlet/crimson on near-white, tiles+banner+chart+cards); recorded.json from live runs
- tests written: tests/paypal.sandbox.test.mjs, lambda.local.test.mjs
- backend v2: agents (sizing + reconstruct, Converse tool use), lifecycle (partial capture, reauth sweep, reissue), idempotency, webhook raw+reject store; Bedrock account quota = 10 RPM (L-4A6BFAB1), increase requested 10001 (pending)

## UI review loop (screenshots in screenshots/round1, round2, ...; never deleted)
### Round 1 (1280/360 light and dark, full page) - score 6.5/10
Seen: strong hierarchy in the tile strip and contrast cards, and the dashed-gap treatment in the reconstructed timeline reads well.
Faults found:
- Case bar: chips, funding toggle and run button wrapped into three uneven rows at 1280; at 360 the chips were squeezed to 4-letter-wide columns.
- Chart: an amber line ran along $0 before the authorization existed, which implied a hold that was not there.
- Audit trail and record rows printed money without thousands separators ("$98106.50").
- Reconstruct: the input card left a tall empty gap beside the long timeline; "Logged out of order" was stuck on the wrong entries (it flagged on-time entries, not the late ones).
- Ledger row said PARTIALLY_CAPTURED for a case that was fully captured (stale status).
- Plain-state audit trail dots were too faint.
Fixes applied for round 2: case bar rebuilt as grid, chart line starts at authorization, server-side money formatting, input card collapsed into a details block, late-entry definition rewritten (entry logged after a later-timed one) with a test, ledger label made static, dots heavier.

### Round 2 (screenshots/round2) - score 7.5/10
Fixed from round 1 and re-shot at 360/768/1280/1920, light and dark. New faults seen:
- Tile strip ran full-bleed while the content sat in a centred column, so at 1920 the first tile hung at the far left edge.
- Hero + case bar pushed the four answer tiles below the first screen at 1280x900.
- Chart labels collided on mobile ("honouredsettled"); action buttons wrapped to uneven widths at 360.
- Model rationale showed literal markdown asterisks.
- Nav highlighted the wrong tab (IntersectionObserver band was wrong).
- "Void hold" in its primary state rendered red text on a red gradient.
Fixes: tiles moved inside the wrapper, hero compacted, label-collision rule, full-width buttons on mobile, asterisks stripped server-side, scroll-based tab highlight, a solid danger style with its own on-colour token.

### Round 3 (screenshots/round3) - interactive states, score 8/10
Drove the live UI with Playwright: sizing skeleton, sized, accepted, PayPal's real reauthorization refusal notice, voided, fund-pool open and settled. Found: banner said "No case started" while sizing was running (now shows what the agent is doing), the Start button was enabled in fund mode with no fund (now disabled with a reason).

### Round 4 (screenshots/round4) - deletion pass after the "too much information" note, score 8.5/10
Cut: the hero stat panel (the same figures were stated again in Evidence), the audit-trail card (it duplicated the record below it), the findings card in Reconstruct (the flags already say it), the Stack card, most sub-headings, and the per-card explanatory paragraphs. Moved behind disclosures: price lines and agent tool calls ("How this was decided"), PayPal ids, webhook events, recent cases. Page height at 1280 fell from 11,126 px to 6,903 px. Chart x-axis now starts at authorization instead of presentation so it uses the full width.

### Rounds 5 and 6 (screenshots/round5, round6) - score 8.5/10
Evidence cards became one list (the fifth card was an orphan on its own row at 768). Machine arrows hidden once the row wraps. Smallest text raised to 13 px. Error state (API unreachable) and empty fund state screenshotted (`state-error.png`, `state-empty-fund.png`).
Not scored 9: on a 360 px phone the answer tiles still sit below the hero and the case chooser, so the first screen is not the answer; the record's monospaced event rows are dense; the machine at tablet width wraps to two rows. I would rather report 8.5 than round up.

## Failures found and fixed while testing (full detail in TEST-RESULTS.md)
- Transfer scenario crashed in deterministic sizing (no expected lines). Fixed with an `expected` list.
- Three concurrent `authorize` calls produced three results: needed a conditional-write lock per transition, not only PayPal-Request-Id. Fixed and tested.
- Webhook replay failed verification because the body was re-serialised from DynamoDB (key order changed). Raw body is now stored and replayed byte for byte.
- A search/replace that was meant for one function also rewrote the `/api/config` route. Caught by the deployed recording script, not by the unit tests; fixed and now covered by the e2e test.
- Pool test assumed a fresh fund; the fund's "drawn" figure carried over from an earlier fund. Fund generations now start at zero.
- Bedrock rate limit (10 requests a minute) throttled the agents: retries, stored-plan reuse and a template narrative added, all labelled in the UI.
- Local resolver returned no IPv4 address for the new CloudFront name, so the e2e script resolves it through 8.8.8.8. Public DNS is unaffected.
