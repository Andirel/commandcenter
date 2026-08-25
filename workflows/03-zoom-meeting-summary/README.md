# 03 — Zoom meeting summary

**Phase 2 · Read-only · Sends nothing**

Turns AI Companion summaries into routed, tracked work. Zoom is a first-class
source of operational state at 120/Life — a great deal of commitment is made in
meetings and nowhere else.

## Source: the Zoom connector

120/Life already has the **Zoom for Claude connector** installed, so that is the
primary path. No separate Zoom app registration, no S2S OAuth credentials, and
no webhook endpoint are required.

The connector returns a **different shape** from the raw REST API, and this
matters:

| | Raw REST API | Connector (what we use) |
|---|---|---|
| Endpoint | `GET /v2/meetings/{id}/meeting_summary` | `get_meeting_assets` |
| Action items | structured `next_steps` array | markdown under `### <Name>` headings |
| Attribution | not grouped | grouped by person, plus a `Collaboration` section |
| Per-item id | none | `stepId` in a `tasks.zoom.us` link |

`src/normalization/zoom.ts` parses the connector format, verified against a real
120/Life board meeting. Three properties of the real data drive the parser:

1. Action items arrive **already attributed** under person headings.
2. `### Collaboration` is **not a person** — its bullets carry inline joint
   attribution ("Adi & Mike:"). Treating the heading as a name would invent a
   team member called "Collaboration".
3. Every bullet carries a stable `stepId`, which makes re-ingesting a meeting
   idempotent with no fuzzy matching.

The direct S2S OAuth path (`meeting:read`, `meeting_summary:read`) remains
available as a fallback and is documented in `docs/workflows.md`.

## Steps

1. `search_meetings` for the window; keep only meetings with `has_summary`.
2. `get_meeting_assets` per meeting UUID — **not** the meeting number, which is
   shared by every occurrence of a recurring meeting.
3. Parse the summary markdown; preserve the original **verbatim** on the meeting
   record.
4. Resolve attendees. Zoom supplies display names only, so this relies on the
   curated aliases in `config/people.yaml` — Zoom reports "Michaelhammersley",
   and appends a suffix to duplicates ("Brian Ouellette (2)").
5. Analyse (`prompts/meeting-analysis`) — extract decisions separately from
   action items.
6. **Re-evaluate every attribution.** This is the point of the workflow.
7. Route each action item; split by owner.
8. Deduplicate against existing tasks — meeting items very often restate
   something already tracked from Slack or email.
9. Persist meeting, attendees, decisions, and tasks.

## Attribution re-evaluation

> Zoom says: "Adi to look into sourcing a BP monitor."

Zoom is recording that someone said this. Whether the CEO should own it is a
different question. Research and sourcing legwork is coordination work; the CEO
decides once options exist. The system records the attribution as evidence and
routes on the merits.

## Credentials

The installed Zoom connector, reached through the n8n → Claude bridge. Meeting
summary availability depends on the Zoom plan and on AI Companion being enabled.

## What it must not do

Create a task per Zoom action item without deduplication. Recurring meetings
restate the same items week after week; without matching, one commitment becomes
a dozen tasks and the system becomes actively harmful.
