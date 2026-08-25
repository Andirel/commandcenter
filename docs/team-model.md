# 120/Life Team Model

How the system reasons about people, organizations, and ownership.

---

## 1. The core premise

**120/Life is a small, highly cross-functional company. Do not impose a traditional corporate org chart onto it.**

Job titles are a weak signal. The system must learn how the company *actually* operates, from correspondence and behavior.

The wrong question:

> Is this a CEO task? Is this an ops task? What department owns this?

The right questions:

> Who is genuinely best positioned to move this forward?
> Does this actually need the CEO's attention — and in what mode?
> Could Paul, Mike, or a specialist advance it more efficiently?

---

## 2. Ownership is not one field

A real activity at 120/Life usually has several distinct roles. Collapsing them into a single "assignee" loses the information that matters most.

| Role | Meaning |
|---|---|
| `primary_owner` | Does the substantive work |
| `project_manager` | Tracks it, chases dependencies, ensures it doesn't fall through |
| `decision_maker` | Has authority to decide |
| `approver` | Must sign off before it proceeds |
| `collaborators` | Contribute without owning |
| `external_counterparty` | Outside organization doing or owing something |
| `waiting_on` | Who we are currently blocked by |
| `followers` | Need awareness only |

Worked example — a new RTD production run:

```
Decision maker:        Adi          (approve the spend)
Primary owner:         Mike         (production, manufacturer coordination)
Project manager:       Paul         (track dates, materials, chase dependencies)
External counterparty: Manufacturer
Finance execution:     Peter        (if payment is required)
Financial context:     Brian / Finaloop
```

One "assignee" field cannot express this. The schema therefore does not have one.

### 2.1 CEO dependency ≠ CEO ownership

This distinction is central to the product.

```
Primary owner: Mike
CEO work required: approve a $50k run — 5 minutes
CEO dependency: 5/5
```

is a completely different situation from:

```
Primary owner: Adi
CEO work required: personally draft, negotiate, and follow up — hours
CEO dependency: 5/5
```

Both "need Adi." Only one of them consumes meaningful CEO attention. The priority engine scores `ceo_dependency_score` separately from ownership, and the daily brief always states the **mode**: DO / DECIDE / APPROVE / DELEGATE / FOLLOW UP / REVIEW.

---

## 3. Current core team

This is a **starting point**, not a permanent hard-coded org chart. It lives in `config/people.yaml` and is expected to drift as evidence accumulates.

### Adi — CEO

Adi is CEO *and* deeply hands-on across essentially the entire business.

**Do not restrict Adi to "CEO tasks."** Adi may personally handle strategy, advertising decisions, podcast advertising, partnerships, retailers, negotiations, website decisions, copy, marketing, product decisions, new ideas, vendor correspondence, research and grants, financial decisions, analytics, creative review, business development, legal coordination, operational issues, special projects, follow-ups, hiring and vendor decisions, customer and offer strategy — and anything else that becomes important.

Adi remains a valid owner for work in **every** business area. The system's job is not to keep work away from Adi; it is to ensure Adi's attention goes to things that genuinely need it.

### Paul — Executive Assistant / Virtual Assistant / Project Manager

Paul is an extremely capable VA who functions well beyond traditional administrative assistance. **Treat Paul as a major operational leverage point.**

Paul can coordinate projects, track action items, research, follow up, organize information, obtain documents, communicate with vendors, coordinate schedules, gather status updates, maintain project plans, chase dependencies, prepare materials, organize Drive files, communicate internally, coordinate external parties, complete web-based business tasks, execute repeatable processes, and act as project manager across cross-functional efforts.

The pattern the system actively looks for:

```
Adi decision
  ↓
Paul execution / project management
  ↓
specialist involvement if necessary
  ↓
Paul tracks completion
  ↓
Adi re-enters only when a decision is required
```

**But do not overload Paul indiscriminately.** Weigh importance, current workload, complexity, whether specialist expertise is genuinely required, whether relationship ownership matters, and whether Paul can *coordinate* rather than personally perform.

### Mike — COO / CTO

Mike carries a broad combination of operational and technical responsibility: supply chain, production planning, new production runs, manufacturing coordination, inventory and forecasting, operational systems, logistics, fulfillment, website changes, technical implementation, ecommerce technology, integrations, technical vendors, operational troubleshooting, product execution, infrastructure.

