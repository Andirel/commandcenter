# 10 — Business signals

**Phase 9 · Read-only · Sends nothing**

Consumes conclusions from existing intelligence services and feeds them into the
priority engine.

## Principle

120/Life already has working Claude connectors for Finaloop, Klaviyo and Gusto.
**We do not rebuild them.** This workflow consumes their conclusions through the
standardized `BusinessSignal` interface.

## Sources

| Source | Signals |
|---|---|
| Finaloop → Claude | cash risk, expense anomaly, revenue trend, margin, working capital |
| Klaviyo → Claude | email performance, list health, campaign results |
| Gusto → Claude | payroll and personnel administrative signals |
| Quartile | ROAS deterioration, spend anomaly, campaign issues |
| Customer service | aggregated complaint patterns |

## Steps

1. Pull signals since the watermark.
2. Filter by materiality — severity, persistence, or value at stake.
3. Normalize to `CanonicalEvent`, keyed `source:type:area:window` so a recurring
   condition stays **one updating record** rather than thirty daily duplicates.
4. Route: the signal's `likelyPeople` is a hint, never an assignment.
5. Apply priority multipliers and compound rules.
6. Re-score affected work; write `priority_history` for material changes.

## Cross-functional reasoning is the point

A single signal is rarely interesting. The value is in combination:

```
Large production payment due within 7 days      (cash_risk)
+ inventory coverage projected below threshold  (inventory_risk)
→ the production task's priority rises on its own
→ accounts payable: payment execution
→ COO/CTO: production impact
→ CEO: the cash/production decision, if material
→ coordinator: keeps the thread moving
```

No single source can see that. `compound_rules` in
`config/priority-rules.yaml` encodes these combinations.

## Customer-service signals

Aggregate; do not escalate individual tickets. One confused customer is a
support ticket. Twenty confused customers is a website problem with an owner.

## What it must not do

Create a task per signal. A signal is an input to prioritization. It becomes a
task only when there is a specific action with a real owner.
