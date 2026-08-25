# Morning sync runbook

Followed by the scheduled session that refreshes the Command Center each
weekday morning. Everything here is version-controlled deliberately: the
Routine's prompt should stay short and point at this file, so the procedure can
be corrected with a commit rather than by editing a trigger.

**Artifact to update:**
`https://claude.ai/code/artifact/4c3d6d3d-8fdf-46ec-8cdb-51a90015e4a1`

---

## Prerequisite: the Routine needs connectors attached

**A scheduled session does not inherit connectors from the session that created
the Routine.** This was verified by test-firing: the fired session ran with no
`mcp__*` tools at all and correctly stopped without publishing.

Passing connectors programmatically is not available for this organization
(`create_trigger` rejects the `connectors` parameter), so they must be attached
**from the claude.ai Routines UI**: open the Routine, add Outlook (ms365), Slack
and Zoom, then enable it.

Until that is done the Routine stays disabled. A daily job that cannot read
anything is worse than no job — it produces a notification every morning that
means nothing, which is exactly the noise this system exists to remove.

---

## Hard rules

1. **Send nothing.** Every connector call is a read. Never
   `slack_send_message`, `outlook_send_mail`, `outlook_send_draft`, or any
   write tool. If a step seems to need one, stop and report instead.
2. **Never lose the human's corrections.** The page saves versions of itself.
   Always merge viewer state before republishing (step 6).
3. **Update in place.** Pass the artifact `url` when publishing. Publishing
   without it creates a *second* artifact and the user loses their link.
4. **Report honestly.** A connector that failed is reported as failed. Never
   fill a gap with plausible-looking content.

---

## 1. Prepare the repo

```bash
cd ~/commandcenter 2>/dev/null || git clone <repo> ~/commandcenter && cd ~/commandcenter
git checkout claude/120life-ai-os-architecture-dtderh && git pull
npm install --silent
```

## 2. Pull the sources

Cover since the previous run — Monday's run should cover the weekend.

- **Outlook** — `outlook_email_search`, folder `Inbox`, `order: newest`,
  `limit: 25`. Also `folderName: "Sent Items"` for commitments we made.
- **Zoom** — `search_meetings` over the window, then `get_meeting_assets` for
  each with `has_summary: true`. Use the **UUID**, never the meeting number.
- **Slack** — `slack_search_public_and_private`,
  `query: "after:YYYY-MM-DD"`, `sort: timestamp`, `limit: 20`.

If a source fails, carry on with the others and record it under `problems`.

## 3. Interpret

For each event that is plainly business correspondence, produce an
`EventInterpretation` following `prompts/email-classification/system.md`.

The two instructions that matter most:

- **Most messages are not tasks.** Receipts, payouts, newsletters,
  acknowledgements that close an exchange — none of these create work. A system
  that manufactures tasks is abandoned within a week.
- **Attribution is evidence, not instruction.** Record what the source claimed;
  let the engine decide ownership.

Be honest about `materiality` and `confidence`. Inflating either is how the
brief becomes worthless.

## 4. Build the pull file and run the sync

Write `dist/pull-YYYY-MM-DD.json` in the shape documented at the top of
`scripts/sync.ts`, then:

```bash
npx tsx scripts/sync.ts dist/pull-YYYY-MM-DD.json --out dist/state.json
```

Sanity-check the printed summary. A kept-rate near 100% means triage is not
working; near 0% means it is too aggressive.

## 5. Rebuild

```bash
npx tsx scripts/build-browser-engine.ts
npx tsx scripts/build-ui.ts
```

## 6. Merge viewer state, then publish

**Do this before publishing, every time.**

Read the live artifact, extract its `<script id="cc-state">` block, and write it
to `dist/viewer-state.json`. The build embeds it, so corrections and dismissals
survive. Then rebuild and publish with the `url` above.

If the publish is refused because a newer version exists, that means the human
edited the page since. Read the saved copy the refusal names, take its
`cc-state`, and republish. Never force.

## 7. Report

Post nothing externally. Reply in-session with:

- how many messages were seen and kept
- how many tasks, and how many need the CEO
- anything genuinely new since yesterday
- any connector that failed, named plainly
- newly discovered people, who enter as `discovered` and own nothing

If nothing material happened, say exactly that in one line. A daily ritual that
manufactures content to justify itself stops being read.

## 8. Commit config changes only

If new people or aliases were discovered, commit `config/` changes with a clear
message. **Never commit `dist/`** — it holds real company mail and is
gitignored.
