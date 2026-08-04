# Summit Air AI Agent — Product Requirements v2

## Framing
Revin's own pitch is "no off-the-shelf bots" — an agent built on how a specific
operator actually runs, with a dedicated engineer embedded in the workflow.
This demo should read as if that process already happened for Summit Air: the
agent knows Summit Air's customers, its techs, its coverage area, and behaves
like a very good CSR who's worked there for years — not a generic scheduling bot
with an HVAC skin on it.

---

## 1. Capture Opportunities

**Voice (built)**
- Inbound call → Retell agent → intake, triage, booking (existing system prompt)

**SMS (new)**
- Same phone number (or a paired number) takes inbound texts
- Lightweight text-based agent, same triage/intake logic, same tool functions,
  faster/cheaper model (Haiku-class) since SMS tolerates less latency-sensitive
  but more turn-heavy conversation
- A texted "no heat" or "gas smell" hits the same safety/urgency branches as a
  call — triage logic must be channel-agnostic, not voice-only

**Returning caller recognition (new)**
- On call/text start, look up caller's number against a mock customer DB
- If found: greet by name, reference known equipment ("your heat pump's the
  2019 install, right?"), skip re-asking for address/property type
- If not found: standard new-customer intake
- This is the single highest-leverage "wow" feature — it's the first 10
  seconds of the call and immediately signals a mature product, not a demo toy

---

## 2. Appointment Management

**Triage (built)** — safety branch, urgency criteria, routine vs. priority

**Skill-based technician matching (new)**
- Mock tech roster with skill tags: gas, electrical, commercial-certified,
  refrigerant/EPA-certified, residential-only
- Booking picks a tech who's actually qualified for the job, not just the next
  open slot — mirrors Revin's job-matching claim, and it's a real dispatch
  problem, not decoration
- Commercial jobs and gas-related jobs route to tagged techs only

**Live dispatch dashboard (new)**
- Web view: technicians as rows/columns, today's board, capacity per tech
- Incoming call banner when a call starts
- Appointment cards land on the board in real time as the agent books them
- Emergency-flagged appointments visually distinct (red/urgent styling)
- This is what makes the call feel "real" to watch — the interviewer sees the
  booking hit the board the moment the agent confirms it on the call, same
  beat as Revin's actual "books directly onto your call board" pitch

---

## 3. Revenue Recovery

**Membership awareness (new)**
- Mock DB includes membership status
- Members: agent references their plan directly, sometimes waives standard
  dispatch flow ("you're on the Comfort Club plan, so this is covered")
- Non-members on a *routine* call only: one soft, non-pushy mention of the
  plan. Never during an urgent or safety call — that's a hard rule, not a
  judgment call

**Missed/abandoned call recovery (stretch)**
- If a call disconnects before intake is complete, auto-send a follow-up SMS
  picking up where the call left off, rather than losing the lead entirely
- Directly mirrors what Action-Furnace-style operators actually lean on Revin
  for — worth building if the core paths are solid first

---

## 4. Post-Job Nurture

- SMS booking confirmation immediately after a call books (time, tech name,
  what to expect)
- Emergency situations also get a customer-facing SMS as a backup channel, in
  case the call drops
- Stretch, lower priority: day-of reminder text, post-visit review request —
  worth naming in the narrative even if not fully built, since it shows the
  full-journey thinking without over-scoping the demo itself

---

## Explicitly out of scope (and why)
- **Multi-brand "Enterprise Hub"** — Summit Air is a single operator across
  three counties, not a multi-brand portfolio; that feature has no audience here
- **Real ServiceTitan API integration** — we mock the shape and behavior of a
  dispatch board; a live OAuth integration isn't a reasonable ask for a demo
  and would eat the whole budget on plumbing, not product judgment
- **Custom pricebook / real repair pricing** — the agent never quotes repair
  prices; it can state a standard diagnostic/service-call fee if asked, but
  actual pricing requires a technician on-site. This is a deliberate trust
  boundary, not a missing feature
- **Outbound sales/estimate-closing agent** — that's Revin's home-improvement
  and roofing product surface, not HVAC service dispatch; irrelevant here
- **Fine-tuning on real call recordings** — no real Summit Air call data
  exists yet. Worth noting in the write-up that the architecture is built to
  support an evals loop against real transcripts once they exist — that's the
  actual differentiator Revin sells, and it's worth showing you understand it
  even though you can't build it today

---

## Updated tool list
- `customer_lookup(phone)` → existing customer record or null
- `check_availability(county, urgency, skill_required)`
- `book_appointment(...)` → now includes `technician_id`, triggers dashboard
  update and confirmation SMS as side effects
- `flag_emergency(...)` → triggers dispatcher SMS + customer-facing SMS
- `transfer_to_human(...)`

## Proposed build sequence
Even without a deadline, sequencing still matters for narrative coherence —
each piece should be demoable on its own before the next is layered in:
1. Customer DB + lookup — foundation everything else personalizes against
2. Dispatch dashboard shell — visual payoff, can build against mock data alone
3. SMS channel (inbound + outbound)
4. Skill-based tech matching wired into booking + dashboard
5. Revenue recovery / nurture touches — highest polish, lowest core risk, last
