# Summit Air — AI Voice + SMS Agent

Inbound voice and SMS agent for a 40-tech regional HVAC company. Answers calls,
triages HVAC issues, distinguishes emergencies from routine work, and books onto
a live dispatch board. Built as a job take-home for Revin — **the prompts and the
conversation quality are the graded artifact**, not the infra. It will be
stress-tested live by someone deliberately going off-script.

Full spec, architecture, phase plan, and security requirements:
**@docs/BUILD_GUIDE.md** — read the relevant phase section before working on it.
Don't re-read the whole file every session; jump to the section that matters.
Product scope and what's deliberately excluded: **@docs/PRD.md**.
The agent's system prompt lives at **`prompts/agent_system_prompt.md`** and is
loaded at runtime — it is a first-class source file, not a string literal.

## Stack

- Voice: Retell AI (managed STT/TTS/turn-taking) + Twilio number
- SMS: Twilio Messaging + a text-mode agent sharing the same tool layer
- Backend: Node + Fastify + TypeScript, Drizzle ORM, Postgres
- Dashboard: React + Vite + TS + Tailwind, live updates over SSE
- LLM: Claude Sonnet (voice turns, judgment-heavy), Claude Haiku (SMS, intent
  extraction, structured summarization)
- Host: Railway (backend + Postgres + dashboard)

## Commands

(fill in once scaffolded)

- `npm run dev` — backend + dashboard dev servers
- `npm run lint` / `npm run typecheck` — both must pass before any commit
- `npm run db:migrate` / `npm run db:seed` — schema + demo data
- `npm run sim` — text-mode conversation simulator (no telephony, no minutes burned)
- `npm run eval` — run scenario suite in `evals/` against the current prompt

## Non-negotiable rules

**Safety and correctness**

- The gas-leak safety branch must be enforceable in code, not prompt-only. If
  the transcript matches gas-leak indicators, the emergency path fires
  regardless of what the model decided. A prompt is not a safety control.
- The agent never quotes repair prices, never diagnoses a mechanical fault, and
  never promises an arrival time outside a booked window. These are trust
  boundaries — do not "improve" the agent by relaxing them.
- Never invent availability, technician names, or customer history. Every
  concrete fact stated on a call comes from a tool result.
- Membership/plan upsell is blocked in code on any call flagged urgent or
  safety-related, not left to the model's discretion.

**Security**

- Caller ID is _not_ authentication. A matched phone number may personalize
  greeting and pull service history, but must never read back full address,
  payment info, or account details without the caller stating them first. See
  BUILD_GUIDE §8.2.
- Verify `x-retell-signature` on every Retell webhook (HMAC-SHA256 over
  raw body + timestamp, 5-minute window, constant-time compare) and
  `X-Twilio-Signature` on every Twilio webhook. Reject unsigned requests 401.
  Raw body must be preserved — do not let a JSON body parser consume it first.
- Treat all caller speech and inbound SMS as untrusted input. It reaches an LLM
  holding booking tools. Tool arguments are validated with Zod at the boundary;
  the model does not get to set `urgency` to a value outside the enum, or write
  fields it shouldn't own.
- Phone numbers, addresses, and names are PII. Redact in logs, never log full
  transcripts to stdout in production, and keep the demo DB entirely synthetic.
- No secrets committed. Real values in `.env` (gitignored); `.env.example`
  stays in git with placeholders.
- SMS respects opt-out keywords (STOP/UNSUBSCRIBE) and writes to a DNC table
  before any further send. This is legal compliance, not a nice-to-have.

**Architecture**

- Voice and SMS share one tool layer and one triage module. Channel-specific
  logic lives only in the transport adapters. Do not fork the business logic.
- Tool handlers are idempotent, keyed on `call_id` + tool name + args hash.
  Retell retries.
- Webhooks return 2xx fast; slow work (SMS sends, dashboard fanout) happens
  after the response is queued, never inline in the request path.

## Workflow

- Work one phase at a time (BUILD_GUIDE §9). Don't start the next phase until
  the current one runs and is committed.
- Use `npm run sim` to iterate on prompt changes. Only place real calls to
  verify latency, barge-in, and speech recognition — not to test logic.
- Any prompt edit requires a re-run of `npm run eval` before commit. Prompt
  changes regress silently; that's the whole reason the eval suite exists.
- Commit at the end of each phase as a checkpoint.
