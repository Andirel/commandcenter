/**
 * The daily CEO brief — the system's primary output surface.
 *
 * Editorial discipline, since attention is the resource being managed:
 *   - Every line must justify the seconds it costs to read.
 *   - Every item states the MODE (DO / DECIDE / APPROVE / DELEGATE / FOLLOW UP
 *     / REVIEW), because "needs Adi" spans five minutes to a full day.
 *   - Decisions are a separate section from tasks. Conflating them is what
 *     makes a to-do list feel heavier than the work actually is.
 *   - Rank changes are narrated only when material, and only with a true
 *     reason drawn from the score components.
 *   - "Only material" means exactly that. Padding a section to hit a count is
 *     how a brief stops being read.
 */
import type { PriorityRulesConfig } from '../schemas/config.js';
import type { ActionMode } from '../schemas/core.js';
import type { Person } from '../schemas/people.js';
import type { Task } from '../schemas/tasks.js';
import type { RankedTask, RankChange } from '../priority/rank.js';
import type { FollowUpDue } from '../followup/engine.js';

export interface BriefTaskLine {
  taskId: string;
  title: string;
  mode: ActionMode;
  /** Why this matters to the business, in one sentence. */
  whyItMatters: string;
  whatChanged: string | null;
  recommendedNextMove: string;
  whoElseIsInvolved: string[];
  deadline: string | null;
  rank: number;
}

export interface DelegationLine {
  taskId: string;
  title: string;
  delegateTo: string;
  reason: string;
  estimatedCeoHoursSaved: number;
}

export interface WaitingLine {
  description: string;
  counterparty: string;
  businessDaysOverdue: number;
  party: 'internal' | 'external';
  followUpOwner: string | null;
  draftReady: boolean;
}

export interface DailyBrief {
  date: string;
  topActions: BriefTaskLine[];
  delegationOpportunities: DelegationLine[];
  operationsSummary: string[];
  decisions: BriefTaskLine[];
  waitingOn: { internal: WaitingLine[]; external: WaitingLine[] };
  changedSinceYesterday: string[];
  risks: string[];
  opportunities: string[];
  meetingsToday: Array<{ topic: string; startsAt: string; prepReady: boolean }>;
}

export interface BriefContext {
  rules: PriorityRulesConfig;
  people: Map<string, Person>;
  ceoPersonId: string;
  leveragePersonId: string | null;
  now?: Date;
}

export interface BriefInput {
  ranked: RankedTask[];
  changes: RankChange[];
  followUps: FollowUpDue[];
  operationsNotes?: string[];
  risks?: string[];
  opportunities?: string[];
  meetings?: Array<{ topic: string; startsAt: string; prepReady: boolean }>;
}

export function composeDailyBrief(input: BriefInput, ctx: BriefContext): DailyBrief {
  const now = ctx.now ?? new Date();
  const limits = ctx.rules.ranking.daily_brief;
  const floor = ctx.rules.ranking.brief_inclusion_floor;

  const changeByTask = new Map(input.changes.map((c) => [c.taskId, c]));
  const aboveFloor = input.ranked.filter((r) => r.score >= floor);

  // --- Decisions, kept separate from tasks ---------------------------------
  // A decision is not a to-do. Mixing them makes the day look heavier than it
  // is and buries the items that are genuinely cheap to resolve.
  const decisionEntries = aboveFloor.filter(
    (r) => r.task.ceoRequired && (r.task.ceoActionMode === 'DECIDE' || r.task.ceoActionMode === 'APPROVE'),
  );

  const decisions = decisionEntries
    .slice(0, limits.decisions_n)
    .map((r) => toLine(r, changeByTask.get(r.task.id) ?? null, ctx));

  // --- Top CEO actions ------------------------------------------------------
  const decisionIds = new Set(decisions.map((d) => d.taskId));
  const topActions = aboveFloor
    .filter((r) => r.task.ceoRequired && !decisionIds.has(r.task.id))
    .filter((r) => r.task.priority.ceoDependency >= 1)
    .slice(0, limits.ceo_top_n)
    .map((r) => toLine(r, changeByTask.get(r.task.id) ?? null, ctx));

  // --- What the coordinator can absorb --------------------------------------
  const delegationOpportunities = aboveFloor
    .filter((r) => canDelegate(r.task, ctx))
    .slice(0, limits.paul_can_take_n)
    .map((r) => ({
      taskId: r.task.id,
      title: r.task.title,
      delegateTo: nameOf(ctx, ctx.leveragePersonId) ?? 'the coordinator',
      reason: r.task.routingReason ?? r.result.drivers[0] ?? 'Coordination work, not CEO work.',
      estimatedCeoHoursSaved: 0,
    }));

  // --- Waiting on -----------------------------------------------------------
  const waiting = input.followUps
    .slice(0, limits.waiting_on_n)
    .map((f) => toWaitingLine(f, ctx));

  // --- Changes --------------------------------------------------------------
  // Only material movements are narrated. Everything is still recorded in
  // priority_history; we suppress narration, not the audit trail.
  const changedSinceYesterday = input.changes
    .filter((c) => c.material)
    .slice(0, 5)
    .map((c) => `${c.title}: ${c.reason}`);

  return {
    date: now.toISOString().slice(0, 10),
    topActions,
    delegationOpportunities,
    operationsSummary: input.operationsNotes ?? [],
    decisions,
    waitingOn: {
      internal: waiting.filter((w) => w.party === 'internal'),
      external: waiting.filter((w) => w.party === 'external'),
    },
    changedSinceYesterday,
    risks: (input.risks ?? []).slice(0, limits.risks_n),
    opportunities: (input.opportunities ?? []).slice(0, limits.opportunities_n),
    meetingsToday: input.meetings ?? [],
  };
}

