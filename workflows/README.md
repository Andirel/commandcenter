# Workflows

n8n owns orchestration: triggers, schedules, retries, approvals, notifications.
It does **not** own decisions. Routing, priority, deduplication and matching
live in `src/` where they can be unit-tested and replayed.

Each workflow directory contains a `README.md` describing the trigger, the
steps, the credentials it needs, and its failure behaviour. The n8n JSON is
exported here once the workflow exists in the instance — it is not hand-written,
because hand-edited n8n JSON drifts from what is actually running.

## Calling into this repo

Two options, both supported:

1. **HTTP** (recommended for n8n Cloud) — run this repo as a small service and
   call it from an HTTP Request node.
2. **Execute Command** (self-hosted only) — `npx tsx scripts/<entry>.ts` with
   JSON on stdin.

Either way, the boundary is the same: n8n hands over a `CanonicalEvent` and gets
back a decision. n8n never decides who owns anything.

## Phase gating

| Workflow | Phase | Sends anything externally? |
|---|---|---|
| `01-outlook-inbound` | 2 | No |
| `02-outlook-sent` | 2 | No |
| `03-zoom-meeting-summary` | 2 | No |
| `04-slack-ingestion` | 2 | No |
| `05-daily-ceo-brief` | 4 | Internal Slack only |
| `06-end-of-day-brief` | 5 | Internal Slack only |
| `07-followup-engine` | 5 | No — prepares drafts |
| `08-email-drafting` | 6 | No — creates Outlook drafts |
| `09-meeting-prep` | 4 | Internal Slack only |
| `10-business-signals` | 9 | No |

`EXTERNAL_SENDING_ENABLED` is the master gate and defaults to false. While it is
false, nothing leaves the building regardless of what any workflow or approval
class says.

## Idempotency

Every ingestion workflow must be safe to re-run over the same window. The
mechanism is `events (source_system, source_external_id)`, which carries a unique
index. Re-processing is a no-op, not a duplicate.

Source-specific identity keys:

| Source | Key | Why |
|---|---|---|
| Outlook | `internetMessageId` | Stable across mailboxes; Graph's `id` is not |
| Zoom | meeting **UUID** | The meeting *number* is shared by every occurrence of a recurring meeting |
| Zoom action item | `stepId` from the task link | Stable per action item; survives re-ingestion |
| Slack | `channel:ts` | `ts` alone repeats across channels |
| Signals | `source:type:area:window` | Keeps a persistent condition as one updating record |

## Failure behaviour

Every run writes a `workflow_runs` row. On failure the run is recorded with the
error and retried with backoff. An event is **never** silently dropped — the
worst acceptable outcome is `needs_review`.
