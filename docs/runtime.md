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

1. **Organization discovery.** Extraction now surfaces promises from
   counterparties the config has never heard of, and those arrive with nobody
   assigned to chase them — visible and honest, but a gap. People already have
   a discovery lifecycle; organizations need the same one.
2. **Inventory and days of cover from Shopify.** The one number missing that
   can cost money within the hour — conversion is a slow dial, but stocking out
   of a SKU while paying for traffic to it is an emergency.
3. **Blended CAC on closed months.** Finaloop knows the spend and Shopify knows
   the new customers; nothing yet divides one by the other. Blended only —
   per-channel would need attribution these two connectors cannot honestly
   support.
4. **Supabase**, when the ledger outgrows a JSON file on disk.

The ledger lives at `dist/ledger.json`, which is gitignored: it holds real
company correspondence, like `dist/state.json`. Losing it loses the memory, not
the system — the next run starts over as a first sync and says so.


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

## Four views, not one long page

`Today` · `Queue` · `Numbers` · `Strategy`. Adding sections to a single page
makes it longer; separating concerns makes each one answerable at a glance.

### Today — the ordered plan

Above the plan sits one compact strip: **what changed since you last looked**.
A snapshot answers "what is true"; someone opening this every morning is asking
something narrower — "what do I need to look at that I have not already looked
at". Only a delta answers that, and only a system with memory can compute one,
which is why the strip says "first sync" rather than presenting everything as
news. Rank movement is reported only when it is real: a one-place shuffle
happens every run from ordinary score drift, and reporting it teaches the
reader that the strip is noise, which is the one thing a delta cannot afford.


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

### The ledger — the only part of the system with memory

Everything else in the loop is a pure function of a window: give it seven days
of mail and it produces a queue. Run it again tomorrow and it produces another
one, with no idea it has ever run before. Two consequences follow, both fatal
to something opened every morning:

- **Nothing can ever be finished.** A task completed yesterday is rebuilt from
  the same email today. The queue only grows, and within a few weeks it is
  ordering a list that is mostly archaeology.
- **Nothing can be compared.** *"Three new, one slipped, this has been waiting
  on Ira for nine days"* is worth more than any snapshot, and it is not
  computable from one run.

`src/ledger/` stores what survives a run — identity, status, and the rank each
item carried out of the previous sync. The queue is now the ledger, not the
window, which is also why an approaching deadline finally lifts a task that
arrived nine days ago: carried-forward work is re-scored against today's clock.

**Identity reuses `matchTask` rather than inventing a second notion of
sameness.** Two matchers would drift, and the day they disagree is the day a
task exists twice with neither copy complete.

**Completion is inferred, never assumed.** The asymmetry decides every rule:
a task wrongly left open is visible and costs a moment to dismiss; a task
wrongly closed disappears along with whatever it was worth. So inference closes
only what it is confident about *and* cheap to be wrong about. Anything
consequential — RED class, high impact, an approval the CEO owes — becomes a
question with the evidence quoted, answerable in one click.

Three things real data taught this code, each now a test:

- **A message cannot finish the work it asked for.** Windows overlap between
  runs, so Monday's request is read again on Tuesday. Without a guard, a
  request containing any completion-shaped phrase closes the task it opened,
  one day after opening it.
- **A status list is not a completion.** *"TikTok - done. Amazon - waiting for
  image processing"* closed an entire multi-marketplace task on the one line
  that happened to be finished. Any unfinished marker in a message now settles
  it: that is an update, not a completion.
- **A question about which option we want** is a decision still outstanding,
  however confident the rest of the message sounds.

**Silence never closes anything.** Work that stops appearing has usually either
been finished without anyone saying so or quietly died, and those need
different answers from the person who knows which. After fifteen business days
it moves out of the daily plan into a group that is asked about **once** — a
daily "is this still live?" is the same nagging in slower form. The list is
capped at six; thirty buttons on one page is that nagging all at once.

**Answers given by hand are the most valuable records the system holds.**
Everything else it knows is inference over evidence it happened to see; a
confirmation is the one channel where someone who actually knows tells it
whether it was right. They are folded into the ledger before the next run, so a
question already answered is never asked again. "Still open" resets the silence
clock exactly as a message would — a person saying so is the strongest evidence
of life available.

### Reading promises out of the correspondence

The follow-up engine could chase anything it was handed, and was only ever
handed commitments somebody had typed in by hand. That is exactly backwards:
the promises worth chasing are the ones nobody wrote down, made in the third
paragraph of an email on a Tuesday and forgotten by Thursday.

