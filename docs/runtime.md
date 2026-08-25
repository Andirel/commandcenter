# Runtime architecture

**This supersedes the n8n-first plan in `architecture.md` §1 for phases 1–5.**
That plan assumed we would provision credentials for each source. We don't need
to: 120/Life already has Outlook, Slack, Zoom, Drive, Finaloop, Klaviyo, Gusto,
Shopify and Notion connected to Claude. The connectors *are* the integration
layer.

## What changed, and why it matters

| | Original plan | Now |
|---|---|---|
| Auth | Entra app registration, Zoom S2S OAuth, Slack bot token | The connectors you already authorized |
| Ingestion | n8n workflows calling APIs | The page calls connectors directly, with your credentials |
| State | Supabase from day one | Embedded in the published page; Supabase when volume needs it |
| Infra to stand up | Postgres + n8n instance | None |
| Time to first use | Days | Now |

The engine is unchanged. Routing, priority, dedup and normalization are the same
TypeScript the test suite covers — `scripts/build-browser-engine.ts` compiles it
into the page, with `config/*.yaml` frozen to JSON at build time so the UI cannot
drift from committed configuration.

## The three runtimes

```
                    ┌──────────────────────────────────┐
                    │  ENGINE  (src/, 160 tests)       │
                    │  routing · priority · dedup      │
                    └───────────────┬──────────────────┘
             ┌──────────────────────┼──────────────────────┐
             ▼                      ▼                      ▼
   ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐
   │ COMMAND CENTER   │  │ CLAUDE SESSION     │  │ n8n (later)      │
   │ artifact page    │  │ this CLI / desktop │  │ unattended only  │
   │                  │  │                    │  │                  │
   │ connectors via   │  │ connectors via MCP │  │ needs its own    │
   │ mcp capability   │  │ tools directly     │  │ credentials      │
   │ opens → syncs    │  │ ad-hoc analysis    │  │ nightly brief    │
   └──────────────────┘  └────────────────────┘  └──────────────────┘
```

**The page** is the operating surface. It runs only while open, which is fine —
you open it to work.

**A Claude session** is for anything ad-hoc: "what did we commit to RadioActive
last month?" It has the same connectors and can run the engine from the repo.

**A scheduled Routine** covers the unattended case — work that must happen
while nobody is looking. `docs/morning-sync-runbook.md` is the procedure it
follows; the Routine's prompt merely points at that file, so the process is
corrected with a commit rather than by editing a trigger.

`120/Life morning sync` — weekdays 07:00 America/Chicago (`0 12 * * 1-5` UTC),
fresh session per firing, push notification on completion.

A fresh session per firing (rather than resuming one conversation) is
deliberate: a self-bound Routine accumulates context indefinitely and drifts.
Each morning starts clean and reads the runbook.

**n8n** is no longer required for any phase. It remains an option if event-driven
ingestion is ever wanted — a webhook the moment mail arrives, rather than a
scheduled sweep — but nothing currently needs it.

## Honest limits of the page runtime

- **It runs only when open.** No background ingestion, no overnight brief.
- **State lives in the published page**, not a database. Fine for tens of items;
  wrong for thousands. Supabase remains the destination — `database/migrations/`
  is ready and unchanged.
- **No model call happens in the page.** Routing runs on subject lines and
  metadata, so it is deliberately conservative: it will under-classify an email
  whose meaning is buried in the body. Full interpretation needs a Claude session
  or a server-side call, which is the next increment.
- **Corrections are local to the artifact** until exported back into
  `config/people.yaml` as evidence.

## Connector notes

`server` is the connector's **display name**. The runtime also accepts the
tool-prefix segment with underscores read as spaces, which is what the page uses
(`"Zoom for Claude"`, `"ms365"`). `listTools()` runs at boot so the UI adapts to
what actually resolved for the viewer rather than assuming.

Three shape facts learned from real responses, all handled in `ui/app.js`:

- **ms365 mail search returns concatenated JSON objects**, not an array, so
  `result.payload` arrives as raw text. The page parses the object stream.
- **The Zoom connector returns attributed markdown**, not the REST API's
  structured `next_steps`. See `src/normalization/zoom.ts`.
- **The Slack connector returns formatted text**, not structured messages:
  `{ results: "# Search Results…\n1. #channel - Author: text 2026-08-24 …" }`.

That last one shapes where Slack is used. The page **displays** recent Slack
activity but does not interpret it, and its parser falls back to showing the
text as returned — a display panel is not worth breaking the page over. Slack's
real value is interpretive (it is the only source that reliably confirms
something is *done*), and that happens in the sync run, where a session reads
it directly.

Only read tools are called. `slack_send_message` and its relatives are not in
the manifest and never will be while sending is disabled.

Every connector failure is branched on its error **code** — `needs_reauth`
prompts a reconnect, `server_not_connected` prompts adding it, `server_unavailable`
offers a retry. Collapsing these into one banner would hide the single action
that fixes the page.

## Claude for Chrome

Browser control is the execution path for systems with **no API and no
connector** — retailer portals, vendor onboarding sites, carrier dashboards.
That is exactly the work the leverage engine classifies `PAUL_CAN_OWN`.

