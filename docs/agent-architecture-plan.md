# Agent Architect — plan

How Command Center grows an evidence-derived agent layer without a rewrite, and
what has to be true before that layer is allowed to sound confident.

---

## 1. What already exists

Command Center is not a prototype. Before adding anything, here is what the
agent layer must build **on** rather than beside.

| Concern | Where it lives | Reuse or replace |
| --- | --- | --- |
| Who does what, learned from evidence | `src/capabilities/graph.ts`, `evidence.ts` | **Reuse.** Confidence-with-evidence is already the house rule. |
| Multi-role ownership | `src/routing/owner-selection.ts` | **Reuse.** Six roles, not one `assignee`. |
| CEO attention modes | `ActionMode` in `src/schemas/core.ts` | **Reuse.** DO / DECIDE / APPROVE / DELEGATE / FOLLOW_UP / REVIEW / AWARE. |
| Delegability | `LeverageClass` | **Reuse.** Already answers "could someone else carry this?" |
| Risk gating | `ApprovalClass` GREEN/YELLOW/RED, `src/routing/approval.ts` | **Reuse unchanged.** Agents inherit it; they do not get their own weaker model. |
| Priority | `src/priority/score.ts` + `rank.ts` | **Reuse.** |
| Clamped AI override | `src/priority/portfolio.ts` | **Reuse the pattern.** AI adjusts, deterministic scoring stays the backbone. |
| Memory across runs | `src/ledger/` | **Reuse.** This is where the history actually is. |
| Promise extraction | `src/commitments/extract.ts` | **Reuse.** Bottleneck evidence. |
| Completion inference | `src/completion/detect.ts` | **Reuse.** Cycle-time evidence. |
| Chasing cadence | `src/followup/engine.ts` | **Reuse.** Follow-up counts are bottleneck evidence. |
| Business signals | `src/signals/{finance,commerce,traffic,email,inventory}.ts` | **Reuse.** World-model inputs. |

**Nothing in the table above gets rewritten.** The agent layer adds a plane
above it; it does not re-implement people, tasks, events, routing or priority.

### The schema/runtime split

`database/migrations/` defines 24 tables across identity, events, work and
operations — including `decisions`, `routing_decisions`, `priority_history` and
`corrections`, which are exactly the richest sources §7 and §8 of the brief ask
for.

**Those tables have no rows, because there is no runtime database layer.**
The repository has `scripts/migrate.ts` and `scripts/seed.ts` and nothing else;
the live store is `dist/ledger.json` plus `dist/state.json`.

This is the single most consequential fact for this plan. The analysis pipeline
targets **the ledger**, and treats Postgres as the destination it will migrate
to — not as a source that currently holds anything.

---

## 2. Coverage, stated before anything is designed

The brief asks for roughly twelve months. Here is what exists today:

| | Available |
| --- | --- |
| Ledger syncs | **2** |
| Ledger entries (tasks) | **17** |
| Commitments | **6** |
| Normalized events | **42**, across two pull files |
| Activity range | **2026-08-24 → 2026-08-28** (4 days) |
| Meetings | 1 |
| `decisions` rows | 0 — table exists, unpopulated |
| `routing_decisions` rows | 0 — same |
| `corrections` rows | 0 — same |
| Slack | Present in one pull, not continuous |
| Sent mail | **Not captured at all** |

Four days is not an operating history. It is a snapshot.

### The coverage gate

An architecture derived from four days would be confident fiction, and this
codebase already has a rule for that shape of problem — the unclosed-books rule
refuses profit from an open month, and the traffic module refuses a conversion
finding below three sigma. The same discipline applies here:

> **The Agent Architect must compute coverage before it reasons, and must
> downgrade or refuse its own output when coverage cannot support it.**

Concretely, every proposed agent carries an evidence count, and the report
carries a coverage verdict. Below a floor, the report states plainly that it is
a *method demonstration on insufficient data* rather than a recommendation. That
verdict is computed, not written by hand, so it cannot be quietly forgotten once
the pipeline works.

