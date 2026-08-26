/**
 * Reading promises out of correspondence.
 *
 * Nearly every test here is about something the extractor must REFUSE. Finding
 * sentences that sound like promises is easy; the value is entirely in not
 * chasing a counterparty about something they never agreed to, which costs the
 * relationship the system exists to protect.
 */
import { describe, expect, it } from 'vitest';
import { CanonicalEvent } from '../src/schemas/events.js';
import { extractCommitments, describe as describeClause, parseDue, sentences } from '../src/commitments/extract.js';
import { runSync } from '../src/sync/run.js';
import { config, team } from './helpers.js';

/** 2026-08-10 is a Monday. Every relative date below is anchored to it. */
const MONDAY = '2026-08-10T09:00:00.000Z';

function mail(body: string, over: Record<string, unknown> = {}) {
  return CanonicalEvent.parse({
    eventType: 'email_received',
    occurredAt: MONDAY,
    sourceSystem: 'outlook',
    sourceExternalId: 'evt-1',
    actor: { email: 'partner@supplierexample.com', name: 'A Supplier', role: 'from' },
    subject: 'Re: the order',
    body,
    threadId: 'thr-1',
    ...over,
  });
}

const first = (body: string, over: Record<string, unknown> = {}) => extractCommitments(mail(body, over))[0];

