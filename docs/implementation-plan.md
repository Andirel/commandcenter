# 120/Life AI Operating System — Implementation Plan

**Status:** Phase 1 (Foundation) in progress
**Repository:** `commandcenter`
**Owner of record:** Adi (CEO)

---

## 0. What this system is

An internal operational intelligence layer for 120/Life that continuously answers:

- What is happening across the company?
- What has been committed, decided, and promised?
- What is everyone waiting on?
- Who is genuinely best positioned to move each thing forward?
- What actually requires the CEO's attention — and in what mode (DO / DECIDE / APPROVE / DELEGATE / FOLLOW UP / REVIEW)?
- Did the intended business outcome actually happen?

**Optimization objective:** maximize useful business progress per unit of team attention, especially CEO attention.

**Explicit non-goals.** We do not optimize for number of automations, number of AI calls, number of tasks created, emails sent, apparent activity, or theoretical "hours saved." A system that creates 400 tasks a week is a failure, not a success.

---

## 1. Architectural commitments

These are the decisions that everything else depends on. Changing one of these is a re-architecture, not a tweak.

| Decision | Choice | Why |
|---|---|---|
| Canonical state | Supabase / PostgreSQL | Single source of truth. Outlook, Slack, Zoom and AI chat histories are **evidence**, never state. |
| Automation / orchestration | n8n | Triggers, schedules, retries, approvals, webhook handling, notification fan-out. |
| Business logic | TypeScript library in this repo | Routing, priority, dedup, matching, normalization must be **testable in isolation** — not buried in n8n nodes. |
| AI boundary | Deterministic scoring first, AI for interpretation and portfolio judgment | Deterministic layers are auditable and cheap. AI is used where judgment is genuinely required. |
| Team model | Capability graph + evidence, not an org chart | 120/Life is small and cross-functional. Titles under-determine ownership. |
| External sending | Off by default, through Phase 5 | Trust must be earned by demonstrated interpretation accuracy. |

### 1.1 Why the logic lives in TypeScript, not in n8n

n8n is excellent at "when X happens, call Y, retry, notify." It is poor at "given 40 open tasks, a capability graph, workload, and relationship history, decide who owns this and why" — that logic needs unit tests, version control, and the ability to be replayed against historical events. So:

- n8n calls into this repo's logic via a thin HTTP service (or via `npx tsx` in a Code/Execute step for self-hosted n8n).
- Every AI interpretation is persisted to `ai_interpretations` with the model and prompt version, so we can measure whether prompt v3 routes better than prompt v2.
- Every routing decision writes its `reason` string. An unexplained decision is a bug.

---

## 2. The fundamental loop

Every meaningful signal follows the same path. This is the spine of the system.

```
EVENT (Outlook / Zoom / Slack / Drive / Finaloop / Klaviyo / Gusto / customer service)
  ↓ NORMALIZE                — one shape regardless of source
  ↓ IDENTIFY PEOPLE & ORGS   — resolve or provisionally discover
  ↓ RETRIEVE CONTEXT         — thread history, initiative, open tasks, relationship history
  ↓ INTERPRET                — AI: what does this mean for the business?
  ↓ MATCH EXISTING STATE     — CREATE / UPDATE_EXISTING / MERGE / IGNORE / NEEDS_REVIEW
  ↓ ROUTE OWNERSHIP          — owner, PM, decision maker, collaborators, counterparty
  ↓ RECALCULATE PRIORITIES   — deterministic score, then AI portfolio review
  ↓ RECOMMEND NEXT ACTION
  ↓ EXECUTE IF AUTHORIZED    — approval class GREEN only, and only after Phase 6
  ↓ TRACK UNTIL COMPLETION   — completion detection from evidence, not checkboxes
```

The last step is the one most systems skip. "Task created" is not the goal. "Did the business outcome occur?" is.

---

## 3. Build phases

Each phase has an explicit exit criterion. We do not advance on schedule; we advance on evidence.

