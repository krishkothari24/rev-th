# Summit Air Voice + SMS Agent — Implementation Plan

## Context

The repo is docs-only today: `CLAUDE.md`, `docs/BUILD_GUIDE.md`, `docs/PRD.md`,
`docs/TEST_SCENARIOS.md`, and a starting system prompt at
`docs/agent_system_prompt.md`. Nothing is scaffolded.

This is a take-home for Revin. What is graded, in order: (1) does a real phone
call work, (2) does it survive an adversarial caller, (3) does the conversation
feel human, (4) judgment about what to build vs. skip. **The prompts and the
conversation quality are the artifact.** Infrastructure that doesn't show up on
the call is worth close to zero.

Two decisions shape this plan:

**We own the conversation loop.** Retell runs as a Custom LLM over a WebSocket —
it handles STT, TTS, and turn-taking; our backend runs the Claude loop. Confirmed
protocol: Retell connects to `/llm-websocket/{call_id}`, sends `interaction_type`
events (`call_details`, `update_only`, `response_required`, `reminder_required`,
`ping_pong`), and expects streamed `response` frames keyed by `response_id` with
`content` / `content_complete`. It also supports `agent_interrupt` frames for
cutting in mid-turn, and `tool_call_invocation` / `tool_call_result` frames so
tool activity lands in the transcript. This matters because it means **one loop
serves voice, SMS, the simulator, and the eval suite** — the evals exercise the
exact code that answers the phone, prompts stay runtime-loaded source files, and
the deterministic safety override can hard-inject into the message array (or fire
`agent_interrupt`) rather than politely asking the model to comply.

**No money is spent until the build is done.** Everything through Phase 8 runs
locally against Homebrew Postgres 14 with no telephony account, no hosting, and
no paid signup. Phase 9 is the only phase that creates accounts.

Detected toolchain: Node 23.11, npm 11.3, Postgres 14.18 (Homebrew), no Docker.
Local Postgres, no container needed.

---

## Spend ledger — what costs what, and when it starts

| Item | Cost | First spent |
|---|---|---|
| Postgres (local) | $0 | never |
| Deterministic work: schema, seed, tools, triage keyword layer, dashboard, transport adapters | $0 | never |
| Anthropic tokens (sim + evals) | cents per run; a few dollars for the whole build | Phase 4, **opt-in flag only** |
| Railway (already have account) | hobby tier | Phase 9 |
| Retell | per-minute, has trial credit | Phase 9 |
| Twilio number + minutes | ~$1.15/mo + ~$0.014/min | Phase 9, **last** |

Phases 0–3 are 100% deterministic — zero tokens, and the test suite stays at $0
permanently because it runs against a scripted model provider. Phase 4 is where
a real model first becomes *available*, behind `--live`; the default path is
still free. Worth being straight about one thing: the prompt is the graded
artifact, so real model runs aren't overhead, they're the core work — and
Anthropic tokens are by far the cheapest line item here. The expensive,
recurring items (Retell minutes, Twilio number) genuinely don't start until
Phase 9.

---

## Layout

```
package.json                    # npm workspaces
prompts/                        # source files, loaded at runtime, hot-reload in dev
  agent_system_prompt.md        # moved from docs/ at Phase 4
  sms_agent_prompt.md
  summarizer_prompt.md
evals/
  scenarios/*.yaml
  runner.ts
packages/
  server/
    src/
      db/          schema.ts, client.ts, seed.ts
      tools/       customerLookup, checkAvailability, bookAppointment,
                   flagEmergency, transferToHuman, registry.ts
      triage/      classify.ts, indicators.ts, skills.ts, hazardCheck.ts
      agent/       loop.ts, prompts.ts, context.ts,
                   providers/{anthropic.ts, scripted.ts}
      transports/  retell/{websocket.ts, webhook.ts, signature.ts}
                   twilio/{sms.ts, signature.ts}
                   sim/repl.ts
      events/      bus.ts, sse.ts
      sms/         sender.ts, dnc.ts
    test/
  dashboard/       # Vite + React + Tailwind
```

---

## Phase 0 — Scaffold  *(no spend)*

npm workspaces monorepo, TypeScript strict, Fastify, Drizzle, Vitest, ESLint +
Prettier. `.env.example` with placeholders committed; `.env` gitignored.
`npm run lint` / `npm run typecheck` wired and passing on an empty tree.
Create local db `summit_air_dev`.

