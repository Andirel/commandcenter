/**
 * The ordered day plan.
 *
 * A ranked list answers "what matters most". It does not answer "what should I
 * do first", and those differ for one reason that dominates everything else:
 *
 *   THE VALUE OF UNBLOCKING SOMEONE DECAYS THROUGH THE DAY.
 *
 * Approving Chase's content at 09:00 buys a full day of his work. The same
 * approval at 16:30 buys nothing until tomorrow. So a five-minute approval that
 * frees another person outranks an hour of the CEO's own high-scoring work in
 * the MORNING, and stops outranking it by late afternoon.
 *
 * The plan is also budgeted against the hours actually left. A plan that needs
 * nine hours at 15:00 is not a plan, and telling someone otherwise is how a
 * daily tool stops being opened.
 */
import type { StateTask } from '../sync/state.js';

export type SlotKind = 'unblock' | 'deadline' | 'decide' | 'deep' | 'strategic' | 'delegate';

export interface PlanSlot {
  task: StateTask;
  kind: SlotKind;
  /** Estimated hands-on minutes for the CEO — not the task's total duration. */
  minutes: number;
  /** Why it sits here, in the order, in plain language. */
  why: string;
  /** The specific next physical action. */
  move: string;
}

export interface DayPlan {
  slots: PlanSlot[];
  /** Items that did not fit the remaining hours, in the order they were dropped. */
  deferred: PlanSlot[];
  minutesPlanned: number;
  minutesAvailable: number;
  fits: boolean;
  /** One honest sentence about the shape of the day. */
  summary: string;
}

export interface PlanOptions {
  now?: Date;
  /** Local hour the working day ends. */
  endHour?: number;
  /** Fraction of remaining time realistically available for planned work. */
  focusFactor?: number;
  ceoName?: string;
  /** Hours before which unblocking is worth most. */
  morningUntilHour?: number;
}

/**
 * Hands-on CEO minutes.
 *
 * Deliberately keyed to the MODE, not the task's size: approving a $50k
 * production run and approving a social post cost the same few minutes of
 * attention, whatever they cost the business.
 */
export function estimateMinutes(task: StateTask): number {
  switch (task.ceoActionMode) {
    case 'APPROVE': return 5;
    case 'DECIDE': return task.valueAtStake && task.valueAtStake >= 25000 ? 20 : 10;
    case 'REVIEW': return 15;
    case 'FOLLOW_UP': return 10;
    case 'DELEGATE': return 5;
    case 'DO': return [15, 30, 45, 90, 120, 180][task.drivers.length ? 3 : 2] ?? 45;
    default: return 5;
  }
}

/**
 * Who is stopped until this moves — or null if nobody is.
 *
 * "Someone else" must exclude the CEO himself. A plan that tells its reader
 * "Adi is waiting on this" is telling him he is waiting on himself, which is
 * both wrong and faintly absurd.
 */
export function blockedParty(task: StateTask, ceoName: string): string | null {
  if (task.ceoActionMode !== 'APPROVE' && task.ceoActionMode !== 'DECIDE') return null;
  for (const candidate of [task.primaryOwner, task.projectManager, task.externalParty]) {
    if (candidate && candidate !== ceoName) return candidate;
  }
  return null;
}

/** Kept for callers that only need the boolean. */
export function blocksSomeone(task: StateTask, ceoName = 'Adi'): boolean {
  return blockedParty(task, ceoName) !== null;
}

function isOverdueOrToday(task: StateTask, now: Date): boolean {
  if (!task.deadline) return false;
  const due = Date.parse(task.deadline);
  if (Number.isNaN(due)) return false;
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return due <= endOfToday.getTime();
}

