/**
 * Priority engine.
 *
 * The property that matters most is EXPLAINABILITY: a score the brief cannot
 * justify in plain language is unusable, because the CEO stops trusting a
 * ranking they cannot interrogate.
 */
import { describe, expect, it } from 'vitest';
import { scoreTask } from '../src/priority/score.js';
import { rankTasks, diffRankings } from '../src/priority/rank.js';
import { applyPortfolioReview } from '../src/priority/portfolio.js';
import { Task } from '../src/schemas/tasks.js';
import type { BusinessSignal } from '../src/schemas/signals.js';
import { config } from './helpers.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const rules = config.priorityRules;

function task(overrides: Record<string, unknown> = {}) {
  return Task.parse({
    id: 't1',
    title: 'Test task',
    status: 'open',
    lastActivityAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  });
}

describe('score composition', () => {
  it('weights impact and urgency most heavily', () => {
    const high = scoreTask(task({ priority: { impact: 5, urgency: 5 } }), { rules, now: NOW });
    const low = scoreTask(task({ priority: { impact: 1, urgency: 1 } }), { rules, now: NOW });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('penalizes effort rather than rewarding it', () => {
    const cheap = scoreTask(task({ priority: { effort: 0 } }), { rules, now: NOW });
    const costly = scoreTask(task({ priority: { effort: 5 } }), { rules, now: NOW });
    expect(cheap.score).toBeGreaterThan(costly.score);
  });

  it('returns a plain-language driver for every material component', () => {
    const result = scoreTask(
      task({ priority: { impact: 5, urgency: 4, risk: 3 }, deadline: '2026-08-26T12:00:00Z' }),
      { rules, now: NOW },
    );
    expect(result.drivers.length).toBeGreaterThan(0);
    // Every driver must be readable prose, not a variable name.
    for (const driver of result.drivers) {
      expect(driver).toMatch(/[a-z]{3,}\s/);
    }
    expect(result.drivers.join(' ')).toContain('due within 24 hours');
  });

  it('ranks an overdue task above an identical one that is not', () => {
    const overdue = scoreTask(task({ deadline: '2026-08-20T12:00:00Z' }), { rules, now: NOW });
    const future = scoreTask(task({ deadline: '2026-10-20T12:00:00Z' }), { rules, now: NOW });
    expect(overdue.score).toBeGreaterThan(future.score);
    expect(overdue.drivers.join(' ')).toMatch(/overdue by \d+ days?/);
  });
});

describe('cheap CEO actions with large downstream effect', () => {
  it('rewards a task that unblocks others', () => {
    const blocking = scoreTask(task({ blocksTaskIds: ['a', 'b', 'c'] }), { rules, now: NOW });
    const isolated = scoreTask(task(), { rules, now: NOW });
    expect(blocking.score).toBeGreaterThan(isolated.score);
    expect(blocking.drivers.join(' ')).toContain('unblocks 3 other tasks');
  });

  it('rewards an approval, which costs minutes and can free days', () => {
    const approve = scoreTask(task({ ceoActionMode: 'APPROVE', ceoRequired: true }), { rules, now: NOW });
    const doWork = scoreTask(task({ ceoActionMode: 'DO', ceoRequired: true }), { rules, now: NOW });
    expect(approve.score).toBeGreaterThan(doWork.score);
  });

  it('scores CEO dependency separately from CEO ownership', () => {
    // Someone else owns the work, but the business still needs the CEO.
    const dependent = scoreTask(
      task({ primaryOwnerPersonId: 'mike', priority: { ceoDependency: 5 } }),
      { rules, now: NOW },
    );
    const independent = scoreTask(
      task({ primaryOwnerPersonId: 'mike', priority: { ceoDependency: 0 } }),
      { rules, now: NOW },
    );
    expect(dependent.score).toBeGreaterThan(independent.score);
  });
});

describe('penalties', () => {
  it('penalizes a system-proposed task that no human has accepted', () => {
    const proposed = scoreTask(task({ status: 'proposed' }), { rules, now: NOW });
    const accepted = scoreTask(task({ status: 'open' }), { rules, now: NOW });
    expect(proposed.score).toBeLessThan(accepted.score);
  });

  it('penalizes low-confidence interpretations', () => {
    const unsure = scoreTask(task({ confidence: 0.3 }), { rules, now: NOW });
    const sure = scoreTask(task({ confidence: 0.9 }), { rules, now: NOW });
    expect(unsure.score).toBeLessThan(sure.score);
  });

  it('surfaces staleness as a named driver rather than silent decay', () => {
    const stale = scoreTask(
      task({ lastActivityAt: '2026-07-01T12:00:00Z' }),
      { rules, now: NOW },
    );
    expect(stale.drivers.join(' ')).toMatch(/no activity for \d+ days/);
  });
});

describe('signals and compound rules', () => {
  function signal(type: string): BusinessSignal {
    return {
      signalType: type, businessArea: 'operations', sourceSystem: 'finaloop',
      severity: 7, summary: type, evidence: null, recommendedAction: null,
      likelyPeople: [], windowStart: null, windowEnd: null, observationCount: null,
      valueAtStake: null, occurredAt: NOW.toISOString(), metadata: {},
    };
  }

  it('raises priority when a relevant signal is active', () => {
    const withSignal = scoreTask(task(), { rules, now: NOW, signals: [signal('cash_risk')] });
    const without = scoreTask(task(), { rules, now: NOW });
    expect(withSignal.score).toBeGreaterThan(without.score);
  });

  it('applies the compound rule two moderate signals together imply', () => {
    // This is the cross-functional case a single-source system cannot see:
    // a production payment coming due WHILE inventory is low.
    const compound = scoreTask(task(), {
      rules, now: NOW, signals: [signal('cash_risk'), signal('inventory_risk')],
    });
    const single = scoreTask(task(), { rules, now: NOW, signals: [signal('cash_risk')] });
    expect(compound.score).toBeGreaterThan(single.score);
    expect(compound.drivers.join(' ')).toContain('inventory coverage');
  });

  it('does not compound multiple plain multipliers', () => {
    // Otherwise a task touching four signals runs away with the ranking.
    const many = scoreTask(task(), {
      rules, now: NOW,
      signals: [signal('roas_decline'), signal('customer_experience'), signal('revenue_opportunity')],
    });
    const one = scoreTask(task(), { rules, now: NOW, signals: [signal('roas_decline')] });
    expect(many.score).toBeCloseTo(one.score, 5);
  });
});

describe('ranking and change explanation', () => {
  it('assigns dense ranks in score order', () => {
    const ranked = rankTasks(
      [
        task({ id: 'low', priority: { impact: 1, urgency: 1 } }),
        task({ id: 'high', priority: { impact: 5, urgency: 5 } }),
        task({ id: 'mid', priority: { impact: 3, urgency: 3 } }),
      ],
      () => ({ rules, now: NOW }),
    );
    expect(ranked.map((r) => r.task.id)).toEqual(['high', 'mid', 'low']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('breaks ties by deadline so ordering does not jitter between runs', () => {
    const ranked = rankTasks(
      [
        task({ id: 'later', deadline: '2026-12-01T00:00:00Z' }),
        task({ id: 'sooner', deadline: '2026-09-01T00:00:00Z' }),
      ],
      () => ({ rules, now: NOW }),
    );
    expect(ranked[0]!.task.id).toBe('sooner');
  });

  it('explains a movement with the component that actually changed', () => {
    // Task 'a' is held constant except for gaining blockers, so the explanation
    // has exactly one true cause available to it.
    const b = task({ id: 'b', priority: { impact: 4, urgency: 3 } });
    const before = rankTasks([task({ id: 'a' }), b], () => ({ rules, now: NOW }));
    const after = rankTasks(
      [task({ id: 'a', blocksTaskIds: ['x', 'y', 'z'] }), b],
      () => ({ rules, now: NOW }),
    );

    expect(before.find((r) => r.task.id === 'a')!.rank).toBe(2);
    expect(after.find((r) => r.task.id === 'a')!.rank).toBe(1);

    const moved = diffRankings(before, after, rules).find((c) => c.taskId === 'a');
    expect(moved?.reason).toContain('moved up #2 → #1');
    expect(moved?.reason).toContain('unblocks 3 other tasks');
  });

  it('marks trivial movements immaterial so the brief does not narrate noise', () => {
    const before = rankTasks([task({ id: 'a' })], () => ({ rules, now: NOW }));
    const after = rankTasks([task({ id: 'a', priority: { relationship: 1 } })], () => ({ rules, now: NOW }));
    const changes = diffRankings(before, after, rules);
    expect(changes.every((c) => !c.material)).toBe(true);
  });
});

describe('portfolio review bounds', () => {
  it('clamps an AI adjustment to a fraction of the task’s own score', () => {
    const ranked = rankTasks([task({ id: 'a', priority: { impact: 5, urgency: 5 } })], () => ({ rules, now: NOW }));
    const original = ranked[0]!.score;

    const outcome = applyPortfolioReview(
      { ranked, rules },
      { adjustments: [{ taskId: 'a', scoreDelta: 10_000, reason: 'runaway' }],
        topCeoActions: [], delegationOpportunities: [], staleItems: [],
        shouldDropOrDefer: [], risks: [], opportunities: [], confidence: 0.9 },
    );

    const applied = outcome.applied[0]!;
    expect(applied.clamped).toBe(true);
    expect(applied.appliedDelta).toBeLessThanOrEqual(original * rules.portfolio_review.max_ai_adjustment_ratio + 0.01);
  });

  it('rejects an adjustment for a task outside the reviewed set', () => {
    const ranked = rankTasks([task({ id: 'a' })], () => ({ rules, now: NOW }));
    const outcome = applyPortfolioReview(
      { ranked, rules },
      { adjustments: [{ taskId: 'ghost', scoreDelta: 5, reason: 'hallucinated' }],
        topCeoActions: [], delegationOpportunities: [], staleItems: [],
        shouldDropOrDefer: [], risks: [], opportunities: [], confidence: 0.9 },
    );
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.applied).toHaveLength(0);
  });
});