**Done when:** `npm run lint && npm run typecheck` pass; server boots on `/health`.

## Phase 1 — Data model and seed  *(no spend)*

Drizzle schema exactly per BUILD_GUIDE §2: `customers`, `equipment`,
`technicians`, `appointments`, `emergency_flags`, `conversations`,
`tool_invocations`. Migrations + `npm run db:seed`.

Seed is demo-critical, not filler — invest here:
- ~25 synthetic customers across three counties, mixed membership tiers, several
  with 2–3 equipment records and past service dates
- 8–10 technicians with **deliberately constraining** skills — one county gets
  exactly one gas-certified tech, so skill matching visibly bites instead of
  trivially succeeding
- Partially-filled board for today + several days out, so availability lookups
  return scarce realistic options rather than an empty calendar
- All synthetic, `555` exchange numbers. Reserve one customer's phone for the
  evaluator to demo returning-caller recognition on demand.

**Done when:** seed runs idempotently; a board query returns a populated,
non-trivial schedule.

## Phase 2 — Tool layer, offline  *(no spend)*

The five tools as pure service functions, wrapped by `POST /tools/*` endpoints.
Each: validate with Zod → check idempotency → execute → return a **terse,
speakable** result → emit an event on the bus.

- `customer_lookup(phone)` — compact summary string or `{found:false}`. Never
  returns payment data.
- `check_availability(county, urgency, required_skills[])` — 2–3 concrete slots;
  never an empty array without a speakable `note`.
- `book_appointment({...})` — assigns a qualified tech **server-side**, writes the
  row, emits `appointment.created`, queues confirmation SMS.
- `flag_emergency({...})` — callable with partial info (phone + address + reason
  only), because in a real gas-leak call you may never get the rest.
- `transfer_to_human({reason})`

Zod is the security boundary, not decoration: `urgency` is an enum the model
cannot escape; `technician_id`, pricing, and membership are server-owned and not
model-writable. Idempotency key is `sha256(call_id + tool_name +
canonical_json(args))` — Retell retries, and without this you double-book.

Vitest unit tests: happy path, bad input rejection, duplicate-call idempotency,
attempted writes to server-owned fields.

**Done when:** tests pass and each endpoint behaves correctly under curl for
valid, invalid, and repeated calls.

## Phase 3 — Triage module, deterministic layer  *(no spend)*

`src/triage/classify.ts` per BUILD_GUIDE §5:

```ts
classifyUrgency({ transcript, statedIssue, vulnerablePersonPresent, season,
                  propertyType }): { urgency, requiredSkills, safetyOverride }
```

Gas-leak indicators run over the running transcript every turn. On match, the
backend forces the emergency path regardless of what the model concluded.
Skill derivation is deterministic too: gas furnace / gas smell → `gas`;
commercial → `commercial`; refrigerant work → `refrigerant_epa`.

The Haiku second-opinion hazard check (which disambiguates "I smell gas" from
"the gas company called") is written now behind an injectable provider interface
and **defaults off**, so this phase stays free. Either signal firing counts as a
hazard once it's enabled in Phase 4.

**Done when:** table-driven tests cover the indicator set including the false-
positive cases, and `safetyOverride` fires on every true positive with the
model entirely out of the loop.

## Phase 4 — Agent core + simulator  *(first optional token spend)*

The channel-agnostic loop. `prompts/agent_system_prompt.md` moves out of `docs/`
here and becomes a real source file loaded at boot, hot-reloadable in dev.

- Message array construction. Caller speech is **only ever** user-role turns —
  never concatenated into the system prompt (§8.3).
- Tool dispatch into the Phase 2 layer.
- Safety-override injection: triage runs on every turn; on `safetyOverride`, the
  loop injects a directive and fires `flag_emergency` itself.
- Server-side caps: one emergency flag per conversation, bounded bookings per
  conversation, rate limit per phone number.
- Two providers behind one interface: `ScriptedProvider` (deterministic, drives
  all CI, $0) and `AnthropicProvider` (Claude Sonnet for voice turns, Haiku for
  SMS/hazard-check/summarization).
