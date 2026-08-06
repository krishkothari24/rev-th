# Phase 11 runbook — Retell → OpenAI Realtime migration

Tracks status against the plan in `docs/BUILD_GUIDE.md` §12 and
`docs/IMPLEMENTATION_PLAN.md`'s Phase 11 entry. Those two documents are the
spec; this file is the working checklist — what's done, what's left, and the
concrete steps for the account/deploy work that's mostly console clicks
rather than code.

Decision this runbook assumes (confirmed at kickoff): skip standing up a real
Retell account — it was never given real credentials — and go straight to
OpenAI Realtime as the first live telephony integration. The Retell adapter
stays in the tree as a fixture-tested rollback path.

---

## Status

| Step | What | Status |
|---|---|---|
| 1 | Shared-logic extraction (`safetyOverride.ts`, `sideEffects.ts`, `callStartRecognition.ts`, `getOpenAIRealtimeToolDefinitions`) | ✅ Done — commit `8777346` |
| 2 | New adapter built against fixtures (`src/transports/openai-realtime/`) | ✅ Done — commit `8777346` |
| 3 | Sabotage test ported to the new adapter | ✅ Done — commit `8777346` |
| 4 | Accounts: OpenAI Realtime, webhook secret, Twilio SIP trunk, Railway deploy | ⬜ Not started — `OPENAI_API_KEY` is set locally; `OPENAI_WEBHOOK_SECRET` is not |
| 5 | First real call — book a routine appointment end to end | ⬜ Blocked on step 4 |
| 6 | Re-run the sabotaged-prompt safety test against the live vendor | ⬜ Blocked on step 4 |
| 7 | Latency / barge-in feel pass on real calls | ⬜ Blocked on step 4 |
| 8 | Cost measurement vs. the Retell baseline | ⬜ Blocked on step 4 |
| 9 | Update README / KNOWN_LIMITATIONS / architecture diagram | ⬜ Blocked on step 5+ |

Nothing past step 3 has been done yet. Steps 4–9 below are the plan.

---

## Step 4 — Accounts and deploy

Cheapest/most reversible first, same ordering discipline as the original
Phase 9.

### 4.1 OpenAI Realtime access
- Confirm the OpenAI project has Realtime API access (`OPENAI_API_KEY` — ✅
  already in `.env`).
- In the OpenAI dashboard, configure a webhook endpoint pointed at
  `https://<deployed-host>/webhooks/openai-realtime`, subscribed to
  `realtime.call.incoming`. This is what issues the signing secret.
- Copy the issued secret into `OPENAI_WEBHOOK_SECRET` (`whsec_...` format —
  see `src/transports/openai-realtime/signature.ts`). **Not yet done.**
- Sanity-check `OPENAI_REALTIME_MODEL` / `OPENAI_REALTIME_VOICE` in `.env`
  against what's actually available on the account — these were set from
  this migration's research pass, not confirmed against your live account.

