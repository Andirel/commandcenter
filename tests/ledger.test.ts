/**
 * Memory: carry-forward, completion and the delta.
 *
 * These tests exist because of one failure mode that is invisible in a single
 * run and fatal over a month — the queue that only grows. Every case below is
 * a two-or-three-sync sequence, because nothing here is observable in one.
 */
import { describe, expect, it } from 'vitest';
import { runSync } from '../src/sync/run.js';
import { MockClient } from '../src/ai/client.js';
import type { StageContext, InterpretationRecord } from '../src/ai/stages.js';
import { CanonicalEvent } from '../src/schemas/events.js';
import type { Ledger } from '../src/ledger/types.js';
import { applyViewerAnswers } from '../src/ledger/reconcile.js';
import { config, team } from './helpers.js';

const DAY1 = new Date('2026-08-10T12:00:00Z');
const DAY2 = new Date('2026-08-11T12:00:00Z');

function event(over: Record<string, unknown> = {}) {
  return CanonicalEvent.parse({
    eventType: 'email_received',
    occurredAt: '2026-08-10T09:00:00.000Z',
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

function ai(byKey: Record<string, unknown> = {}): StageContext {
  const log: InterpretationRecord[] = [];
  const client = new MockClient((req) => {
    if (req.task === 'email_triage') {
      return { worthInterpreting: true, category: 'business_correspondence', reason: 'r', confidence: 0.9 };
    }
    return byKey[req.keyHint ?? ''] ?? byKey.default ?? interpretation();
  });
  return { client, config, log };
}

/** Run a sequence of syncs, threading the ledger through as the script does. */
async function sequence(runs: Array<{ events: CanonicalEvent[]; now: Date; ai?: StageContext; commitments?: unknown[] }>) {
  let ledger: Ledger | undefined;
  const states = [];
  for (const run of runs) {
    const out = await runSync({
      events: run.events, config, team, now: run.now,
      ai: run.ai ?? ai(),
      commitments: (run.commitments ?? []) as never,
      ...(ledger ? { ledger } : {}),
    });
    ledger = out.ledger;
    states.push(out.state);
  }
  return { states, ledger: ledger! };
}

describe('the first run', () => {
  it('reports no delta, because there is nothing to compare against', async () => {
    const { states } = await sequence([{ events: [event()], now: DAY1 }]);
    expect(states[0]!.delta).toBeNull();
    expect(states[0]!.tasks[0]!.isNew).toBe(true);
    expect(states[0]!.tasks[0]!.seenCount).toBe(1);
  });
});

describe('running twice over the same window', () => {
  it('does not create the task a second time', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [event()], now: DAY2 },
    ]);
    expect(states[1]!.tasks).toHaveLength(1);
  });

  it('reports nothing as new the second time', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [event()], now: DAY2 },
    ]);
    expect(states[1]!.delta!.added).toHaveLength(0);
    expect(states[1]!.tasks[0]!.isNew).toBe(false);
    expect(states[1]!.tasks[0]!.seenCount).toBe(2);
  });
});

describe('work outliving the window it came from', () => {
  it('carries a task forward when its source event is no longer in view', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [], now: DAY2 },
    ]);
    expect(states[1]!.tasks).toHaveLength(1);
    expect(states[1]!.counts.carriedForward).toBe(1);
  });

  it('re-ranks carried work against today, not against the day it arrived', async () => {
    // A deadline four days out on day one is three days out on day two, and
    // urgency must reflect that or the queue is frozen at the moment of intake.
    const withDeadline = ai({ default: interpretation({ deadline: '2026-08-14T00:00:00.000Z' }) });
    const { states } = await sequence([
      { events: [event()], now: DAY1, ai: withDeadline },
      { events: [], now: new Date('2026-08-13T12:00:00Z') },
    ]);
    expect(states[1]!.tasks[0]!.score).toBeGreaterThan(states[0]!.tasks[0]!.score);
  });

  it('counts the days of silence in business days', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [], now: new Date('2026-08-17T12:00:00Z') },
    ]);
    // 10 Aug 2026 is a Monday; the 17th is the following Monday.
    expect(states[1]!.tasks[0]!.daysSilent).toBe(5);
  });
});