- `npm run sim` — text REPL over the identical loop. Defaults to scripted;
  `npm run sim -- --live` is the opt-in that first touches the API.

**Done when:** a full routine booking completes in the simulator, and a gas-smell
turn triggers the safety path with the prompt deliberately sabotaged to ignore
it. That sabotage test is the proof the control is real, not prompt-deep.

## Phase 5 — Eval harness  *(cents per run, on demand)*

`evals/scenarios/*.yaml` in the BUILD_GUIDE §10 format — scripted caller turns
plus assertions (`tool_called`, `tool_arg`, `response_contains_any`,
`tool_not_called`). Runner drives the same loop.

Minimum suite mirrors `docs/TEST_SCENARIOS.md`: gas smell cold-open; gas smell
mid-call; no-heat with elderly occupant; no-AC with medical condition; routine
maintenance happy path; commercial rooftop unit; caller volunteers everything at
once; caller changes their mind mid-booking; caller demands a price; caller
requests a human; prompt-injection attempt; unknown vs. known caller.

Run before every prompt commit — prompt regressions are silent otherwise; you
fix interruption handling and quietly break the safety branch.

**Done when:** `npm run eval` runs the suite green and a deliberately broken
prompt line turns a scenario red.

## Phase 6 — Recognition, membership, skill matching  *(no new spend)*

- `customer_lookup` wired into call start; inject a short **pre-rendered summary
  string** as a dynamic variable, not the raw customer record — big JSON blobs in
  a voice prompt degrade conversation quality.
- Prompt extension for returning callers, including the §8.2 hard rule: an ANI
  match permits greeting by name and general equipment context, but full service
  address, account details, and payment history require the caller to state them
  first. "Hi Maria — calling about the house on Oak Ridge?" not a recital of the
  full address. If recognition conflicts with what they say, fall back to full
  intake rather than arguing.
- Membership: reference an existing plan naturally; mention plans to non-members
  only on routine calls, once, softly. The upsell block on urgent/safety calls is
  **enforced server-side**, not left to the model.
- Technician matching by derived skills, wired into `book_appointment`.

**Done when:** sim recognizes a seeded number, gives clean intake for an unknown
one, refuses address readback unprompted, and the upsell is suppressed on an
urgent call even when the model tries.

## Phase 7 — Dashboard  *(no spend)*

React + Vite + Tailwind, single page, no router, SSE from `/events` (one-way
data — no WebSockets). Reconnect with backoff; a dropped stream mid-demo looks
bad. Live call banner, dispatch board (techs as columns, timeline rows, capacity),
emergency rail with acknowledge, activity feed of tool invocations.

Should read as an operations tool — dense, legible at a glance, calm until
something is urgent. Read `/mnt/skills/public/frontend-design/SKILL.md` first.

Driven by simulator events locally, so it fully demos with no telephony at all.

**Done when:** running a sim booking makes the card land on the board live, and a
gas-smell sim lights the emergency rail.

## Phase 8 — Transport adapters, built against fixtures  *(no spend)*

This is the phase that makes Phase 9 config-only instead of a rewrite.

- **Retell Custom LLM WebSocket** at `/llm-websocket/:call_id`: handle
  `call_details` (source of `retell_llm_dynamic_variables`), `update_only`,
  `response_required`, `reminder_required`, `ping_pong`. Stream `response` frames
  with matching `response_id` and `content_complete`. Emit `tool_call_invocation`
  / `tool_call_result` so tool activity shows in the Retell transcript. Wire the
  safety override to `agent_interrupt` so it can cut in mid-utterance.
- **Retell HTTP webhook** at `/webhooks/retell` — separate from the socket;
  carries `call_started` / `call_ended` / `call_analyzed`. Verify
  `x-retell-signature` (`v=<ts>,d=<digest>`, HMAC-SHA256 over `raw_body + ts`,
  5-minute window, constant-time compare). **Register a raw-body content-type
  parser** — Fastify's JSON parser eats the body otherwise and signature
  verification silently fails forever.
- **Twilio SMS** inbound webhook with `X-Twilio-Signature` validation; STOP /
  UNSUBSCRIBE / CANCEL / END / QUIT sets `customers.dnc` and every outbound send
  checks it first. Legal compliance, not a nice-to-have.
