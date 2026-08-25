# 120/Life AI OS — Architecture

---

## 1. System shape

```
┌───────────────────────────────────────────────────────────────────────┐
│  SOURCES                                                              │
│  Outlook · Zoom · Slack · Google Drive · Calendar                     │
│  Finaloop→Claude · Klaviyo→Claude · Gusto→Claude · Quartile · CS      │
└───────────────────────────┬───────────────────────────────────────────┘
                            │ webhooks / polling
┌───────────────────────────▼───────────────────────────────────────────┐
│  n8n — ORCHESTRATION                                                  │
│  triggers · schedules · retries · approvals · notifications           │
└───────────────────────────┬───────────────────────────────────────────┘
                            │ HTTP (or in-process for self-hosted)
┌───────────────────────────▼───────────────────────────────────────────┐
│  CORE LOGIC (this repo, TypeScript)                                   │
│                                                                       │
│  normalization → identity → context → interpretation (AI)             │
│       → matching/dedup → routing → priority → recommendation          │
│                                                                       │
│  Deterministic, unit-tested, replayable                               │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│  SUPABASE / POSTGRES — CANONICAL STATE                                │
│  people · orgs · capabilities · evidence · initiatives · tasks         │
│  commitments · events · meetings · decisions · priority history        │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│  OUTPUTS                                                              │
│  Daily CEO brief · Paul view · Mike view · meeting prep               │
│  Follow-up queue · Outlook drafts · decision queue                    │
└───────────────────────────────────────────────────────────────────────┘
```

**Invariant:** Outlook, Slack, Zoom, Drive, and AI chat histories are *evidence*. Postgres is *state*. No exceptions.

---

## 2. Pipeline stages

Implemented in `src/`, composed by `src/pipeline.ts`.

### 2.1 Normalize — `src/normalization/`

Every source produces a `CanonicalEvent`:

```ts
{
  event_type, occurred_at, source_system, source_external_id,
  actor: { name?, email?, slack_user_id?, zoom_identity? },
  participants: Participant[],
  subject, body, summary,
  raw_reference, raw_payload_reference, metadata
}
```

Source-specific quirks (Graph message shapes, Zoom summary payloads, Slack event envelopes) are handled here and nowhere else. `source_system` + `source_external_id` is unique — this is the first line of defense against reprocessing.

### 2.2 Identify — `src/people/`

Resolve actor and participants to `people` and `organizations`. Resolution order:

1. Exact email match
2. Slack user ID / Zoom identity match
3. Normalized-name match within a known organization
4. Email domain → organization inference
5. Signature-block parsing, thread context, then **provisional creation**

Never blocks the pipeline. An unresolvable participant becomes a `discovered` person and processing continues.

### 2.3 Retrieve context — `src/matching/context.ts`

Assemble what an informed human would want: the thread, related initiative, open tasks touching these people or this org, outstanding commitments in both directions, recent decisions, relationship history, relevant Drive documents (Phase 8).

### 2.4 Interpret — AI, `prompts/`

The AI answers: *what does this mean for the business?* Output is validated against a Zod schema and persisted to `ai_interpretations` with model and `prompt_version`. An interpretation that fails validation is retried once, then parked as `NEEDS_REVIEW` — it is never silently dropped.

### 2.5 Match & deduplicate — `src/deduplication/`, `src/matching/`

Decide one of:

```
CREATE  ·  UPDATE_EXISTING  ·  MERGE  ·  IGNORE  ·  NEEDS_REVIEW
```

Similarity blends title/description similarity, participant overlap, initiative match, temporal proximity, and external-thread identity. The same real activity arriving from Zoom, Slack, and email must converge to **one** task with three attached events.

### 2.6 Route — `src/routing/`

The owner-selection engine (§15 of the brief). Consumes task, business area, required capabilities, participants, relationship history, workload, and current ownership. Produces owner, PM, decision maker, approver, collaborators, external counterparty, confidence, and a human-readable **reason**. Runs the Paul leverage evaluation alongside.

### 2.7 Prioritize — `src/priority/`

Deterministic score first:

```
priority = impact*3 + urgency*3 + risk*2 + relationship
         + strategic_importance + blocker_bonus
         + decision_dependency_bonus - effort_penalty
```

All weights live in `config/priority-rules.yaml`. Then an AI **portfolio review** looks at open work as a whole. Every rank change writes a `priority_history` row with a reason, which is what makes "moved #8 → #2 because inventory coverage is projected to fall below threshold" possible.

### 2.8 Recommend & execute — `src/approval/`

Each proposed action gets an approval class:

- **GREEN** — potentially automatable later: simple acknowledgments, scheduling logistics, routine reminders, requests for already-agreed information
- **YELLOW** — human approval required: vendors, retailers, agencies, podcast partners, negotiations, material operational messages, pricing
- **RED** — always manual: legal, regulatory, contracts, employment, investors, health/product claims, disputes, sensitive finances, major expenditures, reputationally sensitive communication

