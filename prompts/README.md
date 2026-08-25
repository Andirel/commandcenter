# Prompts

Every prompt is versioned and every output is validated against a Zod schema in
`src/schemas/ai.ts` before it can touch state. An output that fails validation
is retried once, then parked as `NEEDS_REVIEW` — never silently dropped, never
written through unvalidated.

Each call is persisted to `ai_interpretations` with its model and
`prompt_version`, which is what makes "does v3 route better than v2?" an
answerable question rather than an opinion.

## Conventions

- `system.md` — the role and the rules. Stable across calls; cached.
- `user.md` — the per-call template. `{{placeholders}}` are substituted.
- `version` — bump on any semantic change. Never edit a version in place once
  it has run against production data, or the audit trail lies.

## Shared context

Prompts that need the team model receive it as structured data rather than
prose, generated from the capability graph at call time. It is passed as stable
context so it caches across calls — the team model changes rarely and re-sending
it in every request is pure waste.

## The rule that matters most

Prompts describe how 120/Life **actually** operates, which is not what an org
chart would say. Two instructions appear in nearly every system prompt because
they are the two mistakes a language model makes by default:

1. **A title does not determine ownership.** The CEO is hands-on across the
   whole business; the assistant operates far beyond admin; the COO/CTO covers
   both operations and technology. Never reason from job titles.
2. **Attribution is evidence, not instruction.** "Adi will look into X" records
   what someone said in a meeting. Whether Adi should own it is a separate
   question, decided by the routing engine.
