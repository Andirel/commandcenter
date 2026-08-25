/**
 * The AI boundary.
 *
 * The property under test: no model output can reach state without passing a
 * schema. Everything else here supports that.
 */
import { describe, expect, it } from 'vitest';
import { extractJson, interpretEvent, triage, teamContext, capabilityContext, type StageContext, type InterpretationRecord } from '../src/ai/stages.js';
import { MockClient, SessionClient, resolveTask, AiUnavailableError } from '../src/ai/client.js';
import { loadPrompt, render, placeholdersIn } from '../src/ai/prompts.js';
import { config } from './helpers.js';

function ctxWith(responder: (req: { task: string }) => unknown) {
  const log: InterpretationRecord[] = [];
  const client = new MockClient(responder as never);
  return { ctx: { client, config, log } as StageContext, client, log };
}

const VALID_INTERPRETATION = {
  summary: 'A retailer needs onboarding paperwork returned.',
  businessArea: 'retail', materiality: 'moderate',
  createsTask: true, taskTitle: 'Return the vendor form', taskDescription: null,
  requiredCapabilities: ['administration'], deadline: null, valueAtStake: null,
  priorityHints: null, flags: {}, suggestedOwnerHint: null,
  confidence: 0.9, reasoning: 'Direct request with a clear action.',
};

describe('extracting JSON from a model response', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object wrapped in prose', () => {
    // Models add commentary even when told not to. Tolerating the wrapper
    // turns a formatting quirk into a successful parse; the SCHEMA is where
    // strictness belongs.
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('is not confused by braces inside strings', () => {
    expect(extractJson('{"note":"a } brace","b":2}')).toEqual({ note: 'a } brace', b: 2 });
  });

  it('throws on an empty response rather than returning null', () => {
    expect(() => extractJson('   ')).toThrow(/empty/);
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('I could not complete that.')).toThrow(/no JSON/);
  });
});

