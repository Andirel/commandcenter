# 04 — Slack ingestion

**Phase 2 · Read-only · Sends nothing**

Slack carries a lot of 120/Life's internal state, and one thing no other source
provides reliably: confirmation that something is **done**.

## Scope — start narrow

Do not ingest the whole workspace. Begin with:

- messages involving the CEO, the coordinator, and the COO/CTO
- a small set of important channels (3–5, chosen deliberately)
- any message that @-mentions a tracked person
- any message carrying the tracking reaction

Widen only once precision is demonstrated on the narrow set.

## Trigger

Slack Events API → n8n webhook, with a scheduled backfill every 30 minutes for
missed events.

## Steps

1. Receive the event; verify the signing secret.
2. Normalize (`src/normalization/slack.ts`).
3. **Noise filter** — bots, join/leave, bare acknowledgements ("thanks", "👍").
   Runs before any model call and removes most channel volume.
4. Resolve the Slack user id to a person.
5. **Completion detection first.** Before treating a message as new work, check
   whether it confirms existing work is finished. "The production run is
   confirmed for Sept 14" should close a blocker, not open a task.
6. Interpret if it is not a completion signal.
7. Match, route, prioritize, persist.

## Completion is the highest-value signal here

Worked example:

> "The production run is confirmed for Sept 14."

- Matches an existing production task
- Status → completed, with the message as evidence
- The blocker it held clears
- Dependent work is re-scored, and anything that moved materially is narrated in
  the next brief

Detection requires **both** a completion phrase and topical overlap with the
candidate task. Negation is checked first — "not done yet" contains "done", and
matching that as completion would close live work.

## Credentials

Bot token with `channels:history`, `groups:history`, `im:history`, `users:read`,
`reactions:read`. `chat:write` is needed only for briefs (Phase 4+).

## What it must not do

Ingest DMs indiscriminately. Only DMs involving tracked people and business
subjects, and never as a general surveillance feed — the system exists to reduce
coordination overhead, not to monitor people.
