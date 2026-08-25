/**
 * Zoom normalization, pinned against a REAL 120/Life meeting summary.
 *
 * The fixture in tests/fixtures/zoom-meeting-assets.json is an actual response
 * from the installed Zoom connector (the Aug 2026 biweekly board meeting), with
 * the transcript and personal notes stripped. Testing against synthetic
 * markdown would prove nothing about the format we actually receive.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeZoomAssets, parseZoomSummaryMarkdown, type ZoomMeetingAssets,
} from '../src/normalization/zoom.js';
import { resolveParticipant } from '../src/people/resolve.js';
import { config, team } from './helpers.js';

const assets = JSON.parse(
  readFileSync(new URL('./fixtures/zoom-meeting-assets.json', import.meta.url), 'utf8'),
) as ZoomMeetingAssets;

describe('parsing the real AI Companion summary', () => {
  const { meeting, event, parsed } = normalizeZoomAssets(assets);

  it('extracts the quick recap', () => {
    expect(parsed.quickRecap).toBeTruthy();
    expect(parsed.quickRecap).toContain('return to profitability');
  });

  it('extracts every action item', () => {
    expect(parsed.actionItems).toHaveLength(15);
  });

  it('gives every action item a stable, unique step id', () => {
    const ids = parsed.actionItems.map((a) => a.stepId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('strips the trailing Zoom task link out of the action text', () => {
    expect(parsed.actionItems.some((a) => a.text.includes('http'))).toBe(false);
    expect(parsed.actionItems.some((a) => a.text.includes('tasks.zoom.us'))).toBe(false);
  });

  it('captures the topical sections for later context retrieval', () => {
    expect(parsed.topics.map((t) => t.title)).toContain('Heavy Metal Testing Legal Issues');
    expect(parsed.topics.length).toBeGreaterThanOrEqual(5);
  });

  it('preserves the original summary verbatim on the meeting record', () => {
    expect(meeting.summaryOriginal).toBe(assets.meeting_summary?.summary_markdown);
    expect(meeting.originalNextSteps).toHaveLength(15);
  });

  it('keys the event on the meeting UUID, not the reusable meeting number', () => {
    // The biweekly meeting reuses one meeting number across years; keying on it
    // would collapse every occurrence into a single event.
    expect(event.sourceExternalId).toBe(assets.meeting_uuid);
    expect(event.sourceExternalId).not.toBe(String(assets.meeting_number));
  });
});

describe('attribution parsing', () => {
  const { parsed } = normalizeZoomAssets(assets);

  it('attributes items under a person heading to that person', () => {
    const item = parsed.actionItems.find((a) => a.text.startsWith('Conduct taste testing'));
    expect(item?.attributedNames).toEqual(['Michaelhammersley']);
  });

  it('does not invent a person called "Collaboration"', () => {
    const names = new Set(parsed.actionItems.flatMap((a) => a.attributedNames));
    expect(names.has('Collaboration')).toBe(false);
  });

  it('splits an inline joint attribution into both people', () => {
    const item = parsed.actionItems.find((a) => a.text.startsWith('Monitor the performance'));
    expect(item?.section).toBe('Collaboration');
    expect(item?.attributedNames).toEqual(['Adi', 'Michaelhammersley']);
  });

  it('drops group placeholders like "Team" from attribution', () => {
    // The source bullet reads "Adi & Team: Consider and explore new sales..."
    const item = parsed.actionItems.find((a) => a.text.startsWith('Consider and explore new sales'));
    expect(item?.attributedNames).toEqual(['Adi']);
  });
});

describe('resolving Zoom display names to configured people', () => {
  const cases: Array<[string, string]> = [
    ['Adi Malik', 'adi'],
    ['Michaelhammersley', 'mike'],
    ['michaelhammersley', 'mike'],
    ['Susan Schachter', 'susan'],
    ['Ira Antelis', 'ira'],
    ['Chase Dinning', 'chase'],
    // Zoom appends a disambiguation suffix to duplicate participants.
    ['Brian Ouellette (2)', 'brian'],
    ['Paul', 'paul'],
  ];

  for (const [displayName, expectedSlug] of cases) {
    it(`resolves "${displayName}" to ${expectedSlug}`, () => {
      const resolution = resolveParticipant(
        { name: displayName, email: null, slackUserId: null, zoomIdentity: null, role: 'attendee', personId: null },
        team,
        config.organizations,
      );
      expect(resolution.person?.slug).toBe(expectedSlug);
      expect(resolution.method).toBe('alias');
    });
  }

  it('treats a genuinely unknown attendee as new rather than guessing', () => {
    const resolution = resolveParticipant(
      { name: 'Nimit Aggarwal', email: null, slackUserId: null, zoomIdentity: null, role: 'attendee', personId: null },
      team,
      config.organizations,
    );
    expect(resolution.person).toBeNull();
    expect(resolution.isNew).toBe(true);
  });
});

describe('parser robustness', () => {
  it('returns empty structure for an empty summary rather than throwing', () => {
    const parsed = parseZoomSummaryMarkdown('');
    expect(parsed.actionItems).toEqual([]);
    expect(parsed.quickRecap).toBeNull();
  });

  it('handles a summary with no Next steps section', () => {
    const parsed = parseZoomSummaryMarkdown('## Quick recap\n\nShort meeting.\n');
    expect(parsed.quickRecap).toBe('Short meeting.');
    expect(parsed.actionItems).toEqual([]);
  });

  it('keeps an action item that has no task link', () => {
    const parsed = parseZoomSummaryMarkdown('## Next steps\n\n### Paul\n\n- Chase the missing COA.\n');
    expect(parsed.actionItems).toHaveLength(1);
    expect(parsed.actionItems[0]!.text).toBe('Chase the missing COA.');
    expect(parsed.actionItems[0]!.stepId).toBeNull();
  });
});
