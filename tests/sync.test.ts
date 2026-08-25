/**
 * The sync orchestrator.
 *
 * Tests the loop end to end over canonical events, with interpretation mocked,
 * so the interactions between triage, dedup, routing and scoring are exercised
 * together rather than in isolation.
 */
import { describe, expect, it } from 'vitest';
import { runSync } from '../src/sync/run.js';
import { CommandCenterState } from '../src/sync/state.js';
import { MockClient } from '../src/ai/client.js';
import type { StageContext, InterpretationRecord } from '../src/ai/stages.js';
import { CanonicalEvent } from '../src/schemas/events.js';
import { config, team } from './helpers.js';

const NOW = new Date('2026-08-25T12:00:00Z');

function event(over: Record<string, unknown> = {}) {
  return CanonicalEvent.parse({
    eventType: 'email_received',
    occurredAt: '2026-08-25T09:00:00.000Z',
    sourceSystem: 'outlook',
    sourceExternalId: 'evt-1',
    actor: { email: 'buyer@retailerexample.com', name: 'A Buyer', role: 'from' },
    subject: 'Vendor onboarding packet',
    summary: 'Please complete the attached vendor form.',
    threadId: 'thr-1',
    ...over,
  });
}

function interpretation(over: Record<string, unknown> = {}) {
  return {
    summary: 'Retailer needs the vendor form returned.',
    businessArea: 'retail', materiality: 'moderate',
    createsTask: true,
    taskTitle: 'Return the retailer vendor onboarding form',
    taskDescription: 'New vendor setup paperwork.',
    requiredCapabilities: ['administration'],
    deadline: null, valueAtStake: null,
    priorityHints: { impact: 3, urgency: 3, risk: 0, effort: 2 },
    flags: { isAdministrative: true },
    suggestedOwnerHint: null, confidence: 0.9,
    reasoning: 'Direct request with a clear action.',
    ...over,
  };
}

/** AI stub: triage passes, interpretation is whatever the test supplies. */
function ai(byKey: Record<string, unknown>, triagePasses = true): StageContext {
  const log: InterpretationRecord[] = [];
  const client = new MockClient((req) => {
    if (req.task === 'email_triage') {
      return { worthInterpreting: triagePasses, category: 'business_correspondence', reason: 'r', confidence: 0.9 };
    }
    return byKey[req.keyHint ?? ''] ?? byKey.default ?? interpretation();
  });
  return { client, config, log };
}

describe('a clean run', () => {
  it('produces a valid state document', async () => {
    const { state } = await runSync({
      events: [event()], config, team, ai: ai({}), now: NOW,
    });
    expect(() => CommandCenterState.parse(state)).not.toThrow();
    expect(state.producedBy).toBe('api');
    expect(state.tasks).toHaveLength(1);
  });

  it('routes and ranks the task', async () => {
    const { state } = await runSync({ events: [event()], config, team, ai: ai({}), now: NOW });
    const task = state.tasks[0]!;
    expect(task.primaryOwner).toBe('Paul');
    expect(task.rank).toBe(1);
    expect(task.score).toBeGreaterThan(0);
    expect(task.routingReason).toBeTruthy();
    expect(task.interpreted).toBe(true);
  });

  it('records the triage verdict for every message seen', async () => {
    const { state } = await runSync({ events: [event()], config, team, ai: ai({}), now: NOW });
    expect(state.triage).toHaveLength(1);
    expect(state.triage[0]!.kept).toBe(true);
    expect(state.counts.mailSeen).toBe(1);
    expect(state.counts.mailKept).toBe(1);
  });
});

describe('what never reaches interpretation', () => {
  it('drops an automated sender before any model call', async () => {
    const ctx = ai({});
    const { state } = await runSync({
      events: [event({ actor: { email: 'noreply@shipping.example', role: 'from' } })],
      config, team, ai: ctx, now: NOW,
    });
    expect(state.tasks).toHaveLength(0);
    expect(state.triage[0]!.reason).toBe('automated sender');
    expect((ctx.client as MockClient).calls).toHaveLength(0);
  });

  it('drops bulk mail identified by headers', async () => {
    const ctx = ai({});
    const { state } = await runSync({
      events: [event({ metadata: { headers: { 'list-unsubscribe': '<https://x/u>' } } })],
      config, team, ai: ctx, now: NOW,
    });
    expect(state.triage[0]!.kept).toBe(false);
    expect((ctx.client as MockClient).calls).toHaveLength(0);
  });

  it('stops at triage when the model says it is not worth interpreting', async () => {
    const { state } = await runSync({ events: [event()], config, team, ai: ai({}, false), now: NOW });
    expect(state.tasks).toHaveLength(0);
    expect(state.counts.mailKept).toBe(0);
  });
});