describe('schema enforcement', () => {
  it('accepts and returns a valid interpretation', async () => {
    const { ctx } = ctxWith(() => VALID_INTERPRETATION);
    const out = await interpretEvent(ctx, { subject: 'x', body: 'y' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.taskTitle).toBe('Return the vendor form');
  });

  it('REJECTS output that violates the schema', async () => {
    // confidence out of range: exactly the kind of plausible-looking value
    // that would corrupt priority scoring if written through.
    const { ctx } = ctxWith(() => ({ ...VALID_INTERPRETATION, confidence: 4.2 }));
    const out = await interpretEvent(ctx, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('confidence');
  });

  it('rejects a missing required field', async () => {
    const { summary, ...withoutSummary } = VALID_INTERPRETATION;
    const { ctx } = ctxWith(() => withoutSummary);
    const out = await interpretEvent(ctx, {});
    expect(out.ok).toBe(false);
  });

  it('retries once, then gives up rather than looping', async () => {
    let calls = 0;
    const { ctx } = ctxWith(() => { calls++; return { garbage: true }; });
    const out = await interpretEvent(ctx, {});
    expect(out.ok).toBe(false);
    expect(calls).toBe(config.aiRouting.defaults.max_retries + 1);
  });

  it('succeeds on the retry when the first attempt was malformed', async () => {
    let calls = 0;
    const { ctx } = ctxWith(() => (++calls === 1 ? 'not json' : VALID_INTERPRETATION));
    const out = await interpretEvent(ctx, {});
    expect(out.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('the audit trail', () => {
  it('records every attempt, including the failures', async () => {
    let calls = 0;
    const { ctx, log } = ctxWith(() => (++calls === 1 ? { bad: true } : VALID_INTERPRETATION));
    await interpretEvent(ctx, {});
    expect(log).toHaveLength(2);
    expect(log[0]!.validationOk).toBe(false);
    expect(log[0]!.validationError).toBeTruthy();
    expect(log[1]!.validationOk).toBe(true);
  });

  it('stamps the prompt version so prompt changes are measurable', async () => {
    const { ctx, log } = ctxWith(() => VALID_INTERPRETATION);
    await interpretEvent(ctx, {});
    expect(log[0]!.promptVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(log[0]!.interpretationType).toBe('email_classification');
  });

  it('captures the confidence for later calibration', async () => {
    const { ctx, log } = ctxWith(() => VALID_INTERPRETATION);
    await interpretEvent(ctx, {});
    expect(log[0]!.confidence).toBe(0.9);
  });
});

describe('triage', () => {
  it('passes a decision to skip through unchanged', async () => {
    const { ctx } = ctxWith(() => ({
      worthInterpreting: false, category: 'newsletter', reason: 'bulk', confidence: 0.95,
    }));
    const out = await triage(ctx, { subject: 'Sale ends today' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.worthInterpreting).toBe(false);
  });

  it('rejects a category outside the enum', async () => {
    const { ctx } = ctxWith(() => ({
      worthInterpreting: true, category: 'vibes', reason: 'x', confidence: 0.5,
    }));
    expect((await triage(ctx, {})).ok).toBe(false);
  });
});

describe('the session client', () => {
  it('matches an answer to its event by key', async () => {
    const client = new SessionClient({ 'email_classification:evt-1': VALID_INTERPRETATION });
    const result = await client.complete({
      task: 'email_classification', keyHint: 'evt-1',
      system: '', user: 'anything', maxTokens: 100, model: 'm', promptVersion: '1.0.0',
    });
    expect(JSON.parse(result.raw).taskTitle).toBe('Return the vendor form');
  });

  it('fails loudly when an answer is missing', async () => {
    // A silent skip would be indistinguishable from "this meant nothing".
    const client = new SessionClient({});
    await expect(client.complete({
      task: 'email_classification', keyHint: 'absent',
      system: '', user: 'x', maxTokens: 100, model: 'm', promptVersion: '1.0.0',
    })).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

describe('prompt loading', () => {
  it('loads a versioned system/user pair', () => {
    const p = loadPrompt('email-classification');
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.system.length).toBeGreaterThan(200);
    expect(p.user).toContain('{{');
  });

  it('loads a single-file variant', () => {
    expect(loadPrompt('email-classification', 'triage').user).toContain('{{subject}}');
  });

  it('substitutes placeholders', () => {
    expect(render('Hi {{name}}', { name: 'Adi' })).toBe('Hi Adi');
  });

  it('marks an unresolved placeholder rather than leaving it raw', () => {
    // A prompt reaching the model still carrying {{thread_history}} produces
    // confidently wrong output; a silent blank hides that context assembly failed.
    expect(render('Context: {{missing}}', {})).toBe('Context: (none)');
    expect(render('Context: {{empty}}', { empty: '   ' })).toBe('Context: (none)');
  });

  it('serializes structured values', () => {
    expect(render('{{data}}', { data: { a: 1 } })).toContain('"a": 1');
  });

  it('reports the placeholders a template needs', () => {
    expect(placeholdersIn('{{a}} and {{b}} and {{a}}').sort()).toEqual(['a', 'b']);
  });

  it('every placeholder in the shipped prompts is supplied by the sync', () => {
    // Catches a prompt edit that adds context the pipeline never assembles.
    const supplied = new Set([
      'capabilities', 'team_context', 'thread_history', 'related_tasks',
      'from', 'to', 'date', 'subject', 'body', 'headers', 'preview',
    ]);
    for (const variant of [undefined, 'triage'] as const) {
      for (const name of placeholdersIn(loadPrompt('email-classification', variant).user)) {
        expect(supplied.has(name), `prompt needs {{${name}}} which the sync does not supply`).toBe(true);
      }
    }
  });
});

describe('prompt context helpers', () => {
  it('lists people with their primary capabilities', () => {
    const text = teamContext(config);
    expect(text).toContain('adi');
    expect(text).toContain('CEO');
    expect(text).toMatch(/peter.*invoice_payments/);
  });

  it('marks external organizations as external', () => {
    expect(teamContext(config)).toMatch(/radioactive_media.*external/);
  });

  it('lists the capability catalogue', () => {
    expect(capabilityContext(config)).toContain('bookkeeping');
  });
});

describe('model routing config', () => {
  it('resolves each task to a real model and budget', () => {
    for (const task of Object.keys(config.aiRouting.tasks)) {
      const spec = resolveTask(config.aiRouting, task);
      expect(spec.model).toBeTruthy();
      expect(spec.maxTokens).toBeGreaterThan(0);
    }
  });

  it('throws on an unknown task rather than silently defaulting', () => {
    expect(() => resolveTask(config.aiRouting, 'no_such_task')).toThrow();
  });
});
