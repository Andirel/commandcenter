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
