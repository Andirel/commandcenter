# 07 — Follow-up engine

**Phase 5 · Prepares drafts · Sends nothing**

Notices when someone owes us something, and when they deliver it.

## Trigger

Daily on a schedule, plus re-evaluation whenever a relevant reply arrives.

## Steps

1. Load open commitments.
2. Compute elapsed **business days** — calendar days would make a Friday
   commitment "3 days overdue" on Monday and generate a nudge that reads as
   impatient.
3. Apply cadence from `config/followup-rules.yaml`, adjusted for importance.
4. Resolve the follow-up owner through the configured resolution order:
   organization execution tracker → task project manager → relationship owner →
   task primary owner.
5. Prepare a draft for the **relationship owner** (Phase 6).
6. Notify the follow-up owner that a draft is ready.
7. Escalate to the CEO only when genuinely material.

## The three roles

These are frequently three different people:

```
relationship owner  →  whose relationship it is
task owner          →  who does the work
follow-up owner     →  who does the chasing
```

**The system never sends a message in someone else's name.** When the CEO owns a
relationship, the coordinator is told a draft is ready, not asked to write as the
CEO.

## Resolution

A follow-up closes when the awaited thing actually arrives — detected from
replies, not assumed. Consequential commitments require human confirmation even
at high confidence: wrongly closing a $40k commitment costs far more than asking.

## Anti-nag rules

- Cap the number of follow-ups per commitment.
- Suppress repeats within the configured window.
- Measure from the last nudge, not the due date, or one overdue item fires every
  single day.
- Stale commitments go to `needs_review` — never silently dropped.
