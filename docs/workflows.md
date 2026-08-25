# Workflows

Operational detail for the n8n layer. Per-workflow specifics live in each
`workflows/*/README.md`; this document covers what they share.

## Division of responsibility

**n8n owns:** triggers, schedules, retries, webhook handling, approval routing,
notification fan-out, credential storage.

**This repo owns:** normalization, identity resolution, interpretation contracts,
matching, deduplication, routing, priority, brief composition.

The boundary matters. Business logic buried in n8n nodes cannot be unit-tested,
version-controlled meaningfully, or replayed against historical events — and
replay is how routing quality gets measured.

## Calling into the repo

**HTTP (recommended, works on n8n Cloud)** — run this repo as a small service;
call it from an HTTP Request node. One endpoint per pipeline stage, or one
`/process-event` endpoint taking a `CanonicalEvent`.

**Execute Command (self-hosted only)** — `npx tsx scripts/<entry>.ts` with JSON
on stdin.

## Watermarks

Every polling workflow keeps a watermark in `workflow_runs.metadata`. Rules:

- Advance **only** on a fully successful batch. A mid-batch failure must re-read,
  not skip.
- Overlap the window slightly (a few minutes). Duplicate events are free —
  `(source_system, source_external_id)` is unique — while a gap loses a
  commitment permanently.
- Never trust the source's ordering guarantees.

## Retry policy

| Failure | Response |
|---|---|
| HTTP 429 | Honour `Retry-After`; exponential backoff |
| HTTP 5xx | Retry 3× with backoff, then record `partial` |
| Auth failure | Fail fast and alert — do not retry into a lockout |
| Invalid AI output | Retry once, then `needs_review` |
| Schema validation | Never retry; record and `needs_review` |
| Unknown person | Not a failure — provisional record, continue |

An event is never silently dropped. The worst acceptable outcome is
`needs_review`.

## Zoom: connector vs. direct API

The **connector path is primary** — 120/Life already has the Zoom for Claude
connector installed, so it needs no separate app registration, no S2S OAuth
credentials, and no webhook endpoint.

The **direct API path** remains available as a fallback:

- Server-to-Server OAuth app; scopes `meeting:read`, `meeting_summary:read`
- `GET /v2/meetings/{meetingId}/meeting_summary`
- Meeting UUIDs containing `/` or `+` must be **double URL-encoded** — a single
  encoding is decoded by the gateway before routing, so the raw character
  reappears in the path and breaks it (`src/integrations/zoom-connector.ts`
  → `encodeMeetingId`)
- Summary availability depends on the Zoom plan and on AI Companion being enabled

The two paths return **different shapes**. The direct API returns structured
`next_steps` arrays; the connector returns attributed markdown. The normalizer is
written against the connector format, verified against real data. Switching to
the direct path requires a second parser — the shape difference is documented at
the top of `src/normalization/zoom.ts`.

## Microsoft Graph notes

- Change notification subscriptions **expire** and must be renewed. Treat the
  scheduled poll as the real guarantee, not a backstop.
- `internetMessageId` is the stable identity. Graph's `id` is mailbox-scoped and
  changes when a message moves folders.
- Application permissions with admin consent are preferred for unattended
  ingestion; delegated permissions require a signed-in user and a refresh token
  that will eventually lapse.

## Slack notes

- Verify the signing secret on every webhook.
- Slack retries deliveries. Respond 200 immediately and process asynchronously,
  or the same event arrives repeatedly.
- `ts` is unique only within a channel; the identity key is `channel:ts`.
- Start with 3–5 channels. Widening scope before precision is demonstrated
  produces noise that discredits the whole system.

## Scheduling

| Workflow | Cadence |
|---|---|
| Outlook inbound | Webhook + 10-minute poll |
| Outlook sent | 15-minute poll |
| Zoom summaries | Hourly |
| Slack | Webhook + 30-minute backfill |
| Portfolio review | Weekday mornings, **before** the brief |
| Daily brief | Weekday mornings |
| End-of-day brief | Weekday evenings |
| Follow-up engine | Daily |
| Business signals | Hourly or per source cadence |

The portfolio review runs before the brief so the brief reads settled scores
rather than racing them.

## Cost control

Ordered by impact:

1. **Short-circuit before any model call** — automated senders, bulk headers,
   Slack noise. This removes most of the volume and is the largest saving
   available.
2. **Cheap triage before expensive interpretation.**
3. **Cache stable context** — the team model and capability graph change rarely
   and should not be re-sent on every request.
4. **Batch** where the source allows it.
5. **Budgets** — `daily_call_budget_warn` and `daily_call_budget_halt` in
   `config/ai-routing.yaml`. Halt and alert rather than running up a bill.

## Monitoring

Worth alerting on:

- A workflow with no successful run in its expected window
- `events` with `processing_status = 'pending'` older than an hour
- `needs_review` accumulating faster than it is cleared
- AI validation failure rate above a few percent — usually a prompt regression
- Daily call count approaching the budget
- Duplicate rate above 5% — the matcher needs tuning
