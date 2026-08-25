/**
 * The full event loop, end to end, with mocked AI stages.
 *
 * This is the test that proves the pieces compose: an email arrives and either
 * becomes correctly-routed, correctly-scored work, or is correctly ignored.
 */
import { describe, expect, it } from 'vitest';
import { processEvent, type AiStages } from '../src/pipeline.js';
import { normalizeOutlookMessage, type GraphMessage } from '../src/normalization/outlook.js';
import { normalizeSlackMessage } from '../src/normalization/slack.js';
import { Task } from '../src/schemas/tasks.js';
import type { EventInterpretation, TriageResult } from '../src/schemas/ai.js';
import { config, team, slug } from './helpers.js';

const NOW = new Date('2026-08-25T12:00:00Z');

/** AI stages that return whatever the test dictates. */
function stages(interpretation: Partial<EventInterpretation>, triage?: Partial<TriageResult>): AiStages {
  return {
    async triage() {
      return {
        worthInterpreting: true, category: 'business_correspondence',
        reason: 'business mail', confidence: 0.9, ...triage,
      } as TriageResult;
    },
    async interpret() {
      return {
        summary: 'summary', businessArea: null, materiality: 'moderate',
        createsTask: true, taskTitle: null, taskDescription: null,
        requiredCapabilities: [], deadline: null, valueAtStake: null,
        priorityHints: null, flags: {}, suggestedOwnerHint: null,
        confidence: 0.85, reasoning: 'because',
        ...interpretation,
      } as EventInterpretation;
    },
  };
}

function email(overrides: Partial<GraphMessage> = {}) {
  return normalizeOutlookMessage(
    {
      id: 'AAM1', internetMessageId: '<msg-1@example.com>', conversationId: 'CONV1',
      subject: 'Vendor onboarding packet', bodyPreview: 'Please complete the attached vendor form.',
      from: { emailAddress: { name: 'Dana Buyer', address: 'dana@retailerexample.com' } },
      toRecipients: [{ emailAddress: { name: 'Adi Malik', address: 'adi@120life.example' } }],
      receivedDateTime: NOW.toISOString(),
      ...overrides,
    },
    { direction: 'received' },
  );
}

const deps = (ai: AiStages, openTasks: Task[] = []) => ({
  config, team, ai, openTasks, now: NOW,
});