describe('what counts as a promise', () => {
  it('reads an explicit one', () => {
    const c = first('Thanks for the note. I will send the signed agreement over.');
    expect(c).toBeDefined();
    expect(c!.description).toMatch(/send the signed agreement/i);
    expect(c!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('reads the contracted form the same way', () => {
    expect(first("I'll send the signed agreement over.")).toBeDefined();
  });

  it('reads a stated intention and a stated plan', () => {
    expect(first("I'm going to get the samples shipped this week.")).toBeDefined();
    expect(first('I plan on listing the new SKU this week.')).toBeDefined();
  });

  it('keeps the sentence verbatim, because that is what gets quoted back', () => {
    const c = first('No problem at all. I will look into those hosts and follow up.');
    expect(c!.quote).toBe('I will look into those hosts and follow up.');
  });

  it('treats a hedge as a weaker promise, not as no promise', () => {
    const firm = first('I will have the numbers to you.')!;
    const hedged = first('I will try to have the numbers to you.')!;
    expect(hedged).toBeDefined();
    expect(hedged.confidence).toBeLessThan(firm.confidence);
  });
});

describe('what must never be read as a promise', () => {
  it('a request aimed at us', () => {
    expect(first('Can you send the certificate of analysis when you get a moment?')).toBeUndefined();
    expect(first('Please send the signed agreement back to me.')).toBeUndefined();
  });

  it('a question about what we want', () => {
    expect(first('Do you want me to list the new SKU, or hold it in draft?')).toBeUndefined();
  });

  it('a suggestion nobody has committed to', () => {
    expect(first('We should probably send the samples before the show.')).toBeUndefined();
    expect(first('I could send the samples this week if that helps.')).toBeUndefined();
  });

  it('a promise conditional on something that has not happened', () => {
    // Chasing this produces a nudge about work the counterparty does not yet owe.
    expect(first('If we go ahead with the order, I will send the contract over.')).toBeUndefined();
    expect(first('Once the invoice clears I will ship the pallets.')).toBeUndefined();
  });

  it('an out-of-office reply', () => {
    expect(first('I will be out of the office until the 4th with limited access to email.')).toBeUndefined();
    expect(first('I will be on leave next week.')).toBeUndefined();
  });

  it('somebody reporting a third party\'s promise', () => {
    // This is a reference to a commitment, not the making of one. Treating it
    // as new produces a second copy of something already being chased.
    expect(first('He said he would send the paperwork across on Friday.')).toBeUndefined();
  });

  it('a bulk mailing that happens to contain the words', () => {
    expect(first('We will send you our best offers every week. Unsubscribe here.')).toBeUndefined();
  });
});

describe('who owes whom', () => {
  it('is decided by the shape of the event, not by the words', () => {
    const inbound = first('I will send the agreement.')!;
    expect(inbound.direction).toBe('they_owe');

    const sent = extractCommitments(mail('I will send the agreement.', { sourceSystem: 'outlook_sent' }))[0]!;
    expect(sent.direction).toBe('we_owe');

    const chat = extractCommitments(mail('I will send the agreement.', { sourceSystem: 'slack' }))[0]!;
    expect(chat.direction).toBe('internal');
  });

  it('extracts nothing from a source that cannot say who spoke', () => {
    // A meeting transcript has many speakers and the actor is only the host.
    // Attributing every promise in the room to them is worse than silence.
    const meeting = mail('I will send the agreement.', { sourceSystem: 'zoom' });
    expect(extractCommitments(meeting)).toHaveLength(0);
  });
});

describe('deadlines', () => {
  it('resolves a weekday against the day the message was written', () => {
    // Written on Monday the 10th; "Friday" is the 14th.
    expect(parseDue('I will send it on Friday.', MONDAY)).toBe('2026-08-14T00:00:00.000Z');
  });

  it('reads the same weekday as the NEXT one, not today', () => {
    // "I'll get it to you Monday", written on a Monday, never means today.
    expect(parseDue('I will get it to you Monday.', MONDAY)).toBe('2026-08-17T00:00:00.000Z');
  });

  it('handles tomorrow, this week and next week', () => {
    expect(parseDue('I will send it tomorrow.', MONDAY)).toBe('2026-08-11T00:00:00.000Z');
    expect(parseDue('I will send it this week.', MONDAY)).toBe('2026-08-14T00:00:00.000Z');
    expect(parseDue('I will send it next week.', MONDAY)).toBe('2026-08-21T00:00:00.000Z');
  });

  it('handles end of month across the boundary', () => {
    expect(parseDue('I will have it by end of the month.', MONDAY)).toBe('2026-08-31T00:00:00.000Z');
  });

  it('returns null rather than guessing', () => {
    // An undated promise is perfectly chaseable — the ledger starts the clock
    // when it was first heard — so inventing a date is all downside.
    expect(parseDue('I will look into those and follow up.', MONDAY)).toBeNull();
    expect(parseDue('I will send it in due course.', MONDAY)).toBeNull();
  });

  it('makes a dated promise score higher than an undated one', () => {
    const dated = first('I will send the agreement on Friday.')!;
    const undated = first('I will send the agreement.')!;
    expect(dated.confidence).toBeGreaterThan(undated.confidence);
    expect(dated.dueDate).toBe('2026-08-14T00:00:00.000Z');
  });
});

describe('the description', () => {
  it('drops the time expression, which is carried separately', () => {
    expect(describeClause('send the signed agreement by Friday')).toBe('Send the signed agreement');
    expect(describeClause('ship the samples this week')).toBe('Ship the samples');
  });

  it('does not rewrite what was said', () => {
    // A clumsy description is recoverable because the quote sits beside it.
    // An invented one is not.
    expect(describeClause('look into those hosts and follow up')).toBe('Look into those hosts and follow up');
  });
});

describe('a message full of promises', () => {
  const roundup = [
    'Quick update on everything.',
    'I will send the revised quote.',
    'I will chase the lab for the results.',
    'I will update the shipping schedule.',
    'I will confirm the booking.',
    'I will reconcile the invoices.',
  ].join(' ');

  it('is capped, because chasing every line is the nagging we are avoiding', () => {
    expect(extractCommitments(mail(roundup)).length).toBeLessThanOrEqual(3);
  });

  it('does not report the same promise twice', () => {
    const c = extractCommitments(mail('I will send the revised quote. I will send the revised quote.'));
    expect(c).toHaveLength(1);
  });
});

describe('identity', () => {
  it('is stable, so re-reading the thread does not restart the follow-up clock', () => {
    const a = first('I will send the signed agreement.')!;
    const b = extractCommitments(mail('Following up. I will send the signed agreement.',
      { sourceExternalId: 'evt-2', occurredAt: '2026-08-12T09:00:00.000Z' }))[0]!;
    expect(b.id).toBe(a.id);
  });

  it('separates the same words on a different thread', () => {
    const a = first('I will send the signed agreement.')!;
    const b = extractCommitments(mail('I will send the signed agreement.', { threadId: 'thr-2' }))[0]!;
    expect(b.id).not.toBe(a.id);
  });
});

describe('a promise that points at something said earlier', () => {
  it('takes its description from the sentence before', () => {
    // "I plan on doing that this week" is a real promise whose description is
    // useless alone. The referent is where a human reader looks: one line up.
    const c = first('I did some research and think we can list the SKU as a variant of the powder. I plan on doing that this week.')!;
    expect(c).toBeDefined();
    expect(c.description).toBe('We can list the SKU as a variant of the powder');
    expect(c.quote).toBe('I plan on doing that this week.');
  });

  it('is dropped when there is nothing to point at', () => {
    // "Doing that" in a list of commitments helps nobody.
    expect(first('I plan on doing that this week.')).toBeUndefined();
  });
});

describe('boilerplate that describes a business rather than promising anything', () => {
  it('is refused', () => {
    // Real example from an onboarding email. Nobody can ever ask whether this
    // got done, which is the test a commitment has to pass.
    expect(first('As the platform operates across 36 languages and 180+ countries, we will utilize AI technology to translate.')).toBeUndefined();
  });

  it('does not refuse an ordinary sentence that merely starts with "as"', () => {
    expect(first('As discussed, I will send the signed agreement over.')).toBeDefined();
    // The commonest phrasing of a real promise. A broader rule would eat it.
    expect(first('As we discussed on Friday, I will send the signed agreement over.')).toBeDefined();
  });
});

describe('sentence splitting', () => {
  it('does not break on a decimal or an abbreviation', () => {
    expect(sentences('The unit cost is 1.45 per pack. I will confirm.')).toHaveLength(2);
    expect(sentences('Mr. Smith agreed. I will send it.')).toHaveLength(2);
  });

  it('lets a request and a promise in one message be judged separately', () => {
    const c = extractCommitments(mail('Can you send the PO? I will ship as soon as it lands.'));
    expect(c).toHaveLength(1);
    expect(c[0]!.description).toMatch(/ship/i);
  });
});

describe('extraction meeting what a person already wrote down', () => {
  const promise = mail('Got it. I will look into those hosts and follow up.');

  async function sync(commitments: unknown[]) {
    const { state } = await runSync({
      events: [promise], config, team, now: new Date('2026-08-11T12:00:00Z'),
      commitments: commitments as never,
    });
    return state.commitments;
  }

  it('finds the promise when nobody wrote it down', async () => {
    const found = await sync([]);
    expect(found).toHaveLength(1);
    expect(found[0]!.description).toMatch(/look into those hosts/i);
  });

  it('does not chase it twice when somebody did write it down', async () => {
    // Two nudges to one counterparty about one promise is worse than missing
    // it. The decisive test is the source, not the wording — a person and the
    // extractor reading the same message found the same thing.
    const found = await sync([{
      id: 'cmt-hand', description: 'Findings on the podcast hosts and their commitment terms',
      direction: 'they_owe', counterparty: null, owedBy: null, dueDate: null,
      businessDaysOutstanding: 0, followUpOwner: null, relationshipOwner: null,
      explicit: true, quote: null, sourceRef: 'evt-1',
    }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('cmt-hand');
  });

  it('keeps both when one message carries a question we owe and a promise they made', async () => {
    // Routine in real correspondence, and they are two commitments, not one.
    const found = await sync([{
      id: 'cmt-answer', description: 'Decide which hosts to proceed with',
      direction: 'we_owe', counterparty: null, owedBy: null, dueDate: null,
      businessDaysOutstanding: 0, followUpOwner: null, relationshipOwner: null,
      explicit: true, quote: null, sourceRef: 'evt-1',
    }]);
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.direction).sort()).toEqual(['they_owe', 'we_owe']);
  });
});
