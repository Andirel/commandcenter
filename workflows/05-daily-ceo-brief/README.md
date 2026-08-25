# 05 — Daily CEO brief

**Phase 4 · Posts to internal Slack only**

The daily command center.

## Trigger

Weekday mornings, on a schedule. The portfolio review runs first, on its own
schedule (`config/priority-rules.yaml` → `portfolio_review.run_schedule`), so
the brief reads settled scores rather than racing them.

## Steps

1. Load open work with fresh scores.
2. Run the deterministic ranking.
3. Run the AI portfolio review; apply clamped adjustments.
4. Diff against yesterday's `brief_deliveries` row to compute real changes.
5. Assemble sections (`src/brief/daily.ts`).
6. Render (`src/brief/render.ts`).
7. Post to the CEO's Slack DM.
8. Persist to `brief_deliveries` — required, because tomorrow's "changed since
   yesterday" is a diff against today.

## Sections

| Section | Rule |
|---|---|
| Your highest-value actions | Top N, each with mode, why, what changed, next move |
| Decisions you need to make | **Separate from tasks.** A decision is not a to-do |
| [Coordinator] can take off your plate | Highest-leverage delegable items |
| Operations | Only material operational issues |
| Waiting on others | Grouped internal vs. external; only meaningful overdue |
| Changed since yesterday | Only material movements, with a true reason |
| Risks / Opportunities | Only material |
| Meetings today | With prep links |

## Editorial rules

- Every action states the **mode** — DO / DECIDE / APPROVE / DELEGATE /
  FOLLOW UP / REVIEW. The difference between DO and APPROVE is the difference
  between a day and five minutes.
- Empty sections are **omitted**, never printed empty. "RISKS: none" trains the
  reader to skip, and a skipped brief has failed.
- Never pad a section to reach its configured count.
- Rank changes are narrated only when material, and only with a reason drawn
  from the actual score components.

## Failure behaviour

If the portfolio review fails, send the brief with deterministic scores and note
that the portfolio pass did not run. A brief with a caveat beats no brief.
