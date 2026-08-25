# 120/Life AI Operating System

An internal operational intelligence layer for 120/Life.

It reads what happens across the company — mail, meetings, Slack, financial and
marketing signals — and maintains one reconciled picture of what has been
committed, what is owed, who should do what, and what genuinely needs the CEO.

**The objective:** maximize useful business progress per unit of team attention,
especially CEO attention.

**Not the objective:** number of automations, AI calls, tasks created, emails
sent, or theoretical hours saved. A system that creates 400 tasks a week has
failed.

---

## The distinction the product exists to make

```
What Adi should personally DO
What Adi should DECIDE
What Adi should APPROVE
What Paul can EXECUTE
What Paul can PROJECT-MANAGE
What Mike should OWN
What specialists should HANDLE
What external partners OWE
What nobody should waste time on
```

"Needs Adi" spans five minutes to a full day. Every item the system surfaces
states which.

---

## Status

**Phase 1 (Foundation) — complete.** Database schema, configuration, capability
graph, routing engine, priority engine, deduplication, identity resolution,
normalization for every source, completion detection, follow-up engine, brief
composition, and the test suite.

Nothing is connected to a live system yet, and nothing can send anything
externally. See `docs/implementation-plan.md` for the ten phases and their exit
criteria.

---

## Quick start

```bash
npm install
npm run validate:config      # check config/*.yaml and referential integrity
npm test                     # 50+ tests, including the 8 required routing scenarios
npm run typecheck
```

Ask the system who should handle something:

```bash
npm run routing:explain -- "Retailer sent their new vendor setup paperwork" --area retail
npm run routing:explain -- "Past due invoice from supplier needs payment" --area finance
npm run routing:explain -- "Manufacturer says the October run may slip" --area operations --value 40000 --verbose
```

With a database configured:

```bash
npm run db:migrate
npm run db:seed
```

---

## How it works

```
EVENT → NORMALIZE → IDENTIFY → RETRIEVE CONTEXT → INTERPRET
      → MATCH STATE → ROUTE → PRIORITIZE → RECOMMEND
      → EXECUTE IF AUTHORIZED → TRACK TO COMPLETION
```

The last step is the one most systems skip. "Task created" is not the goal; *did
the business outcome occur?* is.

### Three ideas do most of the work

**1. Ownership is not one field.** Real work has a primary owner, a project
manager, a decision maker, an approver, collaborators, and often an external
counterparty. There is deliberately no `assignee` column.

**2. A capability graph, not an org chart.** 120/Life is small and
cross-functional; titles under-determine responsibility. The system reasons over
who demonstrably does what, learns from evidence, and stores *why* it believes
each thing.

**3. Attribution is evidence, not instruction.** "Adi will look into X" records
what someone said in a meeting — often just whoever spoke last. Whether Adi
should own it is a separate question.

---

## Layout

```
docs/          architecture, team model, routing, database, security, workflows,
               implementation plan
database/      ordered SQL migrations and seed data
config/        the operating rules — people, orgs, capabilities, priority weights,
               routing rules, approval classes, follow-up cadence, model routing
src/           the decision logic (TypeScript, unit-tested)
prompts/       versioned prompts with explicit output contracts
workflows/     n8n workflow definitions and per-workflow specs
tests/         including the eight required team-routing scenarios
scripts/       config validation, migration, seeding, routing explanation
```

### Where to start reading

| Question | File |
|---|---|
| What is being built, in what order? | `docs/implementation-plan.md` |
| How does the company actually operate? | `docs/team-model.md` |
| How do the pieces fit together? | `docs/architecture.md` |
| How is ownership decided? | `docs/routing.md` + `src/routing/owner-selection.ts` |
| Why is this ranked here? | `src/priority/score.ts` |
| What can it send, and when? | `docs/security.md` + `config/approval-rules.yaml` |

---

## Adding a person

Edit `config/people.yaml` (or insert a database row) and run
`npm run validate:config`. **No code change is required** — the routing engine
reads the capability graph at runtime and hard-codes no names.

Include `aliases`: meetings and chat supply display names and nothing else, so
without them a real person's action items resolve to nobody.

---

## Safety posture

- `EXTERNAL_SENDING_ENABLED` defaults to **false**. Nothing leaves the building.
- `DRAFT_CREATION_ENABLED` is a separate switch, also false.
- RED-class subjects — legal, contracts, employment, investors, health claims,
  disputes, sensitive finances — are **never** automated under any policy.
- Every AI output is schema-validated before it can touch state.
- Below a confidence gate, the system asks rather than guesses.
- The degraded mode is always *"ask a human"*, never *"act confidently on a
  guess"*.

---

## Configuration

Everything an operator should be able to change without a developer lives in
`config/*.yaml`: people and their capabilities, organizations and relationship
ownership, business areas, priority weights and compound rules, routing rules and
evidence thresholds, approval classes, follow-up cadence, and model routing.

Config is validated against Zod **and** cross-checked for referential integrity
at load. Invalid config fails at boot rather than misbehaving quietly at runtime.
