# Database

Supabase / PostgreSQL is the **canonical state**. Outlook, Slack, Zoom, Drive
and AI chat histories are evidence. This distinction is the system's central
invariant — every other design decision follows from it.

## Migrations

Ordered and idempotent. Run with `npm run db:migrate`.

| File | Contents |
|---|---|
| `0001_extensions_and_enums.sql` | `pgcrypto`, `pg_trgm`, `unaccent`; all enum types |
| `0002_identity.sql` | organizations, people, capabilities, capability edges, responsibility evidence |
| `0003_events.sql` | events, event participants, meetings, attendees, decisions, AI interpretations |
| `0004_work.sql` | initiatives, tasks, collaborators, task events, commitments |
| `0005_operations.sql` | priority history, workflow runs, corrections, business signals, Drive index, brief deliveries, routing decisions |
| `0006_triggers_and_views.sql` | `updated_at` triggers and read models |

## Design decisions worth knowing

### There is no `assignee` column

Real work at 120/Life has a primary owner, a project manager, a decision maker,
an approver, collaborators, and often an external counterparty. A single
assignee field cannot express *"Mike owns it, Adi approves the spend, Paul
tracks the dates, the manufacturer executes, Peter pays"* — and that sentence is
the thing this system exists to produce. So the columns are separate.

### Scores are stored decomposed

`impact_score`, `urgency_score`, `risk_score` and the rest live alongside
`base_priority_score`. Storing only the total would make the score
unexplainable, and the daily brief has to be able to say *why* something moved.

### `events` is append-oriented

Rows are never mutated after processing except for their `processing_status`
bookkeeping. The unique index on `(source_system, source_external_id)` is the
first line of defense against reprocessing.

### Raw content is stored by reference

`raw_reference` and `raw_payload_reference` point back to the source system,
which already has retention and access control. `raw_payload` exists for cases
where a reference is impossible, but is the exception.

### Confidence everywhere

Every AI-derived row carries `confidence`. Anything below a gate goes to
`needs_review` rather than being acted on.

### `corrections` is training data, not an error log

"Wrong owner", "Paul can handle this", "not important" are first-class inputs.
They adjust capability confidence, and a repeated pattern surfaces a proposed
rule change for human confirmation. The system does not silently rewrite its own
rules.

### `routing_decisions` exists to be measured

Each row stores the input snapshot, the output, and eventually a human verdict.
The pair (output, verdict) is the measurement set behind the Phase 3 exit
criterion — *routing agreement ≥ 85%* has to be computable from data, not
asserted.

## Read models

| View | Purpose |
|---|---|
| `v_open_tasks` | The working set, with terminal states excluded so callers cannot forget to |
| `v_person_workload` | Open, overdue and waiting counts — routing must be workload-aware |
| `v_waiting_on` | Follow-up register, split internal vs. external |
| `v_ceo_attention` | Separates CEO-owned work from CEO-decides-only |
| `v_person_capability_ranked` | Ranked candidates per capability; the routing engine's primary read model |

`v_ceo_attention` is worth calling out: `attention_type` distinguishes
`ceo_owns_work` from `ceo_decides_only` from `ceo_awareness`. Both of the first
two "need Adi". Only one of them costs a day.

## Identity keys by source

| Source | Key | Why |
|---|---|---|
| Outlook | `internetMessageId` | Stable across mailboxes; Graph's `id` is not |
| Zoom meeting | meeting **UUID** | The meeting *number* is shared by every occurrence of a recurring meeting |
| Zoom action item | `stepId` | Stable per item; makes re-ingestion idempotent |
| Slack | `channel:ts` | `ts` alone repeats across channels |
| Signal | `source:type:area:window` | Keeps a recurring condition as one updating record |

## Row-level security

Supabase RLS is **on** for every table. The service role bypasses it for
server-side workflow access. If a client-facing surface is ever added, policies
must be written before it ships — not after.

## What does not belong here

- Raw email bodies at scale — reference the source system
- Meeting transcripts — reference Zoom
- Drive file contents — index metadata and embeddings only
- Anything Drive should remain the system of record for. Drive provides context;
  it never becomes the task system.