This is why the build order below puts the pipeline before the backfill: a
backfill that fills a pipeline nobody has tested produces a year of unverified
clustering, and the coverage gate is what makes the eventual backfill worth
running.

---

## 3. What gets added

Seven modules under `src/agents/`, and nothing that duplicates the table in §1.

```
src/agents/
  coverage.ts     what history exists, and whether it can bear a conclusion
  patterns.ts     recurring work instances, clustered
  decisions.ts    recurring decision archetypes
  bottlenecks.ts  where work repeatedly slows, and on whom
  attention.ts    CEO burden, Paul leverage, Mike load
  leverage.ts     the explainable scoring formula for a candidate agent
  architect.ts    assemble the above into proposals and a report
  registry.ts     agent lifecycle, permissions, versions
```

### Deterministic vs model

The brief is explicit and the codebase already agrees: arithmetic is code, and
judgment is the model.

| Computed in code | Left to the model |
| --- | --- |
| frequency, waiting days, cycle time | naming a cluster |
| participant counts, handoffs | interpreting what a cluster *is* |
| CEO touch count | whether it deserves an agent or a capability |
| follow-up counts, reopen rate | reasoning about overlap and sequencing |
| leverage score from the formula | the portfolio review over candidates |

A model that can silently invent a frequency is a model that can invent an
agent. The score is a formula in `leverage.ts` with weights in YAML, exactly as
`priority-rules.yaml` works today.

### New persistence

Additive migration `0007_agents.sql`. No existing table is altered.

```
agent_proposals      the Architect's output, with lifecycle status
agents               approved and instantiated, versioned
agent_capabilities   what an agent can do, with confidence
agent_jobs           queued work, with budget and depth limits
agent_job_dependencies   DAG edges, cycle-checked
agent_results        findings, evidence, recommended actions
agent_performance    acceptance, correction rate, measured vs estimated
company_world_state  goals, constraints, assumptions, risks
opportunities / ideas / experiments
architecture_reviews the Architect's own history, so drift is visible
```

Mirrored as Zod schemas so the ledger-backed runtime can use them before the
database layer exists — the same pattern `src/sync/state.ts` already follows.

---

## 4. Agent versus capability

The brief's most important instruction is to resist proliferation. The test:

> Does this need **persistent specialized context, its own objectives, its own
> tools, and its own evaluation**? If any of those is shared with a broader
> agent, it is a capability of that agent, not an agent.

Four outcomes, and three of them are not agents:

- **standalone agent** — distinct context, tools, objectives, measurement
- **capability** — folds into a broader agent
- **deterministic workflow** — no judgment needed; code is cheaper and safer
- **not worth it** — human, external partner, or genuinely rare

`architect.ts` must populate all four buckets. A report with an empty
"not recommended" section has not done the work.

---

## 5. Safety, unchanged

Agents inherit the existing model rather than negotiating a new one.

- **`EXTERNAL_SENDING_ENABLED=false` still holds.** No agent sends externally.
- **RED stays manual.** Legal, regulatory, contracts, employment, investors,
  health claims, disputes, sensitive finances, major spend.
- **Least privilege by default.** An agent's permission set is explicit and
  enumerable; being technically able to call an API is not authorisation.
- **Recursion is bounded** — `max_depth`, `max_subjobs`, `max_runtime`, budget,
  and an allow-list of target agents. Cycles are rejected at insert.
- **Proposed ≠ active.** The Architect proposes; a human approves. Statuses:
  `proposed / approved / rejected / deferred / active / paused / retired`.

---

## 6. Build order

Adi's constraint governs: pipeline first, backfill second.