`src/commitments/extract.ts` reads them out of the text. Finding sentences that
sound like promises is the easy part; the value is entirely in refusing the
four things that sound identical and are not — a **request** ("can you send the
COA?"), a **suggestion** ("we should send it"), a **condition** ("if we proceed
I'll send it") and an **auto-reply** ("I will be out until the 4th"). A false
commitment produces a nudge to a real counterparty about something they never
agreed to, which costs the relationship the system exists to protect, so the
bar is high and the failure mode is silence.

**Who owes is structural, not linguistic.** Mail we sent is us promising; mail
we received is them promising; a colleague in chat is neither. Reading intent
from the words would be far less reliable. A meeting transcript yields nothing
at all — it has many speakers and the actor is only the host, so attributing
every promise in the room to them is worse than extracting nothing.

Three things real correspondence taught this code:

- **Some disqualifiers are about the message, not the sentence.** A marketing
  blast promises things in one line and carries its unsubscribe footer in
  another; an out-of-office says "I'll respond when I return" after announcing
  the absence. Judged sentence by sentence both yield a promise nobody made, so
  auto-reply and bulk-mail markers are a verdict on the whole message while
  requests and conditionals are judged line by line.
- **A promise can point at something said earlier.** *"I plan on doing that
  this week"* is real, and its description is useless alone. The referent is
  where a human reader looks: one sentence up. Taken verbatim rather than
  rewritten — a clumsy description next to the real quote is recoverable, an
  invented one is not — and dropped entirely when there is nothing to point at.
- **Boilerplate describes a business rather than promising anything.** *"As the
  platform operates across 36 languages and 180+ countries, we will utilize AI
  technology to translate."* Nobody can ever ask whether that got done, which is
  the test a commitment has to pass. The rule that catches it is deliberately
  narrow: a broader "starts with a subordinate clause" version would swallow
  *"As we discussed on Friday, I'll send it over"*, one of the commonest ways a
  real promise is phrased.

**Deduplication against hand-written entries is decided by the source, not the
wording.** A person and the extractor reading the same message in the same
direction have found the same promise, however differently they phrased it —
and two nudges to one counterparty about one promise is worse than missing it.
Direction has to be part of the test: one message routinely carries a question
we owe an answer to *and* a promise they made us, and those are two commitments.

Run against a real week with the hand-written list removed entirely, it found
two of the two entries that were genuinely promises, plus one nobody had
recorded. The two it did not find were obligations arising from questions
*asked of us* — which the pipeline already turns into tasks. That distinction
is worth keeping: a request creates work, a promise creates something to chase.

### Chasing what we are owed

`findDueFollowUps` existed from the first phase and had never run, because it
needs something a window cannot supply: how many times we have already chased,
and when. Rebuilt each morning, every commitment looks un-chased, so the engine
fires the first nudge daily — which is how a chasing tool becomes a nagging one
and gets switched off in week two. The ledger holds the counters.

It is now fed by `src/commitments/extract.ts` rather than by hand, so what it
chases is whatever people actually promised.

Memory also made a whole class of promise chaseable for the first time. **Most
real commitments carry no date.** *"I will look into these hosts and follow
up"* is the ordinary shape of one, and measured only against a due date it has
none — so precisely the promises nobody wrote down anywhere else were the ones
never chased. With no date, the clock now starts when we first heard it.

Every row says what the counterparty actually said, in their words, and names
who chases and who sends. The output is a **draft that is ready**, never a sent
message: the system contributes the noticing, which is the part that fails.

### Numbers — the funnel and the money

Three questions, in the order they constrain each other: **is traffic arriving**,
**is it converting**, and **is the money that follows worth what we spend to get
it**. Anything that does not answer one of those is not on the page.

**Conversion rate is the trap.** A weekly rate moves several tenths of a point
on noise alone, and a system that announces every wobble teaches its reader to
ignore it. So `src/signals/traffic.ts` compares two four-week blocks and
converts the gap into **standard errors** of a two-proportion difference,
reporting nothing below a three-sigma floor. On 2026-08-25 conversion read 2.07%
against a prior 1.71% — a 21% relative lift, and tempting — at **2.5 sigma**.
Within chance. The page says so in words rather than drawing an arrow.

What did clear the bar was quieter and worse: **ad spend up 23% against sessions
flat at ~4,600/week**. Spending more to reach the same number of people is a
conclusion worth a morning; a conversion wobble is not.

**Email is ranked by revenue per recipient, not by open rate.** A 51% open rate
on a flow earning $0.16 a recipient is a well-written email that does not sell.
`src/signals/email.ts` compares each flow against the **highest-volume** flow —
not the best-performing one — because the size of the prize is set by how many
people the weak flow already reaches. On real data the spread ran 35x, from
$6.54 to $0.16 per recipient, on roughly 2.8% of revenue. Flows under 50
recipients are excluded: a $40 flow to 12 people is arithmetic, not a finding.

Both feed the same signal bus as finance, so a conversion or email finding can
lift a task in Today on its own. `tests/channel-signals.test.ts` covers the
sigma floor, the volume comparison, and the zero-revenue and single-flow edges.

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