function canDelegate(task: Task, ctx: BriefContext): boolean {
  if (!task.delegable) return false;
  if (!task.leverageClass) return false;
  if (task.leverageClass === 'ADI_REQUIRED' || task.leverageClass === 'SPECIALIST_REQUIRED') return false;
  // Already handed over -- suggesting it again is noise.
  if (ctx.leveragePersonId && task.primaryOwnerPersonId === ctx.leveragePersonId) return false;
  if (ctx.leveragePersonId && task.projectManagerPersonId === ctx.leveragePersonId) return false;
  return true;
}

function toLine(entry: RankedTask, change: RankChange | null, ctx: BriefContext): BriefTaskLine {
  const task = entry.task;
  const involved: string[] = [];
  for (const id of [task.primaryOwnerPersonId, task.projectManagerPersonId, task.decisionMakerPersonId]) {
    const name = nameOf(ctx, id);
    if (name && !involved.includes(name)) involved.push(name);
  }

  return {
    taskId: task.id,
    title: task.title,
    mode: task.ceoActionMode ?? 'REVIEW',
    whyItMatters: entry.result.drivers[0] ?? 'Currently ranked among the highest-value open items.',
    whatChanged: change?.material ? change.reason : null,
    recommendedNextMove: recommendNextMove(task, ctx),
    whoElseIsInvolved: involved,
    deadline: task.deadline,
    rank: entry.rank,
  };
}

/**
 * The recommended move, phrased as the specific next physical action.
 * "Follow up on the retailer" is useless; "Paul has the packet — confirm the
 * one open term" is actionable.
 */
function recommendNextMove(task: Task, ctx: BriefContext): string {
  const owner = nameOf(ctx, task.primaryOwnerPersonId);

  switch (task.ceoActionMode) {
    case 'APPROVE':
      return owner ? `${owner} has prepared this; approve or send it back.` : 'Approve or send it back.';
    case 'DECIDE':
      return 'Make the call; everything else is assembled.';
    case 'DELEGATE':
      return `Hand this to ${nameOf(ctx, ctx.leveragePersonId) ?? 'the coordinator'}.`;
    case 'FOLLOW_UP':
      return 'A draft follow-up is ready for review.';
    case 'REVIEW':
      return 'Review and confirm the direction.';
    case 'DO':
      return 'This one needs you personally.';
    default:
      return owner ? `${owner} is carrying this; no action needed today.` : 'No action needed today.';
  }
}

function toWaitingLine(due: FollowUpDue, ctx: BriefContext): WaitingLine {
  return {
    description: due.commitment.description,
    counterparty: nameOf(ctx, due.commitment.committedByPersonId) ?? 'External party',
    businessDaysOverdue: due.businessDaysOverdue,
    party: due.party,
    followUpOwner: nameOf(ctx, due.followUpOwnerPersonId),
    // Through Phase 5 nothing is sent; a draft being ready is the deliverable.
    draftReady: false,
  };
}

function nameOf(ctx: BriefContext, id: string | null | undefined): string | null {
  if (!id) return null;
  return ctx.people.get(id)?.name ?? null;
}
