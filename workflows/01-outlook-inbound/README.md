# 01 — Outlook inbound

**Phase 2 · Read-only · Sends nothing**

Interprets received mail into company state.

## Trigger

Microsoft Graph change notification (webhook) on the mailbox, with a scheduled
poll every 10 minutes as a backstop. Graph subscriptions expire and occasionally
drop notifications, so polling is not redundant — it is the actual guarantee.

## Steps

1. Fetch messages since the last successful watermark.
2. Normalize → `CanonicalEvent` (`src/normalization/outlook.ts`).
3. **Short-circuit** — automated senders, bulk headers, out-of-office. Runs
   before any model call and removes most of the volume.
4. Identify people and organizations; create provisional records for unknowns.
   Never blocks: an unknown sender does not stop processing.
5. Triage (cheap model). Stop here for newsletters and receipts.
6. Retrieve context: thread, related open tasks, outstanding commitments,
   relationship history.
7. Interpret (`prompts/email-classification`).
8. Match against existing tasks → CREATE / UPDATE_EXISTING / MERGE / IGNORE /
   NEEDS_REVIEW.
9. Route ownership.
10. Score priority; write `priority_history` if the change is material.
11. Persist. Tasks are created as `proposed`.

## Credentials

Entra app registration with `Mail.Read` and `Calendars.Read`. Application
permissions with admin consent are preferred for unattended ingestion.
`Mail.Send` is **not** required for this workflow and should not be granted.

## Failure behaviour

- Graph throttling (429) → honour `Retry-After`, resume from the watermark.
- Interpretation invalid → retry once, then `needs_review`.
- Unknown person → provisional record, continue.
- The watermark advances only on a fully successful batch, so a mid-batch
  failure re-reads rather than skips.

## What it must not do

Create a task per email. Most mail changes nothing. Precision matters more than
recall here — a system that manufactures work is abandoned faster than one that
occasionally misses something.