It is not part of the read path and should not be: reading mail through a browser
when a connector exists is slower and more fragile. The natural first use is
retailer onboarding portals, once the routing on those tasks is trusted.

## What to build next, in order

1. **Interpretation.** Routing on subject lines is the biggest quality gap.
2. **Commitment extraction from Sent Items.** The waiting-on register is the
   highest-value thing the page cannot yet populate honestly.
3. **Supabase**, when the working set outgrows the page.
4. **n8n**, only for the unattended morning brief.


---

## What earns a place in the Command Center

The test for any connector is: **would seeing this change what Adi does in the
next hour?** Data that fails that test makes the page longer and less useful.

**Finaloop — yes.** Period profitability is the single most important business
fact available, and it is exactly what the board is focused on. Consumed as
conclusions (`get_profit_and_loss`), never rebuilt.

**Shopify — yes.** Order-level sales answer "what is happening now" where
Finaloop answers "did we make money". Its analytics API rate-limits, so it is
treated as optional: a missing sparkline never costs the financial headline.

**Slack — yes, for display.** The connector returns formatted text, so the page
shows it and the sync interprets it.

**Klaviyo — no.** Email marketing runs at roughly $1.5k a month against $82k of
paid ads, and the connector's tools are for building and editing campaigns
rather than answering a decision. It would be daily noise. The `BusinessSignal`
interface stays open, so a specific email signal can feed in later if one proves
decision-worthy — but a panel would not.

**Gusto — no.** Payroll administration is not a daily attention-allocation
input, and compensation data is deliberately out of scope (`docs/security.md`).

### Two bases, never mixed

Finaloop reports **booked accounting figures**; Shopify reports **order-level
activity**. They legitimately differ. Blending them produces a number that is
true on neither basis, so the panel keeps them in separate tiles.

### Two rules about when a number is true

**The partial-month rule.** The running month is always incomplete. Comparing 24
days of August against 31 of July shows a 23% sales "collapse" that is really
six missing days. Every comparison runs on a **daily rate**.

**The unclosed-books rule**, which matters more. 120/Life closes its books
monthly, by the 10th of the following month (`config/finance-rules.yaml`). Until
a month closes, its **expense** side is incomplete — bills not entered,
transactions not categorized — so any profit figure from it is fiction dressed
as fact.

This is not pedantry. On 2026-08-25 the open month read as a **$53k loss with ad
spend up 61%**. The closed months showed profit **improving to $34k** with spend
up 23%. Nearly the opposite conclusion, from the same report.

So profit and expense conclusions come **only from closed periods**, compared
against the previous closed period, and every signal names the month it is about
so "now" is never assumed. The open month appears as revenue only, labelled with
the date its books close.

One consequence worth stating: uncategorized transactions are the **normal**
state of an open month. Flagging them there would raise a false alarm every
single month, so they are only flagged once the month has closed.

Order-level Shopify data is unaffected by any of this — an order is an order the
moment it is placed — which is a further reason the two bases stay separate.

`tests/finance-signals.test.ts` defends all of it, including the boundary on the
closing day itself and across a year end.

### Signals move the queue

Signals are not decoration. They feed `config/priority-rules.yaml` →
`signal_multipliers` and `compound_rules`, which is how a cash risk coinciding
with an inventory risk raises the production task on its own. That
cross-functional lift is the reason signals exist at all.

---

## Three views, not one long page

`Today` · `Queue` · `Strategy`. Adding sections to a single page makes it
longer; separating concerns makes each one answerable at a glance.

### Today — the ordered plan

A ranked list answers *what matters most*. It does not answer *what should I do
first*, and the two differ for one reason that dominates the rest:

> **The value of unblocking someone decays through the day.**

Approving Chase's content at 09:00 buys a full day of his work. The same
approval at 16:30 buys nothing until tomorrow. So a five-minute approval that
frees a colleague outranks an hour of the CEO's own higher-scoring work in the
morning — and stops outranking it by late afternoon. `src/brief/plan.ts` encodes
that, and the tests assert the reasoning changes with the clock.

Two further rules:

- **Attention is priced by MODE, not by size.** Approving a $50k production run
  and approving a social post both cost about five minutes. Pricing by value at
  stake would make the plan wrong about the only thing it measures.
- **One strategic slot is reserved**, so the long term is never entirely crowded
  out by today.

The plan is budgeted against the hours actually left. A plan needing nine hours
at 15:00 is not a plan, and saying otherwise is how a daily tool stops being
opened.

### Strategy — proposals that become work

A proposal is a **choice put to the CEO**, not a task and not advice. Every one
cites the facts it rests on; a proposal with no basis is an opinion, and the CEO
knows his business better than the system does.

Accepting one routes its `generates` entries through **the same owner-selection
engine everything else uses**. Choosing "set a spend floor with Quartile"
produces a real decision owned by the CEO with Quartile as counterparty, and a
real investigation task — not a note to self. The chosen work then appears in
Today, ordered alongside everything else.

The proposals worth most are the ones that **convert a recurring decision into a
policy**. A standing cap on non-cancellable media commitments removes the same
decision from every future week and lets the partner filter before it reaches
the CEO. That is worth more than any single well-made decision, and is exactly
what an attention-allocation system should be looking for.
