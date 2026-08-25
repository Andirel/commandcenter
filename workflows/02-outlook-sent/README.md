# 02 — Outlook sent

**Phase 2 · Read-only · Sends nothing**

Detects commitments in mail 120/Life sends. This is the only source that
reliably captures what the company has promised.

## Trigger

Poll the Sent Items folder every 15 minutes.

## Steps

1. Fetch sent messages since the watermark.
2. Normalize with `direction: 'sent'`.
3. Extract commitments (`prompts/commitment-extraction`), in both directions:
   - a promise made by us → `we_owe`
   - a request made of someone else → `they_owe`, and the clock starts
4. Resolve the counterparty person and organization.
5. Set the follow-up owner from `config/followup-rules.yaml` resolution order —
   which is frequently **not** the person who sent the mail.
6. Persist commitments and link them to any related task.

## Worked example

> The CEO asks a podcast partner for pricing.

- Commitment: `they_owe`, counterparty = the partner organization
- Relationship owner: the CEO
- Follow-up tracker: the coordinator (per the organization's execution tracker)
- Task status: `waiting_external`

The system will later chase the item **through the tracker**, and prepare a draft
for the relationship owner. It never writes as the CEO.

## Credentials

`Mail.Read` scoped to Sent Items.

## What it must not do

Treat every question as a commitment. An implied obligation is recorded with
`explicit: false` and chased more gently — chasing an outside party for something
they never agreed to costs the relationship for no gain.
