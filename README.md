# Summit Air — AI Voice + SMS Agent

An inbound voice and SMS agent for a synthetic 40-technician regional HVAC
company. It answers calls and texts, figures out what's wrong, tells
emergencies (gas leaks, no-heat with a vulnerable occupant) from routine
maintenance, and books the job directly onto a live dispatch board.

## How it works

One channel-agnostic conversation loop drives every entry point — phone
calls, SMS, a terminal simulator, and an embedded test-call panel in the
dashboard. Voice and SMS never fork the underlying triage or booking logic;
only the transport adapter differs.

```
   PSTN
     |
  Twilio number ──(SIP trunk)──> OpenAI Realtime (STT, turn-taking, TTS,
                  │                voice LLM)
                  │        │
                  │        │ webhook + tool-call events
                  │        v
                  │   ┌─────────────────────────────────┐
                  └──>│  Fastify backend                │
   inbound SMS        │                                 │
                      │  /webhooks/openai-realtime,      │
                      │  /webhooks/twilio-sms,           │
                      │  /tools/*, /events                │
                      │                                    │
                      │  agent/    <- one loop, every        │
                      │  triage/      channel shares it       │
                      │  tools/                                │
                      │  sms/                                   │
                      │  dashboard/  <- REST + sim panel         │
                      └───────────┬─────────────────────┘
                                  │
                            Postgres (Drizzle)
                                  │
                          React dispatch board (SSE)
```

**The realtime voice vendor (OpenAI Realtime) owns audio — STT, TTS,
turn-taking, barge-in.** The backend owns everything else: triage, tool
calls, booking, and safety. Safety in particular is enforced in code, not
just in the prompt — a deterministic keyword pass runs over the transcript
every turn, and a gas-leak match forces the emergency path regardless of
what the model decided.

## Features

- **Voice agent** over OpenAI Realtime + Twilio, and an **SMS agent** on the
  same Twilio number — one shared tool layer and triage module underneath
  both.
- **Deterministic safety override.** Gas-leak and no-heat/no-AC-with-
  vulnerable-occupant indicators are checked in code on every turn; a match
  fires the emergency flag and interrupts the agent even if the model missed
  it.
- **Five tools**, Zod-validated and idempotent: `customer_lookup`,
  `check_availability`, `book_appointment`, `flag_emergency`,
  `transfer_to_human`.
- **Returning-caller recognition** — a matched phone number gets a
  personalized greeting and equipment context, but never a full address or
  account readback until the caller states it themselves.
- **Skill-based technician matching** — gas, commercial, and refrigerant
  jobs route only to techs tagged for that skill; coverage is deliberately
  scarce in the seed data so this matters.
- **Membership awareness** — plan references are natural for members; a
  soft, one-time mention for non-members only on routine (non-urgent) calls.
- **Live dispatch dashboard** (React/Vite/Tailwind, updates over SSE) —
  dispatch board, emergency rail, live-call banner, activity feed, and a
  built-in test-call panel that runs the same loop from the browser with no
  telephony configured.
- **SMS compliance** — STOP/UNSUBSCRIBE opts a number out and every outbound
  send checks it first.
- **Eval harness** — scripted scenarios (gas smell, elderly occupant no-heat,
  prompt injection, price demands, etc.) asserting on tool calls and response
  content, run against the live model.

## Tech stack

- **Voice:** OpenAI Realtime API (managed STT/TTS/turn-taking + voice LLM) +
  Twilio number
- **SMS:** Twilio Messaging + Claude Haiku for the text-mode agent
- **Backend:** Node, Fastify, TypeScript, Drizzle ORM, Postgres
- **Dashboard:** React, Vite, TypeScript, Tailwind, SSE for live updates
- **LLM:** OpenAI Realtime model for voice, Claude for SMS/intent
  extraction/summarization
- **Host:** Railway (backend + Postgres + dashboard)

## Running it locally

```bash
cp .env.example .env      # fill in DATABASE_URL at minimum
npm install
npm run db:migrate
npm run db:seed
npm run dev                # backend on :3100
npm run dev:dashboard      # dashboard on :5173, separate terminal
```

No API key is required for the above — seeding, tests, and the default
simulator are all free. Add an `ANTHROPIC_API_KEY` to unlock:

```bash
npm run sim -- --live      # free-text conversation in a terminal
npm run eval                # scenario suite against the real model
```

Or open the dashboard and use the **Test call** panel in the header — same
live loop, no terminal needed, and any booking it makes shows up on the
board in real time. This is the fastest way to see a full call-to-board flow
without configuring any telephony.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Backend dev server |
| `npm run dev:dashboard` | Dashboard dev server |
| `npm run lint` / `npm run typecheck` | Lint / type-check |
| `npm test` | Full unit/integration suite (no API key needed) |
| `npm run db:migrate` / `npm run db:seed` | Schema + synthetic demo data |
| `npm run sim` / `npm run sim -- --live` | Text-mode conversation, scripted or live |
| `npm run eval` | Scenario suite against the real model (requires a key) |

## Repo layout

```
prompts/            agent_system_prompt.md (voice), sms_agent_prompt.md
evals/               scenarios/*.yaml + runner
packages/server/src/
  agent/             channel-agnostic loop, prompt assembly, providers
  triage/            deterministic safety override + skill derivation
  tools/             the five Zod-validated, idempotent tool handlers
  transports/        openai-realtime/, retell/ (rollback), twilio/, sim/
  dashboard/         REST surface, SSE state, embedded sim panel backend
  sms/               outbound sender, DNC handling
  db/                Drizzle schema, migrations, seed
packages/dashboard/  React/Vite/Tailwind dispatch board
docs/                spec, product scope, phase plan, scope decisions,
                     prompt changelog, known limitations
```

All seeded customers, technicians, and phone numbers (`555` exchange) are
synthetic — nothing real ever enters the demo database.
