# 08 — Email drafting

**Phase 6 · Creates Outlook drafts · NEVER sends**

## Standing constraint

This workflow creates drafts in Outlook. It has no send path. `Mail.Send` is not
required and should not be granted to it.

`EXTERNAL_SENDING_ENABLED` and `DRAFT_CREATION_ENABLED` are separate switches,
and both default to false.

## Trigger

Invoked by the follow-up engine, or on request for a specific task.

## Steps

1. Assemble context: thread history, outstanding items, relationship history.
2. Classify the approval class **before drafting**.
3. **RED → stop.** Return no draft, with the reason. Legal, regulatory,
   contracts, employment, investors, health or product claims, disputes and
   sensitive finances are never drafted.
4. Draft (`prompts/email-drafting`).
5. Create the draft in Outlook, in the correct mailbox.
6. Notify with the draft, why it exists, and the recommendation.

## Notification shape

```
RadioActive follow-up drafted.

Why: pricing overdue 4 business days.
Recommended: send today.
[link]
```

The notification states *why the draft exists*, not just that it does. A draft
with no rationale is another thing to evaluate rather than a decision made
easier.

## Drafting rules

- Never invent a fact, date, price or quantity. Missing figures become an
  explicit `[TBD: …]` marker — a fabricated number in a vendor email is a real
  commercial problem.
- Never promise something the sender has not agreed to.
- Never write as a third party. A draft for someone else's relationship is
  written **for** them.
- Match the sender's actual voice from thread history.