### 4.2 Railway deploy
- Set the env vars from `.env.example`'s Phase 9/11 blocks on the Railway
  service: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`,
  `OPENAI_WEBHOOK_SECRET`, `TWILIO_*`, `PUBLIC_BASE_URL` (the Railway HTTPS
  URL once known), `DASHBOARD_BASIC_AUTH_USER/PASS`.
- Deploy. Verify `GET /health` and the dashboard's `/events` SSE stream
  work against the public URL before touching telephony at all — isolates
  "is the deploy broken" from "is the telephony wiring broken."
- Point the OpenAI webhook endpoint (4.1) at the real deployed URL once it's
  known, not `localhost`.

### 4.3 Twilio number → OpenAI SIP
- Buy/confirm the Twilio number (`TWILIO_PHONE_NUMBER`) — this is the
  recurring-charge step, done last within step 4 on purpose.
- Configure the number's SIP trunk / voice webhook to route to OpenAI's
  Realtime SIP endpoint: `sip:$OPENAI_PROJECT_ID@sip.api.openai.com;transport=tls`
  (project id from the OpenAI dashboard's project settings — this is **not**
  the same value as `OPENAI_API_KEY`). Confirm the exact Twilio-side
  configuration screen (Elastic SIP Trunking vs. a simpler voice-URL field)
  against Twilio's current console before doing this — it's the piece of
  this migration BUILD_GUIDE §12 flagged as most likely to have moved since
  research.
- No Twilio Media Streams / audio-bridging code is needed — SIP trunking
  hands the call directly to OpenAI; our backend never touches raw audio.

**Checkpoint before step 5:** place one test call and confirm the
`realtime.call.incoming` webhook actually lands on `/webhooks/openai-realtime`
with a valid signature (check the logs) before assuming the whole chain
works end to end.

---

## Step 5 — First real call

Call the number. Book a routine appointment, verbally, start to finish.
Confirm:
- The greeting fires (recognized-caller personalization if calling from the
  seeded evaluator number, clean intake otherwise).
- `check_availability` / `book_appointment` round-trip audibly — no long
  dead air during a tool call.
- The booking lands on the deployed dashboard in real time.

If the WS connect 404s right after `accept` returns 200 (the known rough
edge noted in `client.ts`), confirm `connectRealtimeSessionWithRetry`'s
backoff actually absorbs it in the logs — if it doesn't, that retry's
tuning (attempts/delay) is the first thing to adjust, not the wiring.

## Step 6 — Live sabotage re-test

Same proof as `test/transports/openai-realtime/sabotage.test.ts`, but on a
real call: say something matching a gas-leak indicator ("I smell gas near
the furnace") and confirm the agent interrupts itself and delivers the
safety directive, even though nothing about the live model changed. This is
the actual "done when" gate from BUILD_GUIDE §12 — not optional.

Also worth doing once, deliberately: temporarily point
`state.systemPromptOverride` (or a real prompt edit) at a version with the
safety section stripped, same as the fixture sabotage test, and confirm the
override still fires on a real call. Revert immediately after — this is a
one-time proof, not a standing config.

## Step 7 — Latency / barge-in pass

- Time first-token-to-audio latency; compare qualitatively against the
  ~600–800ms Retell target noted in BUILD_GUIDE §10 — don't assume it
  transfers.
- Try interrupting the agent mid-sentence (barge-in) on a real call — confirm
  it actually stops, not just that the safety-override interrupt path works.
- Try a few seconds of dead air and confirm the agent doesn't go silent
  forever or repeat itself oddly.
- Note whatever needs tuning in `docs/KNOWN_LIMITATIONS.md` rather than
  silently fixing it mid-call-testing.

## Step 8 — Cost measurement

Compare actual (or estimated, from OpenAI's published per-minute Realtime
pricing) cost per call-minute against the Retell baseline recorded in
`docs/IMPLEMENTATION_PLAN.md`'s spend ledger. This was the stated point of
the whole migration — write the number down, don't just assert the
migration was worth it.

## Step 9 — Docs

- `README.md`: update the "what's built" section and architecture diagram
  to describe OpenAI Realtime as the live vendor (BUILD_GUIDE §1's diagram
  is already updated; verify the README's own copy matches once the real
  endpoint paths from step 4 are confirmed).
- `docs/KNOWN_LIMITATIONS.md`: fold in anything found during steps 5–7 (the
  `conversation.item.truncate` gap noted in `session.ts`'s docblock is
  already a known one to carry over).
- Note the measured cost delta from step 8 somewhere visible — this is the
  headline result of the migration.

---

## Rollback

If OpenAI Realtime turns out unworkable after step 4, the Retell adapter
(`src/transports/retell/`) is still in the tree, fixture-tested, and only
needs real `RETELL_API_KEY`/`RETELL_AGENT_ID` values plus re-pointing the
Twilio number at Retell instead of OpenAI's SIP endpoint — no code rewrite.