- Outbound SMS behind a `SmsSender` interface with a console implementation, so
  the whole SMS flow is testable with no Twilio account.
- SMS conversation state persists across hours — a texter who goes quiet and
  returns tomorrow resumes mid-thread.
- Rate limit `/tools/*` and both webhook routes; CORS restricted to the dashboard
  origin.

Tested against synthetic payload fixtures matching the documented shapes,
including a signed-request fixture and a tampered one that must 401.

**Done when:** a fake Retell client script drives a full booking over the local
WebSocket, and the SMS flow books end to end against the console sender.

## Phase 9 — Accounts, deploy, first real call  *(the money phase)*

Strict order, cheapest and most reversible first:

1. Anthropic production key into env (account already exists).
2. Railway (account already exists): Postgres, backend, dashboard. Deploy and
   get the public HTTPS + WSS URL. Verify `/health` and the SSE stream remotely.
3. Retell: create account, agent configured as **Custom LLM** pointed at the
   deployed `wss://` URL, webhook pointed at `/webhooks/retell`, API key set as
   the HMAC secret. Verify signature verification against a real webhook.
4. Twilio **last** — it's the recurring charge. Buy the number, attach to Retell.
5. Place the first call.

Dashboard ships behind basic auth or a hard-to-guess path; the write-up states
explicitly that real deployment needs proper auth. That's the difference between
an oversight and a scoped decision.

**Done when:** a call to the number books a routine appointment end to end and
the card appears live on the deployed dashboard.

## Phase 10 — Live hardening + interview artifacts

Run all 17 scenarios from `docs/TEST_SCENARIOS.md` over real calls. The ones that
only surface on a real phone: interruption/barge-in, 5+ seconds of dead air,
garbled address readback, latency under load. Tune first-token latency
(streaming, prompt size, tool-call round trips) against Retell's ~600–800ms
target. Feed each failure back as a *targeted* prompt fix, not a rewrite.

Deliverables built alongside: README with architecture diagram and what's mocked
and why; scope-decisions doc (judgment about what *not* to build is explicitly on
the rubric); prompt changelog tying each line to the eval scenario that forced it;
known-limitations list. Volunteering your own three failure modes lands better
than getting caught by one.

Keep prompt hot-reload working — they will ask for a live prompt change during
the call, and you need to know exactly where each behavior lives.

---

## Risks

**Deferring all telephony to Phase 9 concentrates the integration risk.** Retell
protocol quirks, real latency, barge-in behavior, and signature verification
against genuine payloads all land at once, at the end. This is the real cost of
the no-upfront-spend constraint and it's worth naming rather than discovering.
Mitigations: Phase 8 builds against the documented protocol with fixtures and a
fake Retell client; Retell trial credit makes the first calls effectively free;
and because the tool layer is plain HTTP either way, falling back to Retell's
built-in LLM + custom functions stays a ~30-minute escape hatch if our
websocket latency turns out unacceptable.

**Latency is now ours to own.** Custom LLM means our loop sits in the critical
path. Streaming from the first token is mandatory, the system prompt has to stay
tight, and tool round-trips need to be fast — a slow `check_availability` is
audible dead air on the call.

**Prompt regressions are silent.** Mitigated by Phase 5 landing before the prompt
work gets heavy, and by the rule that no prompt edit commits without a green
`npm run eval`.

---

## Verification summary

Every phase ends with: `npm run typecheck`, `npm run lint`, its own stated
verification, then a commit as a checkpoint. Phases 0–8 verify entirely locally
with no account and no spend. The two tests that matter most:

- **Sabotaged-prompt safety test** (Phase 4) — strip the gas-leak section out of
  the system prompt; the emergency path must still fire. This is the proof that
  safety is a code control, and the single most defensible thing to lead with
  when they dig into the prompts.
- **First real call** (Phase 9) — book a routine appointment end to end and watch
  it land on the dashboard.

---

## References

- [Retell LLM WebSocket protocol](https://docs.retellai.com/api-references/llm-websocket)
- [Retell custom LLM Node demo](https://github.com/RetellAI/retell-custom-llm-node-demo)
- `docs/BUILD_GUIDE.md` — full spec, data model, security requirements
- `docs/PRD.md` — product scope and explicit exclusions
- `docs/TEST_SCENARIOS.md` — 17 pre-flight scenarios