### Phase 1 — Foundation ✅ (this session)

Build the substrate with no external connections at all.

- [x] Postgres schema: organizations, people, capabilities, person/org capabilities, responsibility evidence, initiatives, tasks, task collaborators, commitments, events, meetings, meeting attendees, decisions, priority history, AI interpretations, workflow runs, plus supporting tables (corrections, business signals, waiting-on, drive index)
- [x] Seed data for the current team and external partners
- [x] Typed schemas (Zod) for every AI boundary and every core entity
- [x] Capability graph with evidence accumulation
- [x] People/org discovery and resolution
- [x] Owner-selection engine (incl. the Paul leverage evaluation)
- [x] Priority engine (deterministic) + portfolio review interface
- [x] Deduplication and task matching
- [x] Normalization for Outlook / Zoom / Slack / signal sources
- [x] Test suite including the eight required team-routing scenarios

**Exit criterion:** routing and priority behave correctly against the fixture scenarios, with reasons a human agrees with.

### Phase 2 — Passive Intelligence

Connect read-only ingestion. **Nothing is sent anywhere.**

- Outlook inbound (`01-outlook-inbound`)
- Outlook sent, for commitment detection (`02-outlook-sent`)
- Zoom meeting summaries and action items (`03-zoom-meeting-summary`)
- Selected Slack channels and DMs (`04-slack-ingestion`)

Goal: **understand reality accurately.** Run in shadow mode; a human reviews the interpretation stream daily.

**Exit criterion:** over a 2-week window — task creation precision ≥ 0.85 (we are not creating junk), commitment recall ≥ 0.80 on a hand-labeled sample, duplicate rate ≤ 5%.

### Phase 3 — Team & Ownership Intelligence

Validate that the system understands *who does what* at 120/Life.

Specific attention to the distinctions that matter most:

- Adi vs. Paul (does the CEO actually need to touch this?)
- Paul vs. Mike (coordination vs. specialist operational ownership)
- Peter vs. Brian (A/P execution vs. bookkeeping — these are **not** interchangeable)
- Internal specialist vs. external agency (Quartile, RadioActive, manufacturers)
- New-person discovery quality

**Exit criterion:** owner-routing agreement with Adi's judgment ≥ 85% on a review sample of 100 routed items; zero Peter/Brian confusions.

### Phase 4 — CEO Command Center

- `05-daily-ceo-brief` — the daily command center, delivered to Slack
- Priority-change explanations ("moved #8 → #2 because…")
- A decision queue kept **distinct** from a task list
- Delegation / Paul-leverage suggestions
- `09-meeting-prep`

**Exit criterion:** Adi reports the brief is the first thing he reads and it is right more often than not.

### Phase 5 — Follow-Up

- Waiting-on register (internal vs. external)
- Response reconciliation — did the awaited thing arrive?
- Paul follow-up queue
- External follow-up **drafts** (still not sent)
- `06-end-of-day-brief`, `07-followup-engine`

**Exit criterion:** the system reliably notices when someone owes us something and when they deliver it.

### Phase 6 — Communications

- `08-email-drafting` — creates **drafts in Outlook**, never sends
- Slack notification with the draft, the reason it exists, and the recommendation

**Exit criterion:** a meaningful share of drafts are sent with light or no editing.

### Phase 7 — Team Execution Views

Only after the above is proven, and only with Adi's approval:

- Paul execution brief (§26)
- Mike operations brief (§27)
- Specialist task recommendations
- Internal Slack drafts

### Phase 8 — Drive Intelligence

Metadata index + embeddings over Google Drive. Retrieval only — Drive never becomes the task system.

### Phase 9 — Business Signals

Standardized `BusinessSignal` interface consuming the **existing** Claude connectors — Finaloop, Klaviyo, Gusto — plus Quartile data and aggregated customer-service patterns. We do not rebuild what already works.

### Phase 10 — Limited Autonomy

GREEN-class actions only, and only after measured reliability. Every autonomous action is logged and reversible.

