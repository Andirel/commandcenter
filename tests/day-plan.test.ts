/**
 * The ordered day plan.
 *
 * The rule this defends: the value of unblocking someone DECAYS through the
 * day. A five-minute approval at 09:00 buys a colleague a full day; the same
 * approval at 16:30 buys nothing until tomorrow. So ordering is time-dependent,
 * not a straight score sort.
 */
import { describe, expect, it } from 'vitest';
import { buildDayPlan, blockedParty, blocksSomeone, estimateMinutes } from '../src/brief/plan.js';
import { StateTask } from '../src/sync/state.js';

const MORNING = new Date('2026-08-25T09:00:00');
const LATE = new Date('2026-08-25T16:30:00');

function task(over: Record<string, unknown> = {}) {
  return StateTask.parse({
    id: 't1', title: 'A task', source: 'Manual', occurredAt: '2026-08-25T08:00:00.000Z',
    ceoRequired: true, ...over,
  });
}

describe('who is actually blocked', () => {
  it('names the colleague waiting', () => {
    expect(blockedParty(task({ ceoActionMode: 'APPROVE', primaryOwner: 'Chase' }), 'Adi')).toBe('Chase');
  });

  it('does NOT say the CEO is waiting on himself', () => {
    // A plan that tells Adi "Adi is waiting on this" is both wrong and absurd.
    expect(blockedParty(task({ ceoActionMode: 'DECIDE', primaryOwner: 'Adi' }), 'Adi')).toBeNull();
  });

  it('falls through to the tracker when the CEO owns it', () => {
    expect(blockedParty(task({ ceoActionMode: 'DECIDE', primaryOwner: 'Adi', projectManager: 'Paul' }), 'Adi')).toBe('Paul');
  });

  it('counts an external party as waiting', () => {
    expect(blockedParty(task({ ceoActionMode: 'DECIDE', externalParty: 'RadioActive Media' }), 'Adi')).toBe('RadioActive Media');
  });

  it('is not triggered by work the CEO must do himself', () => {
    expect(blocksSomeone(task({ ceoActionMode: 'DO', primaryOwner: 'Mike' }), 'Adi')).toBe(false);
  });
});

describe('ordering', () => {
  const unblocking = task({ id: 'chase', title: 'Approve social content', ceoActionMode: 'APPROVE', primaryOwner: 'Chase', score: 10 });
  const ownDeep = task({ id: 'deep', title: 'Draft the retailer response', ceoActionMode: 'DO', primaryOwner: 'Adi', score: 40 });

  it('puts unblocking first in the morning, above higher-scoring own work', () => {
    const plan = buildDayPlan([unblocking, ownDeep], { now: MORNING });
    expect(plan.slots[0]!.task.id).toBe('chase');
    expect(plan.slots[0]!.kind).toBe('unblock');
    expect(plan.slots[0]!.why).toContain('Chase is waiting');
    expect(plan.slots[0]!.why).toContain('buys them the day');
  });

  it('stops claiming the compounding benefit late in the day', () => {
    const morning = buildDayPlan([unblocking, ownDeep], { now: MORNING });
    const late = buildDayPlan([unblocking, ownDeep], { now: LATE });

    const chaseAM = morning.slots.find((s) => s.task.id === 'chase')!;
    const chasePM = late.slots.concat(late.deferred).find((s) => s.task.id === 'chase')!;

    expect(chaseAM.why).toContain('buys them the day');
    expect(chasePM.why).toContain('only helps tomorrow');
  });

  it('lets urgent work overtake unblocking once the day is late', () => {
    // In the morning nothing outranks freeing a colleague. By late afternoon a
    // deadline does, because the colleague cannot act on it today anyway.
    const due = task({ id: 'due', title: 'Due today', ceoActionMode: 'REVIEW', deadline: '2026-08-25T23:00:00.000Z', score: 1 });
    expect(buildDayPlan([due, unblocking], { now: MORNING }).slots[0]!.task.id).toBe('chase');
    expect(buildDayPlan([due, unblocking], { now: LATE }).slots[0]!.task.id).toBe('due');
  });

  it('puts anything due today above ordinary decisions', () => {
    const due = task({ id: 'due', title: 'Overdue thing', ceoActionMode: 'REVIEW', deadline: '2026-08-25T12:00:00.000Z', score: 1 });
    const plan = buildDayPlan([task({ id: 'other', ceoActionMode: 'REVIEW', score: 50 }), due], { now: MORNING });
    expect(plan.slots[0]!.task.id).toBe('due');
    expect(plan.slots[0]!.kind).toBe('deadline');
  });

  it('does not describe a CEO decision as something to hand over', () => {
    // A $100k call routed with a coordinator tracking it is still the CEO's.
    const big = task({
      id: 'big', title: 'Decide on the podcast commitment', ceoActionMode: 'DECIDE',
      primaryOwner: null, externalParty: null, projectManager: null,
      leverageClass: 'PAUL_CAN_PROJECT_MANAGE', valueAtStake: 100000,
    });
    const plan = buildDayPlan([big], { now: MORNING });
    expect(plan.slots[0]!.kind).toBe('decide');
    expect(plan.slots[0]!.why).toContain('only you can make');
  });

  it('reserves a slot for long-term work so it is not always crowded out', () => {
    const strategic = task({
      id: 'strat', title: 'Set the commitment policy', ceoActionMode: 'REVIEW',
      businessArea: 'strategy', valueAtStake: 100000, score: 1,
    });
    const filler = Array.from({ length: 12 }, (_, i) =>
      task({ id: 'f' + i, title: 'Filler ' + i, ceoActionMode: 'DO', primaryOwner: 'Adi', score: 90 }));
    const plan = buildDayPlan(filler.concat([strategic]), { now: MORNING });
    expect(plan.slots.some((s) => s.task.id === 'strat')).toBe(true);
  });
});