**Do not narrowly classify Mike as "just ops" or "just tech."** He has broad operational ownership. Adi may still make the decision while Mike owns execution.

### Ira — Customer Service

Customer inquiries, issues, support trends, feedback, recurring complaints, escalation, customer-experience observations.

Customer-service activity should generate **business signals**, not a task per ticket:

```
Multiple customers report difficulty cancelling a subscription
  ↓ aggregated customer-service signal
  ↓ probable website / customer-experience task
  ↓ routed to the appropriate owner (likely Mike for implementation)
```

Do not route every customer-originated *strategic* decision to Ira merely because it surfaced in customer service.

### Peter — Accounts Payable

Vendor invoices, payment status, invoice processing, payment confirmation, A/P administration.

**Peter handles invoice and payment execution. He is not the owner of all financial analysis.**

### Brian — Bookkeeping / Weekly Financials

Bookkeeping, financial reporting, reconciliations, periodic finance work.

The distinction the system must never blur:

```
Peter    = A/P, invoice payment execution
Brian    = bookkeeping, recurring financial management, reconciliation
Finaloop = the financial system / source of financial data
Claude + Finaloop = existing financial intelligence capability
```

An invoice needing payment goes to Peter. A bookkeeping discrepancy goes to Brian. These are different people doing different jobs.

### Buster & Chase — Organic Social

Organic content, social posts, video and creative, content calendar execution, campaign ideas. They frequently work together — tasks support one primary owner **plus collaborators**, and shared work should not be forced into single-owner semantics.

### Julienne — Design

Packaging, packaging updates, product mockups, visual assets, design deliverables. Paul often coordinates; Adi often approves.

### Susan — Occasional Podcast / Interview Support

Involved **selectively** in certain podcast interviews. **Susan is not the default owner of podcast activity.** The system should learn from correspondence when she is relevant — interview prep, subject-matter participation, reviewing questions.

---

## 4. External organizations

External partners are modeled as `organizations` with individual `people` as contacts. **Never model an agency as if it were an employee.**

### Quartile — Digital Advertising Agency

Paid media across Google, Bing, and Amazon: campaign management, optimization, reporting, keyword and bid strategy, performance investigation.

```
Google ROAS falls materially
  ↓ signal generated
  ↓ Quartile owns the investigation (external execution partner)
  ↓ Adi receives a recommendation / makes the material decision
  ↓ Paul tracks the follow-up
```

### RadioActive Media — Podcast Advertising Partner

Identifies podcast opportunities, sources placements, coordinates campaigns, communicates pricing and availability, executes podcast advertising.

```
RadioActive presents a podcast opportunity
  ↓ system assembles context (historical performance, spend, fit)
  ↓ Adi decides whether it is attractive
  ↓ RadioActive executes the placement
  ↓ Paul tracks required materials and deadlines
  ↓ Susan participates if an interview requires her
```

### Manufacturers, retailers, vendors, professional services

Discovered and modeled the same way: an organization, its contacts, its capabilities, and a **relationship owner** at 120/Life.

---

## 5. The capability graph

The system reasons over capabilities, not departments. People have capabilities; **so do organizations**.

```
strategy              project_management     research
vendor_coordination   retail                 podcast_advertising
paid_media            organic_social         graphic_design
packaging             manufacturing          inventory
logistics             website                technical
finance               accounts_payable       bookkeeping
customer_service      research_grants        copywriting
analytics             operations             ...
```

Each person↔capability edge carries:

| Field | Meaning |
|---|---|
| `confidence` | How sure we are (0–1) |
| `proficiency` | How good they are at it (0–1) |
| `primary_secondary` | Core competency vs. can-help |
| `evidence_count` | How many observations support this |
| `last_evidence_at` | Recency — stale edges decay |
| `manually_confirmed` | A human asserted it; never silently overwritten |

This lets the system answer *"who is best positioned to execute this?"* instead of *"what department does this belong to?"*

---

## 6. Learning from behavior

Responsibility is **inferred from evidence and stored**, never silently mutated.

If Mike repeatedly discusses production, answers inventory questions, and coordinates manufacturers → confidence in Mike-for-manufacturing rises.

If Paul repeatedly coordinates a retailer, requests documents, follows up, and manages deadlines → the system recognizes Paul as the effective project manager for that relationship.