Through Phase 5 nothing external is sent at all. Phase 6 adds drafts. Autonomy is Phase 10 and GREEN-only.

### 2.9 Track completion — `src/completion/`

Completion is **detected from evidence**, not assumed from checkboxes: a reply confirming receipt, a Slack confirmation, a new Drive file, a meeting outcome, a payment confirmation, "the run is scheduled for Sept 14." High-confidence detections may auto-complete; consequential items require human verification.

---

## 3. Data model overview

Full DDL in `docs/database.md` and `database/migrations/`.

**Identity:** `organizations`, `people`, `capabilities`, `person_capabilities`, `organization_capabilities`, `responsibility_evidence`

**Work:** `initiatives`, `tasks`, `task_collaborators`, `commitments`, `task_events`

**Evidence:** `events`, `meetings`, `meeting_attendees`, `decisions`, `ai_interpretations`

**Operations:** `priority_history`, `workflow_runs`, `corrections`, `business_signals`, `drive_documents`

Design notes:

- `events` is append-oriented and never mutated after processing.
- Tasks carry `source_event_id` for provenance plus `task_events` for the full multi-source evidence trail.
- Every AI-derived row carries `confidence`.
- Scores are stored decomposed (`impact_score`, `urgency_score`, …) so a score can always be explained, not just reported.

---

## 4. AI usage boundaries

| Job | Approach | Why |
|---|---|---|
| Classification / extraction | AI + strict schema | Language understanding |
| People discovery | AI + deterministic resolution first | Cheap path first |
| Routing | Deterministic scoring, AI tie-break and reasoning | Auditable, testable |
| Priority | Deterministic formula, AI portfolio review | Reproducible base |
| Dedup | Deterministic similarity, AI on ambiguity | Fast and cheap |
| Drafting | AI with full context | Genuinely generative |
| Completion detection | AI + confidence gate | Judgment required |

Cost and reliability discipline: prompts are versioned in `prompts/`; every call is persisted; batch where possible; cache stable context; short-circuit obvious cases (newsletters, receipts, automated notifications) before any AI call.

---

## 5. Integration approach

Every integration implements a narrow interface in `src/integrations/` with a mock alongside. Missing credentials never block development.

```ts
interface EmailSource   { fetchSince(t): Promise<RawEmail[]>; fetchThread(id): Promise<RawEmail[]>; createDraft(d): Promise<DraftRef>; }
interface MeetingSource { fetchSummary(id): Promise<RawMeetingSummary>; listRecent(since): Promise<MeetingRef[]>; }
interface ChatSource    { fetchMessages(ch, since): Promise<RawChatMessage[]>; postMessage(ch, blocks): Promise<void>; }
interface SignalSource  { pull(since): Promise<BusinessSignal[]>; }
```

**Existing Claude connectors — Finaloop, Klaviyo, Gusto — are treated as upstream intelligence services.** We do not rebuild them. They emit `BusinessSignal`s; the routing engine decides what to do with each.

```json
{
  "signal_type": "cash_risk",
  "business_area": "finance",
  "severity": 8,
  "summary": "Large production payment due within 7 days.",
  "evidence": "...",
  "recommended_action": "Confirm production/payment timing.",
  "likely_people": ["Peter", "Mike", "Adi"]
}
```

The cross-functional reasoning that follows is the point: Peter → payment execution; Mike → production impact; Adi → the cash/production decision if material; Paul → coordination if useful.

---

## 6. Configuration philosophy

`config/*.yaml` holds everything an operator should be able to change without a developer: people, organizations, capabilities, business areas, priority weights, routing rules, approval classes, follow-up cadences, AI model routing.

Config is loaded, validated against Zod schemas at startup, and reconciled into the database. Invalid config fails loudly at boot rather than misbehaving quietly at runtime.

---

## 7. Failure posture

- **Ingestion failure** → `workflow_runs` records the error; retry with backoff; never silently drop an event.
- **AI failure / invalid output** → retry once, then `NEEDS_REVIEW`.
- **Low confidence** → route to review, never guess on high-impact items.
- **Ambiguous dedup** → `NEEDS_REVIEW` rather than a wrong merge. A bad merge destroys information; a duplicate is merely annoying.
- **Unknown person** → provisional record, continue.

The system's degraded mode is *"ask a human,"* never *"act confidently on a guess."*

---

## 8. Security

Detailed in `docs/security.md`. Summary: service-role credentials server-side only; secrets in n8n credential store or environment, never in workflow JSON; raw email bodies stored by reference where possible; RED-class actions never automated; every automated action logged and reversible; PII minimization in prompts.