export function buildDayPlan(tasks: StateTask[], opts: PlanOptions = {}): DayPlan {
  const now = opts.now ?? new Date();
  const endHour = opts.endHour ?? 18;
  const focusFactor = opts.focusFactor ?? 0.6;
  const ceoName = opts.ceoName ?? 'Adi';
  const morningUntilHour = opts.morningUntilHour ?? 14;

  const hoursLeft = Math.max(0, endHour - (now.getHours() + now.getMinutes() / 60));
  const minutesAvailable = Math.round(hoursLeft * 60 * focusFactor);
  const isMorning = now.getHours() < morningUntilHour;

  const live = tasks.filter((t) => t.ceoRequired || t.primaryOwner === ceoName);

  const scored = live.map((task) => {
    const minutes = estimateMinutes(task);
    const waiting = blockedParty(task, ceoName);
    const urgent = isOverdueOrToday(task, now);
    const ceoMustAnswer = task.ceoActionMode === 'DECIDE' || task.ceoActionMode === 'APPROVE';
    const strategic = (task.businessArea === 'strategy' || task.businessArea === 'business_development')
      && (task.valueAtStake ?? 0) > 0;

    let kind: SlotKind = 'decide';
    let order = 400;
    let why = 'Ranked here on priority.';

    if (waiting && isMorning) {
      // The compounding case: cheap for the CEO, and it buys someone else a day.
      kind = 'unblock';
      order = 100;
      why = `${waiting} is waiting on this — clearing it early buys them the day.`;
    } else if (urgent) {
      kind = 'deadline';
      order = 200;
      why = 'Due today or already overdue.';
    } else if (waiting) {
      // Same item, later in the day: the compounding value has gone.
      kind = 'unblock';
      order = 300;
      why = `${waiting} is waiting, though clearing it now only helps tomorrow.`;
    } else if (ceoMustAnswer) {
      // Nobody else is stopped, but it is still a cheap call only he can make.
      kind = 'decide';
      order = 400;
      why = task.valueAtStake && task.valueAtStake >= 25000
        ? 'A material call that only you can make.'
        : 'A quick call that only you can make.';
    } else if (task.ceoActionMode === 'DO') {
      kind = 'deep';
      order = 500;
      why = 'Needs you personally and an uninterrupted block.';
    } else if (strategic) {
      kind = 'strategic';
      order = 600;
      why = 'Long-term; held a slot so it is not crowded out by today.';
    } else if (task.leverageClass && task.leverageClass.indexOf('PAUL_CAN') === 0) {
      // Only reachable when the CEO is NOT the one who must answer — otherwise
      // a six-figure decision would read as "hand this over".
      kind = 'delegate';
      order = 350;
      why = 'Hand this over rather than carry it.';
    }

    return { task, kind, minutes, why, order, score: task.score };
  });

  scored.sort((a, b) => (a.order - b.order) || (b.score - a.score) || (a.minutes - b.minutes));

  // Reserve one strategic slot so the long term is never entirely crowded out.
  const strategicFirst = scored.find((s) => s.kind === 'strategic');
  const reserved = strategicFirst ? strategicFirst.minutes : 0;

  const slots: PlanSlot[] = [];
  const deferred: PlanSlot[] = [];
  let used = 0;
  // The reason unblocking comes first is stated ONCE. Repeating it verbatim on
  // every row reads as a template rather than an explanation.
  let explainedUnblocking = false;

  for (const entry of scored) {
    let why = entry.why;
    if (entry.kind === 'unblock') {
      const waitingOn = blockedParty(entry.task, ceoName);
      if (explainedUnblocking) why = `${waitingOn ?? 'Someone'} is waiting.`;
      else explainedUnblocking = true;
    }

    const slot: PlanSlot = {
      task: entry.task, kind: entry.kind, minutes: entry.minutes,
      why, move: nextMove(entry.task, entry.kind),
    };
    const isReserved = strategicFirst === entry;
    const budget = isReserved ? minutesAvailable : minutesAvailable - reserved;

    if (used + entry.minutes <= budget || (isReserved && used <= minutesAvailable)) {
      slots.push(slot);
      used += entry.minutes;
    } else {
      deferred.push(slot);
    }
  }

  return {
    slots, deferred,
    minutesPlanned: used,
    minutesAvailable,
    fits: deferred.length === 0,
    summary: describeDay({ slots, deferred, used, minutesAvailable, hoursLeft, isMorning }),
  };
}

function nextMove(task: StateTask, kind: SlotKind): string {
  switch (kind) {
    case 'unblock':
      return task.ceoActionMode === 'APPROVE'
        ? `Approve or send it back to ${task.primaryOwner ?? 'the owner'}.`
        : 'Make the call so the work can continue.';
    case 'deadline':
      return 'Close it out or move the date deliberately.';
    case 'deep':
      return 'Block the time; this one is yours.';
    case 'strategic':
      return 'Give it fifteen honest minutes rather than deferring again.';
    case 'delegate':
      return `Hand to ${task.projectManager ?? 'Paul'} with the context.`;
    default:
      return 'Decide and move on.';
  }
}

function describeDay(a: {
  slots: PlanSlot[]; deferred: PlanSlot[]; used: number;
  minutesAvailable: number; hoursLeft: number; isMorning: boolean;
}): string {
  if (!a.slots.length && !a.deferred.length) return 'Nothing needs you today.';
  if (a.minutesAvailable <= 0) return 'The working day is over. This is tomorrow morning’s list.';

  const unblocking = a.slots.filter((s) => s.kind === 'unblock').length;
  const hrs = (m: number) => (m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`);

  const parts = [`${hrs(a.used)} of work against about ${hrs(a.minutesAvailable)} left`];
  if (unblocking && a.isMorning) {
    parts.push(`${unblocking} ${unblocking === 1 ? 'item frees' : 'items free'} someone else — those go first`);
  }
  if (a.deferred.length) parts.push(`${a.deferred.length} pushed to tomorrow`);
  return `${parts.join('. ')}.`;
}
