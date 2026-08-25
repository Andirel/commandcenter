# Security

This system reads essentially everything the company communicates. That makes
its security posture a product requirement, not an afterthought.

## Threat model

The realistic risks, in order:

1. **Credential leakage** — a token in a workflow export or a committed `.env`
   grants read access to the entire company's mail.
2. **Unintended external sending** — an automated message to a vendor, retailer
   or partner that nobody approved.
3. **Over-collection** — storing more sensitive content than the system needs.
4. **Prompt injection** — an inbound email crafted to manipulate interpretation
   or routing.
5. **Over-broad access** — a client-facing surface reading rows it should not.

## Credentials

- Secrets live in the n8n credential store or environment variables. **Never** in
  workflow JSON, and never in this repository.
- `SUPABASE_SERVICE_ROLE_KEY` is server-side only. It bypasses RLS; exposing it
  to a browser is a full database compromise.
- Microsoft Graph: request the minimum. `Mail.Read` and `Calendars.Read` for
  ingestion. **`Mail.Send` is not granted before Phase 6, and the drafting
  workflow does not need it** — creating a draft requires `Mail.ReadWrite`, not
  `Mail.Send`.
- Rotate on any team change involving access.
- `.gitignore` covers `.env`, `*.pem`, `*.key`, `service-account*.json` and
  `n8n-credentials*.json`.

## Sending controls

Defense in depth, because this is the failure that damages relationships:

1. `EXTERNAL_SENDING_ENABLED` defaults to **false**. While false, nothing leaves
   the building regardless of approval class.
2. `DRAFT_CREATION_ENABLED` is a **separate** switch, also defaulting to false.
3. Approval classes gate per-action. RED is never automated under any policy.
4. Escalation is one-directional — a RED match can never be downgraded by a
   later GREEN match.
5. The drafting workflow has no send path at all. There is no code route from
   "draft created" to "message sent".

RED covers legal, regulatory, contracts, employment, investors, health and
product claims, disputes, sensitive finances, major expenditures, and
reputationally sensitive communication.

## Data minimization

- Prefer references over copies. `raw_reference` points back to the source, which
  already has retention and access control.
- Store `bodyPreview`-scale summaries rather than full bodies where the full body
  adds nothing.
- Meeting transcripts are **not** stored — reference Zoom.
- Drive content is **not** copied — index metadata and embeddings only.
- Test fixtures are scrubbed. The Zoom fixture in `tests/fixtures/` retains the
  summary structure the parser must handle and excludes the transcript and
  personal notes.

## Prompt injection

Inbound email is untrusted input that reaches a model. Mitigations:

- Interpretation output is **schema-validated**; a model cannot emit an
  instruction the pipeline will execute, only a structured value.
- The model has no tools and no side effects. It returns data; deterministic code
  decides what happens.
- Routing is deterministic-first. A model cannot assign ownership on its own —
  it can only influence a scored decision.
- Nothing is sent externally without human approval, so a successful injection
  cannot produce an outbound message.
- Confidence gates route anomalous interpretations to human review.

The remaining exposure is a crafted email causing a *wrong task* or a *wrong
priority*. That is visible to a human in the daily brief and correctable — which
is why corrections are a first-class feature.

## Access control

- RLS is on for every table; the service role bypasses it for server-side access.
- Any future client-facing surface needs policies written **before** it ships.
- Slack briefs go to DMs and named channels, never to open channels — the daily
  brief contains commercially sensitive material.

## Audit

- Every AI call is persisted with model, prompt version, and output.
- Every routing decision stores its input snapshot and reason.
- Every priority change stores its reason.
- Every workflow run is recorded, including failures.
- Every automated action must be logged and reversible
  (`approval-rules.yaml` → `audit`).

## Personnel data

Gusto signals are consumed as **administrative** signals only — payroll run
timing, onboarding status. Compensation figures and personal employee data are
out of scope and must not be ingested. Hiring and employment matters are RED.

## Incident response

If a credential is suspected compromised:

1. Revoke it at the provider (Entra, Zoom, Slack, Supabase).
2. Set `EXTERNAL_SENDING_ENABLED=false` and `DRAFT_CREATION_ENABLED=false`.
3. Review `workflow_runs` and `ai_interpretations` for the exposure window.
4. Rotate the remaining credentials.
5. Review `routing_decisions` and `corrections` for anything acted on
   incorrectly during the window.