| Phase | Deliverable | Status |
| --- | --- | --- |
| A | Inspect existing architecture | done — §1, §2 |
| B | This plan | done |
| C | Coverage report | done — `src/agents/coverage.ts` |
| D | Pattern / bottleneck / attention analysis | done — `patterns.ts`, `attention.ts`, `bottlenecks.ts` |
| E | Leverage scoring + Architect + first report | done — `leverage.ts`, `architect.ts`, `scripts/agent-architecture-review.ts` |
| F | Proposal persistence and approval lifecycle | done — `0007_agents.sql`, `transition()` |
| G | Registry, jobs, results, permission and recursion primitives | done — `registry.ts` |
| H | Backfill Outlook → Zoom → Slack | after the pipeline is testable |
| I | Instantiate 3–5 approved agents | after real coverage |
| J | Critic, portfolio, experiment loop, self-review | later |

Phases C–G run against the ledger plus fixtures, and are testable without any
credential. Phase H is where credentials matter, and by then the pipeline it
feeds will have tests proving it works.

### What Phase H will need

Sent mail is the largest single gap — the commitment extractor is built to read
promises **we** made and has never been given the mailbox that contains them.
`outlook_email_search` with `folderName: 'Sent Items'` covers it; the connector
is already authorised for the account, so this is a scripted backfill rather
than an access request.

---

## 7. What the first run actually said

Run it two ways:

```
npm run agents:review              # the real ledger
npm run agents:review -- --fixture # a constructed 300-day history
```

On the real ledger the report **refuses to propose an architecture**: four days
of activity, 17 work items, two syncs, every expected source uncaptured. That is
the intended output. The coverage gate demotes the whole report to a method
demonstration and says the next useful step is backfill, not approval.

To prove the reasoning does something when the evidence exists, the same
pipeline runs against `tests/fixtures/synthetic-history.ts` — a constructed
year in which each behaviour under test has a known right answer. On that
history it produces two agents and seven deliberate non-agents:

| Candidate | Verdict | Why |
| --- | --- | --- |
| Retail buyer follow-through | **agent** | 13 instances, 13 CEO touches, none of them decisions, Paul already alongside |
| Production run coordination | **agent** | 11 instances, $660k, Mike is the sole route through |
| Retail promo calendar | capability | 92% capability overlap — folds into the buyer agent |
| Investor updates | capability | every instance is the CEO deciding; delegating relocates accountability |
| Order exception reconciliation | deterministic workflow | one person, one day, nothing at stake — code is cheaper |
| Podcast flight booking | not worth it | RadioActive Media already performs it |
| Paid media reporting | not worth it | Quartile already performs it |
| Co-packer transition | not worth it | nine instances inside eleven days of a 293-day record — an episode |
| Trademark renewal | not worth it | one occurrence is an anecdote |

Three judgments in that table are the ones worth checking, because each is a
way the analysis could have been confidently wrong:

- **Quartile scores 0.486, above the agent bar, and is still rejected.** An
  agency doing its job well produces exactly the high-frequency, low-friction
  shape that scores well. Ranking alone would have recommended rebuilding the
  supplier. The supplier test therefore runs *before* the score is consulted.
- **The co-packer burst outranks the production-run pattern that was
  accepted.** By frequency it is the strongest operational cluster in the
  record. It is rejected because all nine instances fall inside eleven days —
  the architecture must not be built around the company's worst fortnight.
- **Investor updates are never an agent at any score.** Every instance is
  `DECIDE` or `APPROVE`. Moving an approval elsewhere does not save attention,
  it relocates accountability.

`tests/agent-architect.test.ts` asserts each of these as a verdict rather than
as plumbing: 56 cases covering clustering, fragmentation, CEO burden,
coordinator leverage, specialist routing, external-partner modelling,
permissions, recursion, historical bias, and the migration's own constraints.

---

## 8. Success criterion

The milestone is met when Command Center can answer, from its own operating
record rather than from assumption:

> Which specialised agents should 120/Life have, why should each exist, what
> should it do, which human does it work with, what may it touch — and which
> proposed agents are **not** worth building?

with an honest coverage statement attached, and the discipline to say *not yet*
when the evidence cannot carry the answer.
