/**
 * Completion detection and the follow-up engine.
 *
 * Completion's asymmetry: a task wrongly left open is visible and fixable; one
 * wrongly closed disappears. Every ambiguity resolves toward staying open.
 */
import { describe, expect, it } from 'vitest';
import { detectCompletion, canAutoComplete, reconcileAssessment, needsHumanVerification } from '../src/completion/detect.js';
import { businessDaysBetween, findDueFollowUps, resolveFollowUpOwner, renderFollowUpNotification } from '../src/followup/engine.js';
import { Task } from '../src/schemas/tasks.js';
import { CanonicalEvent } from '../src/schemas/events.js';
import { config, team } from './helpers.js';

const NOW = new Date('2026-08-25T12:00:00Z');

function task(overrides: Record<string, unknown> = {}) {
  return Task.parse({
    id: 'prod', title: 'Confirm the October production run date',
    status: 'open', lastActivityAt: NOW.toISOString(), createdAt: NOW.toISOString(), ...overrides,
  });
}

function event(body: string, overrides: Record<string, unknown> = {}) {
  return CanonicalEvent.parse({
    eventType: 'slack_message', occurredAt: NOW.toISOString(), sourceSystem: 'slack',
    body, ...overrides,
  });
}

describe('completion detection', () => {
  it('detects a confirmation with a date', () => {
    const signals = detectCompletion(
      event('The October production run is confirmed for Sept 14.'),
      [task()],
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.confidence).toBeGreaterThan(0.6);
    expect(signals[0]!.evidence).toContain('confirmed');
  });

  it('does NOT treat a negated statement as completion', () => {
    // "not done yet" contains "done"; matching it would close live work.
    for (const text of [
      'The October production run is not confirmed yet.',
      'The production run date will be confirmed next week.',
      'Can you confirm the October production run date?',
      'We still need to confirm the October production run date.',
    ]) {
      expect(detectCompletion(event(text), [task()])).toHaveLength(0);
    }
  });

  it('requires topical overlap, so an unrelated "done" cannot close a task', () => {
    const signals = detectCompletion(
      event('The website banner has been shipped, all set.'),
      [task({ title: 'Chase supplier for certificate of analysis' })],
    );
    expect(signals).toHaveLength(0);
  });

  it('weights same-thread evidence above a loose topical match', () => {
    const loose = detectCompletion(event('The October production run is confirmed for Sept 14.'), [task()]);
    const threaded = detectCompletion(
      event('The October production run is confirmed for Sept 14.', { threadId: 'T1' }),
      [task({ sourceThreadId: 'T1' })],
    );
    expect(threaded[0]!.confidence).toBeGreaterThan(loose[0]!.confidence);
  });

  it('never auto-completes a task that needs human verification', () => {
    const signals = detectCompletion(
      event('Payment has been processed for the October production run.'),
      [task({ approvalClass: 'RED' })],
    );
    expect(signals[0]!.requiresHumanVerification).toBe(true);
    expect(canAutoComplete(signals[0]!, { autoCompleteConfidence: 0.5 })).toBe(false);
  });

  it('requires human verification for consequential work', () => {
    expect(needsHumanVerification(task({ approvalClass: 'RED' }))).toBe(true);
    expect(needsHumanVerification(task({ priority: { impact: 5 } }))).toBe(true);
    expect(needsHumanVerification(task({ ceoRequired: true, ceoActionMode: 'APPROVE' }))).toBe(true);
    expect(needsHumanVerification(task())).toBe(false);
  });

  it('leaves the task open when the AI disagrees with the pattern match', () => {
    const signal = { taskId: 'prod', confidence: 0.9, evidence: 'e', label: 'l', requiresHumanVerification: false };
    const result = reconcileAssessment(signal, {
      likelyComplete: false, evidence: 'The message refers to a different run.',
      confidence: 0.8, requiresHumanVerification: false,
    });
    expect(result).toBeNull();
  });

  it('takes the lower confidence when both passes agree', () => {
    const signal = { taskId: 'prod', confidence: 0.9, evidence: 'e', label: 'l', requiresHumanVerification: false };
    const result = reconcileAssessment(signal, {
      likelyComplete: true, evidence: 'Confirmed in thread.', confidence: 0.7, requiresHumanVerification: false,
    });
    expect(result?.confidence).toBe(0.7);
  });
});