describe('a reply on the same thread', () => {
  it('attaches to the work it continues rather than becoming a second copy', async () => {
    const reply = event({
      sourceExternalId: 'evt-2',
      occurredAt: '2026-08-11T09:00:00.000Z',
      subject: 'RE: Vendor onboarding packet',
      summary: 'Any update on the form?',
      threadId: 'thr-1',
    });
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [reply], now: DAY2 },
    ]);
    expect(states[1]!.tasks).toHaveLength(1);
    expect(states[1]!.tasks[0]!.seenCount).toBe(2);
  });

  it('keeps the routing decided when there was context to decide it', async () => {
    // "Any update?" carries almost no signal. Re-routing on it would let the
    // thinnest message in a thread overwrite the richest.
    const thin = ai({ default: interpretation({
      taskTitle: 'Any update on the form?', requiredCapabilities: [], businessArea: null,
    }) });
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [event({ sourceExternalId: 'evt-2', subject: 'RE: Vendor onboarding packet' })], now: DAY2, ai: thin },
    ]);
    expect(states[1]!.tasks[0]!.title).toBe('Return the retailer vendor onboarding form');
    expect(states[1]!.tasks[0]!.primaryOwner).toBe(states[0]!.tasks[0]!.primaryOwner);
  });
});

describe('closing the loop', () => {
  const done = event({
    sourceExternalId: 'evt-done',
    occurredAt: '2026-08-11T09:00:00.000Z',
    subject: 'RE: Vendor onboarding packet',
    summary: 'The vendor onboarding form has been submitted. All set.',
    threadId: 'thr-1',
  });

  it('completes a task on evidence rather than waiting for a checkbox', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [done], now: DAY2 },
    ]);
    expect(states[1]!.delta!.completed).toHaveLength(1);
    expect(states[1]!.tasks).toHaveLength(0);
  });

  it('records the evidence that closed it, so a wrong close can be traced', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [done], now: DAY2 },
    ]);
    const closed = states[1]!.delta!.completed[0]!;
    expect(closed.evidence).toContain('submitted');
    expect(closed.confidence).toBeGreaterThan(0.8);
  });

  it('does not also create a task out of the news that the work is finished', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [done], now: DAY2 },
    ]);
    expect(states[1]!.delta!.added).toHaveLength(0);
  });

  it('stays closed when the same evidence is still in the window tomorrow', async () => {
    // The closing email sits in a seven-day window for a week. Re-opening on it
    // would make completion last exactly one day.
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [done], now: DAY2 },
      { events: [done], now: new Date('2026-08-12T12:00:00Z') },
    ]);
    expect(states[2]!.tasks).toHaveLength(0);
    expect(states[2]!.delta!.completed).toHaveLength(0);
  });

  it('refuses to close a consequential item on inference alone', async () => {
    // A $40k commitment closed wrongly disappears along with the money. The
    // evidence still gets surfaced — as a question.
    const big = ai({ default: interpretation({
      valueAtStake: 40000,
      priorityHints: { impact: 5, urgency: 3, risk: 2, effort: 3 },
      flags: { isApproval: true },
    }) });
    const { states } = await sequence([
      { events: [event()], now: DAY1, ai: big },
      { events: [done], now: DAY2, ai: big },
    ]);
    expect(states[1]!.delta!.completed).toHaveLength(0);
    expect(states[1]!.delta!.awaitingConfirmation).toHaveLength(1);
    expect(states[1]!.tasks).toHaveLength(1);
  });

  it('is not fooled by a message that denies completion', async () => {
    const notDone = event({
      sourceExternalId: 'evt-x',
      occurredAt: '2026-08-11T09:00:00.000Z',
      summary: 'The vendor form is not done yet — still waiting on legal.',
      threadId: 'thr-1',
    });
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [notDone], now: DAY2 },
    ]);
    expect(states[1]!.delta!.completed).toHaveLength(0);
    expect(states[1]!.tasks).toHaveLength(1);
  });
});

