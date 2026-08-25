# Routing

How the system decides who does what.

## The governing question

Not *"is this a CEO task?"* or *"what department owns this?"*, but:

> Who is genuinely best positioned to move this forward — and does this actually
> need the CEO, for what exactly?

## Pipeline

```
required capabilities  ←  interpretation + hints + business area defaults
        ↓
candidate scoring      ←  capability × workload × continuity × friction
        ↓
external partner check ←  is this owned outside the company?
        ↓
CEO involvement        ←  required at all? in what MODE?
        ↓
attribution review     ←  is the stated owner actually right?
        ↓
leverage evaluation    ←  can the coordinator absorb this?
        ↓
role assembly          ←  owner, PM, decision maker, approver, collaborators
        ↓
confidence + reason
```

## Candidate scoring

All weights live in `config/routing-rules.yaml`.

**Positive:** capability match (mean of confidence × proficiency across required
capabilities), primary-capability bonus, continuity with the initiative,
relationship ownership, recent involvement, specialist requirement.

**Negative:** workload, overdue load, handoff friction, provisional discovery
status, external status.

Two properties are deliberate:

- **Capability match averages rather than takes the best.** Someone strong in one
  required capability and absent in another is a partial fit, and the score
  should say so.
- **Keeping the current owner is preferred** unless the gain clears
  `min_gain_to_reassign`. A handoff costs context transfer and delay; it is only
  worth it when the improvement is real.

## CEO involvement

Two separate questions, and conflating them is the single most consequential
mistake available:

1. **Is the CEO required at all?** Triggered by spend above threshold, contracts
   or legal, investors, hiring, pricing or offer changes, partnership
   commitments, reputational exposure, strategic direction, or a decision in an
   area where the CEO decides.

2. **In what mode?** `DO` / `DECIDE` / `APPROVE` / `REVIEW`.

The mode depends on **who does the work**, not only on what triggered
involvement. A production slip that the COO owns costs the CEO an approval, not
a day. Reporting that as `DO` would misprice the scarcest resource in the
company.

`ceo_dependency_score` (how badly the business needs the CEO) is scored
separately from ownership (whose time it consumes).

## Attribution

Source attribution — "Adi will look into X" — is **evidence of what was said**,
not an assignment. Meeting attribution especially often reflects whoever spoke
last.

It is re-examined when the work is information gathering, document collection,
scheduling, routine vendor follow-up, status chasing, or administrative. If a
materially better-positioned owner exists, the engine overrides and says so in
the reason.

It is honoured when the work genuinely fits the attributed person.

## Hints

`config/routing-rules.yaml` carries a small number of keyword rules. They are
deliberately few and are **not a shadow org chart** — they encode genuine role
distinctions the capability graph alone gets wrong.

The most consequential is the finance split:

```
invoice, remittance, past due invoice   → invoice_payments  (accounts payable)
  but NOT if the text also mentions
  reconcile / bookkeeping / ledger      → bookkeeping
```

"Financial" is not a routing destination. Paying an invoice and reconciling the
books are different jobs done by different people, and getting this wrong sends
work to someone who cannot do it.

**Keyword matching is word-boundary aware.** Bare substring matching is unsafe
here: the keyword `edi` matches inside `Media`, which silently pulled
retailer-onboarding rules onto podcast correspondence during development.

## The leverage engine

Every task is explicitly evaluated for *can the coordinator take this off the
CEO's plate?*

| Class | Meaning |
|---|---|
| `PAUL_CAN_OWN` | End-to-end |
| `PAUL_CAN_PROJECT_MANAGE` | Specialist executes; coordinator tracks |
| `PAUL_CAN_PREPARE_FOR_ADI` | Coordinator assembles; CEO decides |
| `PAUL_CAN_FOLLOW_UP` | Coordinator chases |
| `PAUL_CAN_RESEARCH` | Coordinator gathers inputs |
| `SPECIALIST_REQUIRED` | Needs a specialist or an agency |
| `ADI_REQUIRED` | Genuinely requires the CEO personally |

Guardrails:

- **Never the owner of specialist capabilities** — manufacturing, production,
  inventory, technical, website, payments, bookkeeping, paid media, design,
  social, customer service. Tracking is fine; owning is not.
- **Never duplicate a specialist.** Proposing that the coordinator "follow up on
  the invoice" when accounts payable simply pays it adds a task and no value.
  `do_not_duplicate` blocks this explicitly.
- **Workload caps.** Past the soft cap, a stronger case is required; past the
  hard cap, the coordinator stops being proposed as owner. The leverage point is
  a person, not a queue.
- **Minimum leverage value.** A hand-off that saves fifteen minutes is not worth
  the coordination it costs.

## Confidence and refusal

Below `min_routing_confidence` the engine sets `needsReview` rather than
guessing. High-impact reassignment requires a higher bar than low-impact —
re-routing a $40k decision needs more proof than re-routing a document request.

## Evidence and learning

Capability edges strengthen with evidence, using diminishing returns so the
tenth observation moves belief far less than the second. Edges decay on a
half-life so the model tracks the company as it is now.

Manually confirmed edges accumulate evidence but are **never silently
overwritten** — a human assertion outranks an inference.

Corrections feed back as evidence. Repeated corrections of the same shape
surface a proposed rule change for human confirmation.

## Testing

`tests/routing-scenarios.test.ts` encodes the eight required scenarios. They are
run against the **real** `config/*.yaml`, so a configuration change that breaks
routing breaks the suite. That is the point.