describe('not every message is a task', () => {
  it('records an acknowledgement without creating work', async () => {
    const { state } = await runSync({
      events: [event()], config, team,
      ai: ai({ default: interpretation({ createsTask: false }) }), now: NOW,
    });
    expect(state.tasks).toHaveLength(0);
    expect(state.triage[0]!.reason).toBe('no action implied');
  });

  it('holds a low-confidence interpretation for review instead of acting', async () => {
    const { state } = await runSync({
      events: [event()], config, team,
      ai: ai({ default: interpretation({ confidence: 0.2 }) }), now: NOW,
    });
    expect(state.tasks).toHaveLength(0);
    expect(state.counts.needsReview).toBe(1);
  });
});

describe('deduplication across sources', () => {
  it('links a second report of the same incident rather than repeating it', async () => {
    // Mirrors the real case: one incident reported by the retailer's buyer and
    // by their portal. Same title, differently worded body.
    const base = {
      taskTitle: 'Correct and resubmit the AAFES ASN',
      requiredCapabilities: ['fulfillment'],
      businessArea: 'operations',
    };

    const { state } = await runSync({
      events: [
        event({ sourceExternalId: 'from-buyer', threadId: 'thr-a', subject: 'ASN error' }),
        event({ sourceExternalId: 'from-portal', threadId: 'thr-b', subject: 'ASN error',
                occurredAt: '2026-08-25T09:02:00.000Z' }),
      ],
      config, team,
      ai: ai({
        'from-buyer': interpretation({ ...base,
          taskDescription: 'The 856 file must carry a valid SCAC code rather than ShipBob. Chargebacks possible.' }),
        'from-portal': interpretation({ ...base,
          taskDescription: 'Portal notification of a pending ship exception already raised directly by the buyer.' }),
      }),
      now: NOW,
    });

    // Both records survive — merging on a guess destroys information — but the
    // second is marked so the queue can group rather than repeat.
    expect(state.tasks).toHaveLength(2);
    const linked = state.tasks.find((t) => t.possibleDuplicateOf);
    expect(linked).toBeDefined();
    expect(linked!.possibleDuplicateOf).toBe('from-buyer');
    expect(state.counts.needsReview).toBe(1);
  });
});

describe('running without any AI', () => {
  it('still routes, and says the result was metadata-only', async () => {
    const { state } = await runSync({ events: [event()], config, team, now: NOW });
    expect(state.producedBy).toBe('metadata-only');
    expect(state.tasks).toHaveLength(1);
    // The UI must be able to tell the reader how much to trust this.
    expect(state.tasks[0]!.interpreted).toBe(false);
  });
});

describe('failures are reported, not hidden', () => {
  it('records an interpretation failure as a problem', async () => {
    const log: InterpretationRecord[] = [];
    const client = new MockClient((req) =>
      req.task === 'email_triage'
        ? { worthInterpreting: true, category: 'business_correspondence', reason: 'r', confidence: 0.9 }
        : { nonsense: true });
    const { state } = await runSync({
      events: [event()], config, team, ai: { client, config, log }, now: NOW,
    });
    expect(state.tasks).toHaveLength(0);
    expect(state.problems.some((p) => p.stage === 'interpretation')).toBe(true);
  });
});

describe('CEO attention', () => {
  it('separates a decision from work the CEO must do', async () => {
    const { state } = await runSync({
      events: [event({ sourceExternalId: 'decide-1' })],
      config, team,
      ai: ai({ default: interpretation({
        taskTitle: 'Approve the October production run',
        businessArea: 'operations',
        requiredCapabilities: ['manufacturing'],
        valueAtStake: 50000,
        flags: { isApproval: true },
      }) }),
      now: NOW,
    });
    const task = state.tasks[0]!;
    expect(task.ceoRequired).toBe(true);
    expect(task.ceoActionMode).toBe('APPROVE');
    // Someone else still does the work.
    expect(task.primaryOwner).toBe('Mike');
  });
});