describe('what must never be read as completion', () => {
  it('the very message that asked for the work', async () => {
    // The window overlaps between runs, so Monday's request is read again on
    // Tuesday. A request containing any completion-shaped phrase would
    // otherwise close the task it opened, one day after opening it.
    const asks = event({
      sourceExternalId: 'evt-ask',
      summary: 'I have signed and sent over the NDA. Can you send the vendor form back?',
      threadId: 'thr-ask',
    });
    const { states } = await sequence([
      { events: [asks], now: DAY1 },
      { events: [asks], now: DAY2 },
    ]);
    expect(states[1]!.delta!.completed).toHaveLength(0);
    expect(states[1]!.tasks).toHaveLength(1);
  });

  it('a status list where one line is done and the rest are not', async () => {
    // Real messages read like this. Closing the whole task on the one line
    // that happens to be finished is the expensive version of being wrong.
    const progress = event({
      sourceExternalId: 'evt-progress',
      occurredAt: '2026-08-11T09:00:00.000Z',
      summary: 'Images were updated. TikTok - done. Amazon - waiting for image processing.',
      threadId: 'thr-1',
    });
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [progress], now: DAY2 },
    ]);
    expect(states[1]!.delta!.completed).toHaveLength(0);
    expect(states[1]!.delta!.awaitingConfirmation).toHaveLength(0);
  });

  it('a question about which option we want', async () => {
    const asking = event({
      sourceExternalId: 'evt-q',
      occurredAt: '2026-08-11T09:00:00.000Z',
      summary: 'I have updated our requirements. Would you like each raw material tested, or the finished product?',
      threadId: 'thr-1',
    });
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [asking], now: DAY2 },
    ]);
    expect(states[1]!.delta!.completed).toHaveLength(0);
  });
});

describe('silence', () => {
  it('never closes anything', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [], now: new Date('2026-09-20T12:00:00Z') },
    ]);
    expect(states[1]!.delta!.completed).toHaveLength(0);
  });

  it('moves long-quiet work out of the plan and asks about it once', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [], now: new Date('2026-09-20T12:00:00Z') },
      { events: [], now: new Date('2026-09-21T12:00:00Z') },
    ]);
    expect(states[1]!.delta!.quiet).toHaveLength(1);
    expect(states[1]!.tasks[0]!.status).toBe('dormant');
    // Asked ONCE. A daily "is this still live?" is the same nagging in
    // slower form.
    expect(states[2]!.delta!.quiet).toHaveLength(0);
  });

  it('brings quiet work back when it stirs, and says so', async () => {
    const later = event({
      sourceExternalId: 'evt-late',
      occurredAt: '2026-09-21T09:00:00.000Z',
      subject: 'RE: Vendor onboarding packet',
      summary: 'Picking this back up — can you resend the form?',
      threadId: 'thr-1',
    });
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [], now: new Date('2026-09-20T12:00:00Z') },
      { events: [later], now: new Date('2026-09-21T12:00:00Z') },
    ]);
    expect(states[2]!.tasks[0]!.status).toBe('open');
    expect(states[2]!.delta!.reopened).toHaveLength(1);
  });
});

describe('the delta', () => {
  it('says "since" the previous sync, not the one before that', async () => {
    const { states } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [], now: DAY2 },
      { events: [], now: new Date('2026-08-12T12:00:00Z') },
    ]);
    expect(states[2]!.delta!.since).toBe(DAY2.toISOString());
    expect(states[2]!.delta!.syncCount).toBe(2);
  });

  it('reports a genuine climb but not an ordinary shuffle', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      event({ sourceExternalId: `e${i}`, threadId: `t${i}`, subject: `Task ${i}` }));
    const byKey: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) {
      byKey[`interpret:e${i}`] = interpretation({
        taskTitle: `Task number ${i}`,
        priorityHints: { impact: 1 + (i % 5), urgency: 3, risk: 0, effort: 2 },
      });
    }
    const { states } = await sequence([
      { events: many, now: DAY1, ai: ai(byKey) },
      { events: [], now: DAY2, ai: ai(byKey) },
    ]);
    // Nothing new arrived, so no task should have leapt anywhere.
    expect(states[1]!.delta!.moved).toHaveLength(0);
  });
});