describe('short-circuiting before any model call', () => {
  it('skips automated senders', async () => {
    const out = await processEvent(
      email({ from: { emailAddress: { name: 'Alerts', address: 'noreply@shipping.example' } } }),
      deps(stages({})),
    );
    expect(out.kind).toBe('skipped');
    if (out.kind === 'skipped') expect(out.stage).toBe('short_circuit');
  });

  it('skips bulk mail identified by headers', async () => {
    const out = await processEvent(
      email({ internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<https://x.example/u>' }] }),
      deps(stages({})),
    );
    expect(out.kind).toBe('skipped');
  });

  it('skips Slack acknowledgements', async () => {
    const event = normalizeSlackMessage({
      type: 'message', channel: 'C1', user: 'U1', text: 'thanks', ts: '1787000000.000100',
    });
    const out = await processEvent(event, deps(stages({})));
    expect(out.kind).toBe('skipped');
  });

  it('stops at triage for a newsletter that slipped through the header check', async () => {
    const out = await processEvent(
      email(),
      deps(stages({}, { worthInterpreting: false, category: 'newsletter', reason: 'marketing' })),
    );
    expect(out.kind).toBe('skipped');
    if (out.kind === 'skipped') expect(out.stage).toBe('triage');
  });
});

describe('not every email is a task', () => {
  it('records an FYI without creating work', async () => {
    const out = await processEvent(email(), deps(stages({ createsTask: false })));
    expect(out.kind).toBe('processed');
    if (out.kind === 'processed') {
      expect(out.decision).toBe('IGNORE');
      expect(out.taskDraft).toBeNull();
    }
  });

  it('sends a low-confidence interpretation to review rather than creating work', async () => {
    const out = await processEvent(
      email(),
      deps(stages({ createsTask: true, taskTitle: 'Something ambiguous', confidence: 0.3 })),
    );
    expect(out.kind).toBe('processed');
    if (out.kind === 'processed') {
      expect(out.decision).toBe('NEEDS_REVIEW');
      expect(out.taskDraft).toBeNull();
    }
  });
});

describe('a real event becoming routed work', () => {
  it('routes retailer paperwork to the coordinator and keeps the CEO out', async () => {
    const out = await processEvent(
      email(),
      deps(stages({
        createsTask: true,
        taskTitle: 'Complete retailer vendor form and onboarding packet',
        taskDescription: 'New retailer sent their new vendor setup paperwork.',
        businessArea: 'retail',
        flags: { isAdministrative: true } as EventInterpretation['flags'],
        confidence: 0.9,
      })),
    );

    expect(out.kind).toBe('processed');
    if (out.kind !== 'processed') return;

    expect(out.decision).toBe('CREATE');
    expect(slug(out.routing!.primaryOwnerPersonId)).toBe('paul');
    expect(out.routing!.ceoRequired).toBe(false);
    expect(out.taskDraft!.status).toBe('proposed');
    expect(out.taskDraft!.routingReason).toBeTruthy();
    expect(out.priorityScore).toBeGreaterThan(0);
  });

  it('carries the source thread onto the task for later matching', async () => {
    const out = await processEvent(
      email(),
      deps(stages({ createsTask: true, taskTitle: 'Complete vendor form', businessArea: 'retail', confidence: 0.9 })),
    );
    if (out.kind !== 'processed') throw new Error('expected processed');
    expect(out.taskDraft!.sourceThreadId).toBe('CONV1');
  });

  it('discovers the unknown sender without blocking', async () => {
    const out = await processEvent(
      email(),
      deps(stages({ createsTask: true, taskTitle: 'Complete vendor form', businessArea: 'retail', confidence: 0.9 })),
    );
    if (out.kind !== 'processed') throw new Error('expected processed');
    const dana = out.discovery.candidates.find((c) => c.email === 'dana@retailerexample.com');
    expect(dana).toBeDefined();
    // A stranger who has sent one email is not a confident identification.
    expect(dana!.confidence).toBeLessThan(0.8);
  });

  it('takes the lower of interpretation and routing confidence', async () => {
    const out = await processEvent(
      email(),
      deps(stages({ createsTask: true, taskTitle: 'Complete vendor form', businessArea: 'retail', confidence: 0.65 })),
    );
    if (out.kind !== 'processed') throw new Error('expected processed');
    expect(out.taskDraft!.confidence).toBeLessThanOrEqual(0.65);
  });
});

describe('matching against existing state', () => {
  it('attaches to an existing task rather than creating a duplicate', async () => {
    const existing = Task.parse({
      id: 'existing', title: 'Complete retailer vendor form and onboarding packet',
      status: 'open', sourceThreadId: 'CONV1',
      lastActivityAt: NOW.toISOString(), createdAt: NOW.toISOString(),
    });

    const out = await processEvent(
      email(),
      deps(
        stages({ createsTask: true, taskTitle: 'Complete retailer vendor form and onboarding packet', businessArea: 'retail', confidence: 0.9 }),
        [existing],
      ),
    );

    expect(out.kind).toBe('processed');
    if (out.kind !== 'processed') return;
    expect(out.decision).toBe('UPDATE_EXISTING');
    expect(out.taskDraft).toBeNull();
    expect(out.match.matchedTask?.id).toBe('existing');
  });
});

describe('patterns that are signals rather than tasks', () => {
  it('aggregates a recurring customer complaint instead of tasking it', async () => {
    const out = await processEvent(
      email(),
      deps(stages({
        createsTask: true,
        taskTitle: 'Multiple customers report confusion cancelling their subscription',
        businessArea: 'customer',
        confidence: 0.9,
      })),
    );
    expect(out.kind).toBe('signal');
    if (out.kind === 'signal') expect(out.signalHint).toBe('customer_service_pattern');
  });
});