describe('the time budget', () => {
  it('prices attention by MODE, not by the size of the thing decided', () => {
    // Approving a $50k run and approving a social post cost the same minutes.
    expect(estimateMinutes(task({ ceoActionMode: 'APPROVE' }))).toBe(5);
    expect(estimateMinutes(task({ ceoActionMode: 'DECIDE', valueAtStake: 100 }))).toBe(10);
    expect(estimateMinutes(task({ ceoActionMode: 'DECIDE', valueAtStake: 100000 }))).toBe(20);
    expect(estimateMinutes(task({ ceoActionMode: 'DO' }))).toBeGreaterThan(30);
  });

  it('defers what does not fit the hours left', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      task({ id: 'x' + i, title: 'Deep work ' + i, ceoActionMode: 'DO', primaryOwner: 'Adi' }));
    const plan = buildDayPlan(many, { now: LATE });
    expect(plan.fits).toBe(false);
    expect(plan.deferred.length).toBeGreaterThan(0);
    expect(plan.summary).toContain('pushed to tomorrow');
  });

  it('says so plainly once the day is over', () => {
    const plan = buildDayPlan([task({ ceoActionMode: 'DECIDE', primaryOwner: 'Mike' })],
      { now: new Date('2026-08-25T20:00:00') });
    expect(plan.summary).toContain('tomorrow morning');
  });

  it('reports nothing to do without inventing filler', () => {
    expect(buildDayPlan([], { now: MORNING }).summary).toBe('Nothing needs you today.');
  });

  it('ignores work that belongs to someone else entirely', () => {
    const mikes = task({ id: 'm', ceoRequired: false, primaryOwner: 'Mike', ceoActionMode: null });
    expect(buildDayPlan([mikes], { now: MORNING }).slots).toHaveLength(0);
  });
});

describe('the plan reads like prose, not a template', () => {
  it('explains why unblocking comes first once, then states it tersely', () => {
    const items = ['Chase', 'Paul', 'Mike'].map((who, i) =>
      task({ id: 'u' + i, title: 'Approve ' + who + "'s work", ceoActionMode: 'APPROVE', primaryOwner: who }));
    const plan = buildDayPlan(items, { now: MORNING });

    const long = plan.slots.filter((s) => s.why.includes('buys them the day'));
    expect(long).toHaveLength(1);

    for (const s of plan.slots.slice(1)) {
      expect(s.why).toMatch(/^\w[\w\s]* is waiting\.$/);
      expect(s.why).not.toContain('buys them the day');
    }
  });
});