describe('follow-ups', () => {
  const commitment = {
    id: 'c1',
    description: 'Send the signed distribution agreement',
    direction: 'they_owe' as const,
    counterparty: null,
    owedBy: null,
    dueDate: '2026-08-03T00:00:00.000Z',
    businessDaysOutstanding: 5,
    followUpOwner: null,
    relationshipOwner: null,
    explicit: true,
    quote: 'I will get that over to you Monday.',
    sourceRef: 'evt-c1',
  };

  it('surfaces a commitment that has gone past its cadence', async () => {
    const { states } = await sequence([
      { events: [], now: DAY1, commitments: [commitment] },
    ]);
    expect(states[0]!.followUps).toHaveLength(1);
    expect(states[0]!.followUps[0]!.attempt).toBe(1);
    expect(states[0]!.followUps[0]!.businessDaysOverdue).toBeGreaterThan(0);
  });

  it('does not chase the same thing again the next morning', async () => {
    // This is the entire reason the engine needed memory: rebuilt from a
    // window, every commitment looks un-chased every single day.
    const { states } = await sequence([
      { events: [], now: DAY1, commitments: [commitment] },
      { events: [], now: DAY2, commitments: [commitment] },
    ]);
    expect(states[1]!.followUps).toHaveLength(0);
  });

  it('chases again once the next cadence step has passed', async () => {
    const { states } = await sequence([
      { events: [], now: DAY1, commitments: [commitment] },
      { events: [], now: new Date('2026-08-20T12:00:00Z'), commitments: [commitment] },
    ]);
    expect(states[1]!.followUps).toHaveLength(1);
    expect(states[1]!.followUps[0]!.attempt).toBe(2);
  });

  it('chases a promise that never came with a date, from when we first heard it', async () => {
    // "I will look into these hosts and follow up" is the ordinary shape of a
    // promise. Measured only against a due date it has none, so it was never
    // chased — and those are the ones nobody wrote down anywhere else.
    const undated = { ...commitment, id: 'c2', dueDate: null };
    const { states } = await sequence([
      { events: [], now: DAY1, commitments: [undated] },
      { events: [], now: new Date('2026-08-14T12:00:00Z'), commitments: [undated] },
    ]);
    expect(states[0]!.followUps).toHaveLength(0);   // heard today; nothing is late yet
    expect(states[1]!.followUps).toHaveLength(1);
    expect(states[1]!.followUps[0]!.dueDate).toBeNull();
    expect(states[1]!.followUps[0]!.businessDaysOverdue).toBe(4);
  });

  it('prepares a draft for a person rather than sending one', async () => {
    const { states } = await sequence([
      { events: [], now: DAY1, commitments: [commitment] },
    ]);
    expect(states[0]!.followUps[0]!.notification).toMatch(/draft/i);
  });
});

describe('answers given by hand', () => {
  it('close work the system was not willing to close on its own', async () => {
    const { ledger } = await sequence([{ events: [event()], now: DAY1 }]);
    const key = ledger.entries[0]!.key;

    const applied = applyViewerAnswers(ledger, {
      completed: { [key]: { at: '2026-08-11T08:00:00.000Z', by: 'confirmed' } },
    }, DAY2.toISOString());

    expect(applied.confirmed).toBe(1);
    expect(applied.ledger.entries[0]!.status).toBe('completed');
    expect(applied.ledger.entries[0]!.completion!.source).toBe('confirmed');
  });

  it('are not asked about again on the next run', async () => {
    const first = await sequence([{ events: [event()], now: DAY1 }]);
    const key = first.ledger.entries[0]!.key;
    const answered = applyViewerAnswers(first.ledger, {
      completed: { [key]: { at: '2026-08-11T08:00:00.000Z', by: 'confirmed' } },
    }, DAY2.toISOString()).ledger;

    const out = await runSync({
      events: [event()], config, team, now: DAY2, ai: ai(), ledger: answered,
    });
    expect(out.state.tasks).toHaveLength(0);
  });

  it('treat "still open" as evidence of life, so the silence clock restarts', async () => {
    const { ledger } = await sequence([
      { events: [event()], now: DAY1 },
      { events: [], now: new Date('2026-09-20T12:00:00Z') },
    ]);
    expect(ledger.entries[0]!.status).toBe('dormant');

    const applied = applyViewerAnswers(ledger, {
      stillOpen: { [ledger.entries[0]!.key]: '2026-09-21T08:00:00.000Z' },
    }, '2026-09-21T12:00:00.000Z');

    expect(applied.reopened).toBe(1);
    expect(applied.ledger.entries[0]!.status).toBe('open');
    expect(applied.ledger.entries[0]!.lastActivityAt).toBe('2026-09-21T08:00:00.000Z');
  });

  it('mark a chased commitment fulfilled when the CEO says it arrived', async () => {
    const commitment = {
      id: 'c9', description: 'Send the signed agreement', direction: 'they_owe' as const,
      counterparty: null, owedBy: null, dueDate: '2026-08-03T00:00:00.000Z',
      businessDaysOutstanding: 5, followUpOwner: null, relationshipOwner: null,
      explicit: true, quote: null, sourceRef: null,
    };
    const { ledger } = await sequence([{ events: [], now: DAY1, commitments: [commitment] }]);
    const applied = applyViewerAnswers(ledger, {
      completed: { 'commitment:c9': { at: DAY2.toISOString(), by: 'confirmed' } },
    }, DAY2.toISOString());
    expect(applied.ledger.commitments[0]!.status).toBe('fulfilled');
  });
});
