/**
 * The follow-up engine.
 *
 * Distinguishes three roles that are frequently three different people
 * (docs/team-model.md §9):
 *
 *   relationship owner -- whose relationship it is
 *   task owner         -- who does the work
 *   follow-up owner    -- who does the chasing
 *
 * Hard rule: the system NEVER sends a message in someone else's name. When the
 * CEO owns a relationship, it prepares a draft FOR the CEO and tells the
 * tracker it is ready.
 */
import type { FollowupRulesConfig } from '../schemas/config.js';
import type { Commitment } from '../schemas/tasks.js';
import type { Organization, Person } from '../schemas/people.js';

const DAY_MS = 86_400_000;

export interface FollowUpDue {
  commitment: Commitment;
  /** Which nudge this is: 1 = first, 2 = second, 3+ = escalation. */
  attempt: number;
  businessDaysOverdue: number;
  followUpOwnerPersonId: string | null;
  relationshipOwnerPersonId: string | null;
  escalateToCeo: boolean;
  party: 'internal' | 'external';
  reason: string;
}

export interface FollowUpContext {
  rules: FollowupRulesConfig;
  now?: Date;
  organizations: Map<string, Organization>;
  people: Map<string, Person>;
  /** Task-level project managers, for the ownership resolution order. */
  taskProjectManagers?: Map<string, string | null>;
  taskPrimaryOwners?: Map<string, string | null>;
  ceoPersonId?: string | null;
  /**
   * When each commitment was first observed, by id.
   *
   * Most real commitments carry no date. "I will look into these hosts and
   * follow up" is the ordinary shape of a promise, and measuring only from a
   * due date meant those were never chased at all -- precisely the ones most
   * likely to be forgotten, since nobody wrote them down anywhere else. When
   * there is no due date, the clock starts when we first heard it.
   */
  observedSince?: Map<string, string>;
}

/**
 * Business days between two dates.
 *
 * Calendar days would make a Friday commitment "3 days overdue" on Monday and
 * trigger a nudge that reads as impatient. Holidays are not modeled -- a
 * refinement worth making once a holiday calendar exists.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let days = 0;
  const cursor = new Date(from.getTime());
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to.getTime());
  end.setUTCHours(0, 0, 0, 0);

  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}

/** Commitments due for a nudge right now. */
export function findDueFollowUps(
  commitments: Commitment[],
  ctx: FollowUpContext,
): FollowUpDue[] {
  const now = ctx.now ?? new Date();
  const out: FollowUpDue[] = [];

  for (const commitment of commitments) {
    if (commitment.status !== 'open' && commitment.status !== 'overdue') continue;
    // "we_owe" is our own work, tracked as a task. Chasing ourselves by
    // message is not what this engine is for.
    if (commitment.direction === 'we_owe') continue;

    const party = resolveParty(commitment, ctx);
    const cadence = cadenceFor(commitment, party, ctx);
    const maxFollowUps = cadence.max_followups ?? 3;
    if (commitment.followUpCount >= maxFollowUps) continue;

    // Measure from the last nudge if there was one, otherwise from the due
    // date -- otherwise a single overdue item fires every single day.
    const observed = commitment.id ? ctx.observedSince?.get(commitment.id) ?? null : null;
    const since = commitment.lastFollowedUpAt
      ? new Date(commitment.lastFollowedUpAt)
      : commitment.dueDate ? new Date(commitment.dueDate)
      : observed ? new Date(observed) : null;
    if (!since) continue;

    const elapsed = businessDaysBetween(since, now);
    const threshold = thresholdFor(commitment.followUpCount, cadence);
    if (elapsed < threshold) continue;

    // Do not re-surface an item shown recently and unchanged.
    if (commitment.lastFollowedUpAt) {
      const sinceLast = (now.getTime() - Date.parse(commitment.lastFollowedUpAt)) / DAY_MS;
      if (sinceLast < ctx.rules.escalation.suppress_repeat_days) continue;
    }

    const followUpOwnerPersonId = resolveFollowUpOwner(commitment, ctx);
    const relationshipOwnerPersonId = resolveRelationshipOwner(commitment, ctx);
    // With no due date there is nothing to be late against; the honest figure
    // is how long it has been outstanding, which is what `elapsed` measures.
    const overdue = commitment.dueDate ? businessDaysBetween(new Date(commitment.dueDate), now) : elapsed;

    out.push({
      commitment,
      attempt: commitment.followUpCount + 1,
      businessDaysOverdue: overdue,
      followUpOwnerPersonId,
      relationshipOwnerPersonId,
      escalateToCeo: shouldEscalate(commitment, overdue, ctx),
      party,
      reason: commitment.dueDate
        ? `${overdue} business ${overdue === 1 ? 'day' : 'days'} past the date they gave.`
        : `${overdue} business ${overdue === 1 ? 'day' : 'days'} outstanding, with no date ever given.`,
    });
  }

  return out.sort((a, b) => b.businessDaysOverdue - a.businessDaysOverdue);
}