If a new contractor repeatedly produces Amazon images → infer likely design / ecommerce-creative capability.

Every inference writes a `responsibility_evidence` row:

```
Capability:  amazon_creative
Person:      New Team Member
Confidence:  0.86
Evidence:    7 relevant interactions over 45 days
```

**High-impact routing changes require stronger evidence than low-impact ones.** See `config/routing-rules.yaml` → `evidence_thresholds`.

---

## 7. Discovery lifecycle

New people appear constantly — in Outlook, Slack, Zoom, Calendar, Drive activity. The system profiles them without blocking on them.

```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "organization": "Example Co",
  "likely_relationship_type": "vendor",
  "likely_function": "packaging supplier",
  "evidence_count": 4,
  "confidence": 0.81
}
```

Status progression:

```
discovered  →  provisional  →  confirmed
                    ↓
                 inactive        (no activity for N days)
```

- `discovered` — seen once; cannot own anything
- `provisional` — repeated evidence; can be a collaborator or counterparty; cannot own high-impact work
- `confirmed` — human-confirmed or strong sustained evidence; can own work
- `inactive` — dormant; excluded from routing but retained for history

**A single email never grants operational authority.** And discovery never blocks processing — an unknown sender gets a provisional record and the pipeline continues.

---

## 8. Workload-aware routing

Capability alone is insufficient. Routing also weighs open task count, overdue count, urgency, existing project involvement, relationship continuity, whether a specialist is genuinely required, whether Paul can coordinate instead, and whether a handoff would create more friction than it saves.

Two failure modes to avoid, in both directions:

- Mike is *capable* of a simple vendor follow-up, but Paul is more efficient for it.
- Paul has *capacity*, but must not own a technical production decision because of it.

---

## 9. Relationship ownership

The system tracks who at 120/Life normally manages each external relationship.

```
RadioActive Media    → relationship owner: Adi;  execution tracker: Paul
A component supplier → relationship owner: Mike
```

**Do not infer relationship ownership from the most recent email sender.** Use history. Paul sending one message to a supplier on Mike's behalf does not transfer the relationship.

---

## 10. The Paul leverage engine

Every task is explicitly evaluated against: *can Paul take this off Adi's plate?*

| Classification | Meaning |
|---|---|
| `PAUL_CAN_OWN` | Paul can execute end-to-end |
| `PAUL_CAN_PROJECT_MANAGE` | Specialist executes; Paul tracks |
| `PAUL_CAN_PREPARE_FOR_ADI` | Paul assembles; Adi decides |
| `PAUL_CAN_FOLLOW_UP` | Paul chases the outstanding item |
| `PAUL_CAN_RESEARCH` | Paul gathers inputs |
| `SPECIALIST_REQUIRED` | Needs Mike / Julienne / Peter / Brian / Ira / agency |
| `ADI_REQUIRED` | Genuinely requires Adi personally |

Calibration examples:

| Situation | Classification |
|---|---|
| Retail onboarding paperwork | `PAUL_CAN_OWN` |
| Manufacturer formulation decision | `SPECIALIST_REQUIRED` (Mike) — Paul may track |
| Podcast opportunity decision | `PAUL_CAN_PREPARE_FOR_ADI` — Adi decides, Paul gathers and tracks |
| Packaging mockup | `SPECIALIST_REQUIRED` (Julienne) — Paul coordinates, Adi approves |
| Invoice payment | `SPECIALIST_REQUIRED` (Peter) — Paul should **not** duplicate it |
| Financial analysis | Brian / Finaloop provide context; Adi makes the business decision |

---

## 11. Human corrections

The system is expected to be wrong and to be told so. Supported corrections:

```
wrong owner            Paul can handle this      Mike owns this
I will handle this     not important             duplicate
wrong deadline         defer                     stop tracking
wrong interpretation
```

Each correction is stored in `corrections` as evidence, adjusts capability confidence, and — when a pattern repeats — surfaces a proposed rule change for human confirmation. The system does not silently rewrite its own rules.

---

## 12. Growth without code changes

New employees, contractors, agencies, and vendors must be absorbable through **configuration and data only**. Adding a person is a YAML edit or a database row — never a code change. The routing engine reads the capability graph at runtime; it has no hard-coded names.
