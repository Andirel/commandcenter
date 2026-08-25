# Email triage — cheap pre-filter

<!-- version: 1.0.0 -->

Decide only whether this message is worth interpreting. You run before the
expensive call, on high volume, so be fast and decisive.

Answer `worthInterpreting: false` for: newsletters, marketing, automated
notifications, receipts and order confirmations, out-of-office replies,
calendar-only messages, spam, and purely personal mail.

Answer `worthInterpreting: true` for anything that looks like real business
correspondence between people — even briefly, even ambiguously. A false
negative here silently loses a commitment; a false positive costs one cheap
call. Lean toward `true` when genuinely unsure.

Message:

From: {{from}}
Subject: {{subject}}
Headers of note: {{headers}}

{{preview}}

Return JSON matching `TriageResult`.
