/**
 * Deduplication.
 *
 * Governing asymmetry: a wrong MERGE destroys information; a duplicate is
 * merely annoying. So the ambiguous band must resolve to NEEDS_REVIEW.
 */
import { describe, expect, it } from 'vitest';
import { matchTask, MERGE_THRESHOLD, REVIEW_THRESHOLD } from '../src/deduplication/match.js';
import { tokenSimilarity, trigramSimilarity, participantOverlap, temporalProximity } from '../src/deduplication/similarity.js';
import { Task } from '../src/schemas/tasks.js';

const NOW = '2026-08-25T12:00:00Z';

function task(overrides: Record<string, unknown> = {}) {
  return Task.parse({
    id: 't1', title: 'Chase supplier for certificate of analysis',
    status: 'open', lastActivityAt: NOW, createdAt: NOW, ...overrides,
  });
}

describe('similarity primitives', () => {
  it('scores identical text as fully similar', () => {
    expect(tokenSimilarity('production run delayed', 'production run delayed')).toBe(1);
  });

  it('ignores stopwords so phrasing differences do not dominate', () => {
    const a = tokenSimilarity('the production run is delayed', 'production run delayed');
    expect(a).toBeGreaterThan(0.9);
  });

  it('catches reordered wording via trigrams', () => {
    expect(trigramSimilarity('packaging reorder', 'reorder packaging')).toBeGreaterThan(0.6);
  });

  it('decays temporal proximity over the window', () => {
    expect(temporalProximity(NOW, NOW)).toBe(1);
    expect(temporalProximity(NOW, '2026-08-24T12:00:00Z')).toBeGreaterThan(0.8);
    expect(temporalProximity(NOW, '2026-06-01T12:00:00Z')).toBe(0);
  });

  it('measures participant overlap symmetrically', () => {
    expect(participantOverlap(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(participantOverlap(['a'], ['b'])).toBe(0);
  });
});

describe('match decisions', () => {
  const base = {
    participantPersonIds: ['mike'],
    initiativeId: null,
    occurredAt: NOW,
    threadId: null,
    externalOrganizationId: null,
  };

  it('creates when nothing resembles the input', () => {
    const outcome = matchTask(
      { ...base, title: 'Design new packaging dieline for the carton' },
      [task()],
    );
    expect(outcome.decision).toBe('CREATE');
    expect(outcome.similarity).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('converges multi-source reports of the same activity onto one task', () => {
    const existing = task({
      id: 'prod-run',
      title: 'Confirm October production run date with the manufacturer',
      primaryOwnerPersonId: 'mike',
    });
    const outcome = matchTask(
      {
        ...base,
        title: 'Confirm the October production run date with manufacturer',
        description: 'Manufacturer needs to confirm the run date.',
      },
      [existing],
    );
    expect(outcome.decision).toBe('UPDATE_EXISTING');
    expect(outcome.matchedTask?.id).toBe('prod-run');
    expect(outcome.similarity).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
  });

  it('treats a matching source thread as decisive regardless of wording', () => {
    const existing = task({ id: 'threaded', sourceThreadId: 'AAQk-conversation-1', title: 'Completely different words here' });
    const outcome = matchTask(
      { ...base, title: 'Nothing alike at all', threadId: 'AAQk-conversation-1' },
      [existing],
    );
    expect(outcome.decision).toBe('UPDATE_EXISTING');
    expect(outcome.similarity).toBe(1);
    expect(outcome.reason).toContain('thread');
  });

  it('asks rather than guessing in the ambiguous band', () => {
    const existing = task({
      id: 'coa',
      title: 'Chase supplier for certificate of analysis',
      primaryOwnerPersonId: 'mike',
    });
    const outcome = matchTask(
      { ...base, title: 'Follow up with supplier on the certificate of analysis' },
      [existing],
    );
    expect(outcome.decision).toBe('NEEDS_REVIEW');
    expect(outcome.similarity).toBeGreaterThan(REVIEW_THRESHOLD);
    expect(outcome.similarity).toBeLessThan(MERGE_THRESHOLD);
  });

  it('asks when two open tasks match about equally well', () => {
    // Merging into the wrong one of a near-tie is exactly the failure worth
    // avoiding — it silently destroys one of the two records.
    const outcome = matchTask(
      { ...base, title: 'Confirm production run date' },
      [
        task({ id: 'a', title: 'Confirm production run date October', primaryOwnerPersonId: 'mike' }),
        task({ id: 'b', title: 'Confirm production run date November', primaryOwnerPersonId: 'mike' }),
      ],
    );
    expect(outcome.decision).toBe('NEEDS_REVIEW');
    expect(outcome.reason).toContain('equally well');
  });

  it('flags a close match against a CLOSED task as a possible recurrence', () => {
    // A quarterly task recurring is new work, not a duplicate. Silently
    // reopening or merging would lose the previous instance.
    const outcome = matchTask(
      { ...base, title: 'Confirm October production run date with the manufacturer' },
      [task({ id: 'done', title: 'Confirm October production run date with the manufacturer', status: 'completed' })],
    );
    expect(outcome.decision).toBe('NEEDS_REVIEW');
    expect(outcome.reason).toContain('recurrence');
  });

  it('creates when there is nothing at all to compare against', () => {
    const outcome = matchTask({ ...base, title: 'First task ever' }, []);
    expect(outcome.decision).toBe('CREATE');
  });
});