function resolveParty(commitment: Commitment, ctx: FollowUpContext): 'internal' | 'external' {
  if (commitment.committedByOrganizationId) {
    const org = ctx.organizations.get(commitment.committedByOrganizationId);
    if (org && org.organizationType !== 'internal') return 'external';
    if (org) return 'internal';
  }
  if (commitment.committedByPersonId) {
    const person = ctx.people.get(commitment.committedByPersonId);
    if (person?.internalExternal === 'external') return 'external';
    if (person) return 'internal';
  }
  return 'external';
}

function cadenceFor(commitment: Commitment, party: 'internal' | 'external', ctx: FollowUpContext) {
  const base = party === 'external' ? ctx.rules.cadence.external : ctx.rules.cadence.internal;
  const importance = importanceOf(commitment, ctx);
  const override = importance ? ctx.rules.by_importance[String(importance)] : undefined;
  return { ...base, ...(override ?? {}) };
}

function importanceOf(commitment: Commitment, ctx: FollowUpContext): number | null {
  if (commitment.committedByOrganizationId) {
    return ctx.organizations.get(commitment.committedByOrganizationId)?.importance ?? null;
  }
  if (commitment.committedByPersonId) {
    return ctx.people.get(commitment.committedByPersonId)?.importanceScore ?? null;
  }
  return null;
}

function thresholdFor(followUpCount: number, cadence: ReturnType<typeof cadenceFor>): number {
  if (followUpCount === 0) return cadence.first_followup_business_days ?? 3;
  if (followUpCount === 1) {
    const second = cadence.second_followup_business_days ?? 7;
    const first = cadence.first_followup_business_days ?? 3;
    return Math.max(1, second - first);
  }
  const escalate = cadence.escalate_business_days ?? 12;
  const second = cadence.second_followup_business_days ?? 7;
  return Math.max(1, escalate - second);
}

/**
 * Who does the chasing, following the configured resolution order.
 *
 * Deliberately prefers the organization's execution tracker over the
 * relationship owner: the point is to chase without spending the relationship
 * owner's attention.
 */
export function resolveFollowUpOwner(commitment: Commitment, ctx: FollowUpContext): string | null {
  for (const step of ctx.rules.follow_up_ownership.resolution_order) {
    switch (step) {
      case 'organization.execution_tracker': {
        const org = commitment.committedByOrganizationId
          ? ctx.organizations.get(commitment.committedByOrganizationId)
          : commitment.owedToOrganizationId
            ? ctx.organizations.get(commitment.owedToOrganizationId)
            : undefined;
        if (org?.executionTrackerPersonId) return org.executionTrackerPersonId;
        break;
      }
      case 'task.project_manager': {
        const pm = commitment.taskId ? ctx.taskProjectManagers?.get(commitment.taskId) : null;
        if (pm) return pm;
        break;
      }
      case 'organization.relationship_owner': {
        const org = commitment.committedByOrganizationId
          ? ctx.organizations.get(commitment.committedByOrganizationId)
          : undefined;
        if (org?.relationshipOwnerPersonId) return org.relationshipOwnerPersonId;
        break;
      }
      case 'task.primary_owner': {
        const owner = commitment.taskId ? ctx.taskPrimaryOwners?.get(commitment.taskId) : null;
        if (owner) return owner;
        break;
      }
      default:
        break;
    }
  }
  return commitment.followUpOwnerPersonId ?? null;
}

function resolveRelationshipOwner(commitment: Commitment, ctx: FollowUpContext): string | null {
  const orgId = commitment.committedByOrganizationId ?? commitment.owedToOrganizationId;
  if (!orgId) return null;
  return ctx.organizations.get(orgId)?.relationshipOwnerPersonId ?? null;
}

function shouldEscalate(commitment: Commitment, overdueDays: number, ctx: FollowUpContext): boolean {
  for (const rule of ctx.rules.escalation.to_ceo_when) {
    if (typeof rule.importance_gte === 'number') {
      const importance = importanceOf(commitment, ctx);
      if (importance !== null && importance >= rule.importance_gte) return true;
    }
    if (typeof rule.overdue_business_days_gte === 'number' && overdueDays >= rule.overdue_business_days_gte) {
      return true;
    }
  }
  return false;
}

/**
 * Render the notification for the follow-up owner.
 *
 * Note what this says: a draft is READY, not sent. When the relationship owner
 * is someone else, the tracker is told to prompt them, never to write as them.
 */
export function renderFollowUpNotification(
  due: FollowUpDue,
  ctx: FollowUpContext,
): string {
  const counterparty =
    (due.commitment.committedByOrganizationId
      ? ctx.organizations.get(due.commitment.committedByOrganizationId)?.name
      : null) ??
    (due.commitment.committedByPersonId
      ? ctx.people.get(due.commitment.committedByPersonId)?.name
      : null) ??
    'Counterparty';

  const relationshipOwner = due.relationshipOwnerPersonId
    ? ctx.people.get(due.relationshipOwnerPersonId)?.name ?? 'the relationship owner'
    : 'the relationship owner';

  return ctx.rules.follow_up_ownership.notification_pattern
    .replace('{counterparty}', counterparty)
    .replace('{item}', due.commitment.description)
    .replace('{days}', String(due.businessDaysOverdue))
    .replace('{relationship_owner}', relationshipOwner)
    .trim();
}