---

## 4. Phase 1 deliverable map

| Area | Path | Purpose |
|---|---|---|
| Migrations | `database/migrations/` | Ordered, idempotent SQL |
| Seed | `database/seed/` | Team, orgs, capabilities, business areas |
| Config | `config/*.yaml` | Editable operating rules — no code change to add a person |
| Schemas | `src/schemas/` | Zod types; every AI output is validated |
| People | `src/people/` | Resolution, discovery, provisional profiles |
| Capabilities | `src/capabilities/` | Capability graph, evidence, confidence decay |
| Routing | `src/routing/` | Owner selection + Paul leverage engine |
| Priority | `src/priority/` | Deterministic scoring + portfolio review contract |
| Dedup / Match | `src/deduplication/`, `src/matching/` | One canonical task per real activity |
| Normalization | `src/normalization/` | Source-specific → canonical event |
| Integrations | `src/integrations/` | Interfaces + mocks where credentials are absent |
| Prompts | `prompts/` | Versioned, with explicit output contracts |
| Workflows | `workflows/` | n8n definitions + per-workflow README |
| Tests | `tests/` | Including the eight required routing scenarios |

---

## 5. Credential requirements (blocked on user action)

Every integration ships with an interface and a mock, so development is never blocked. Real connection requires:

| System | What is needed | Notes |
|---|---|---|
| Supabase / Postgres | `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Service role key is server-side only, never in n8n's browser context |
| Microsoft Graph (Outlook) | Entra app registration; `Mail.Read`, `Mail.ReadWrite`, `Mail.Send` (Phase 6+), `Calendars.Read` | Prefer application permissions + admin consent for unattended ingestion |
| Zoom | Server-to-Server OAuth app; `meeting:read`, `meeting_summary:read`; webhook secret token | Meeting Summary API access depends on plan and account settings |
| Slack | Bot token with `channels:history`, `groups:history`, `im:history`, `users:read`, `chat:write`, `reactions:read` | Event Subscriptions → n8n webhook |
| Google Drive | Service account with domain-wide delegation, or OAuth; Drive Activity API for change feed | |
| Anthropic | `ANTHROPIC_API_KEY` | For interpretation, routing assistance, portfolio review, drafting |
| Finaloop / Klaviyo / Gusto | Existing Claude connectors | Consumed as **signal producers**, not rebuilt |
| n8n | Instance URL + API key | Self-hosted recommended for data residency |

**Rule:** we never invent credentials. Missing credential → implement interface, implement mock, document the requirement, continue.

---

## 6. Operating principles

1. **Evidence over assertion.** The system stores *why* it believes something. Confidence without evidence is not allowed.
2. **Provisional by default.** A newly discovered person is `discovered`, not an owner. Authority is earned through repeated evidence.
3. **Corrections are training data.** "Wrong owner," "Paul can handle this," "not important" are first-class inputs stored in `corrections` and fed back into routing.
4. **High-impact changes need more evidence.** Re-routing a $40k decision requires a higher confidence bar than re-routing a document request.
5. **One canonical task.** The same activity arriving via Zoom, Slack and email is one task with three pieces of evidence.
6. **Zoom attribution is evidence, not truth.** "Adi will look into X" means someone said that in a meeting — not that Adi should own it.
7. **Attention is the scarce resource.** Every item in a brief must justify the seconds it costs to read.

---

## 7. Immediate next steps after Phase 1

1. Provision Supabase; run migrations and seed.
2. Register the Entra app; begin `01-outlook-inbound` in shadow mode.
3. Configure Zoom S2S OAuth + webhook; begin `03-zoom-meeting-summary`.
4. Pick 3–5 Slack channels for initial ingestion (not the whole workspace).
5. Run 2 weeks of passive interpretation; review the stream daily with Adi and Paul.
6. Tune `config/routing-rules.yaml` and `config/priority-rules.yaml` from observed errors before building any brief.