describe('business day arithmetic', () => {
  it('excludes weekends so a Friday commitment is not "3 days late" on Monday', () => {
    // Friday 2026-08-21 → Monday 2026-08-24
    expect(businessDaysBetween(new Date('2026-08-21T12:00:00Z'), new Date('2026-08-24T12:00:00Z'))).toBe(1);
  });

  it('counts a full working week as five days', () => {
    expect(businessDaysBetween(new Date('2026-08-17T00:00:00Z'), new Date('2026-08-24T00:00:00Z'))).toBe(5);
  });

  it('returns zero for a future date', () => {
    expect(businessDaysBetween(new Date('2026-08-25T00:00:00Z'), new Date('2026-08-20T00:00:00Z'))).toBe(0);
  });
});

describe('follow-up engine', () => {
  const organizations = new Map(team.allOrganizations().map((o) => [o.id, o]));
  const people = new Map(team.allPeople().map((p) => [p.id, p]));
  const base = { rules: config.followupRules, now: NOW, organizations, people };

  function commitment(overrides: Record<string, unknown> = {}) {
    return {
      description: 'Revised podcast pricing',
      direction: 'they_owe' as const,
      committedByOrganizationId: 'radioactive_media',
      committedByPersonId: null,
      owedToPersonId: null,
      owedToOrganizationId: null,
      initiativeId: null, taskId: null,
      dueDate: '2026-08-14T12:00:00Z',
      status: 'open' as const,
      followUpOwnerPersonId: null,
      lastFollowedUpAt: null,
      followUpCount: 0,
      sourceEventId: null,
      confidence: 0.9,
      ...overrides,
    };
  }

  it('surfaces an external commitment once it is genuinely overdue', () => {
    const due = findDueFollowUps([commitment()], base);
    expect(due).toHaveLength(1);
    expect(due[0]!.party).toBe('external');
    expect(due[0]!.businessDaysOverdue).toBeGreaterThan(0);
  });

  it('does not chase something that is not yet due', () => {
    expect(findDueFollowUps([commitment({ dueDate: '2026-08-24T12:00:00Z' })], base)).toHaveLength(0);
  });

  it('does not chase us for our own work — that is a task, not a nudge', () => {
    expect(findDueFollowUps([commitment({ direction: 'we_owe' })], base)).toHaveLength(0);
  });

  it('stops after the configured number of attempts rather than nagging', () => {
    expect(findDueFollowUps([commitment({ followUpCount: 99 })], base)).toHaveLength(0);
  });

  it('suppresses a repeat within the quiet window', () => {
    // Measured from the LAST NUDGE, not the due date — otherwise one overdue
    // item fires every single day.
    const recent = commitment({ followUpCount: 1, lastFollowedUpAt: '2026-08-24T12:00:00Z' });
    expect(findDueFollowUps([recent], base)).toHaveLength(0);
  });

  it('assigns chasing to the execution tracker, not the relationship owner', () => {
    const owner = resolveFollowUpOwner(commitment(), base);
    expect(team.getPerson(owner!)?.slug).toBe('paul');
  });

  it('still identifies the relationship owner separately', () => {
    const due = findDueFollowUps([commitment()], base);
    expect(team.getPerson(due[0]!.relationshipOwnerPersonId!)?.slug).toBe('adi');
  });

  it('renders a notification that names a ready draft rather than sending one', () => {
    const due = findDueFollowUps([commitment()], base);
    const text = renderFollowUpNotification(due[0]!, base);
    expect(text).toContain('RadioActive Media');
    expect(text).toContain('Revised podcast pricing');
    expect(text).toContain('Adi');
    // The system never writes as another person.
    expect(text).toMatch(/draft.*is ready/i);
  });
});
