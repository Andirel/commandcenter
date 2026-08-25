/**
 * Turning remembered commitments into due nudges.
 *
 * `findDueFollowUps` has existed since the first phase and has never run,
 * because it needs something the sync could not previously provide: how many
 * times we have already chased, and when. Rebuilt from a window every morning,
 * every commitment looks like it has never been followed up, so the engine
 * would fire the first nudge daily. That is how a chasing tool becomes a
 * nagging one and gets switched off in week two.
 *
 * The ledger supplies the counters. This module is the bridge between the
 * name-shaped records the state document carries and the id-shaped ones the
 * engine works in.
 */
import type { SystemConfig } from '../schemas/config.js';
import type { Commitment } from '../schemas/tasks.js';
import type { TeamModel } from '../capabilities/graph.js';
import { findDueFollowUps, renderFollowUpNotification, type FollowUpContext } from '../followup/engine.js';
import { LedgerCommitment, type Ledger } from '../ledger/types.js';
import type { StateCommitment, StateFollowUp } from './state.js';

/** Resolve a display name to a person id, tolerating aliases and slugs. */
function personIdFor(team: TeamModel, name: string | null): string | null {
  if (!name) return null;
  const direct = team.allPeople().find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (direct) return direct.id;
  return team.getPersonByAlias(name)?.id ?? team.getPersonBySlug(name)?.id ?? null;
}

function orgIdFor(team: TeamModel, name: string | null): string | null {
  if (!name) return null;
  const direct = team.allOrganizations().find((o) => o.name.toLowerCase() === name.toLowerCase());
  return direct?.id ?? team.getOrganizationBySlug(name)?.id ?? null;
}

function toCommitment(row: StateCommitment, team: TeamModel): Commitment {
  const orgId = orgIdFor(team, row.counterparty);
  const personId = personIdFor(team, row.owedBy);
  return {
    id: row.id,
    initiativeId: null,
    taskId: null,
    // `owedBy` is whoever made the promise, which is the party we chase.
    committedByPersonId: personId,
    committedByOrganizationId: orgId,
    owedToPersonId: null,
    owedToOrganizationId: null,
    direction: row.direction,
    description: row.description,
    dueDate: row.dueDate,
    status: 'open',
    followUpOwnerPersonId: personIdFor(team, row.followUpOwner),
    lastFollowedUpAt: null,
    followUpCount: 0,
    sourceEventId: row.sourceRef,
    confidence: 0.7,
  };
}

export interface FollowUpResult {
  ledger: Ledger;
  due: StateFollowUp[];
}

/**
 * Merge this run's commitments into the ledger, then ask which are due.
 *
 * Surfacing IS the nudge: the draft is prepared and the chaser is told. So a
 * surfaced item has its counter advanced, which is what stops the same
 * commitment reappearing tomorrow and the day after.
 */
export function resolveFollowUps(
  rows: StateCommitment[],
  ledger: Ledger,
  team: TeamModel,
  config: SystemConfig,
  now: Date,
): FollowUpResult {
  const syncAt = now.toISOString();
  const byKey = new Map(ledger.commitments.map((c) => [c.key, c]));

  for (const row of rows) {
    const existing = byKey.get(row.id);
    if (existing) {
      byKey.set(row.id, LedgerCommitment.parse({
        ...existing,
        lastSeenAt: syncAt,
        // The description can be restated more precisely on a later mention;
        // the counters must not be, or the chase restarts from zero.
        commitment: { ...existing.commitment, description: row.description, dueDate: row.dueDate ?? existing.commitment.dueDate },
        quote: row.quote ?? existing.quote,
      }));
      continue;
    }
    byKey.set(row.id, LedgerCommitment.parse({
      key: row.id,
      commitment: toCommitment(row, team),
      counterpartyName: row.counterparty,
      owedByName: row.owedBy,
      firstSeenAt: syncAt,
      lastSeenAt: syncAt,
      status: 'open',
      statusChangedAt: syncAt,
      quote: row.quote,
      sourceRef: row.sourceRef,
    }));
  }

  const open = [...byKey.values()].filter((c) => c.status === 'open');
  const ctx: FollowUpContext = {
    rules: config.followupRules,
    now,
    organizations: new Map(team.allOrganizations().map((o) => [o.id, o])),
    people: new Map(team.allPeople().map((p) => [p.id, p])),
    ceoPersonId: team.getPersonBySlug(config.routingRules.ceo.person)?.id ?? null,
    // The ledger is what makes an undated promise chaseable at all.
    observedSince: new Map(open.map((c) => [c.key, c.firstSeenAt])),
  };

  const dueList = findDueFollowUps(open.map((c) => c.commitment), ctx);
  const due: StateFollowUp[] = [];

  for (const item of dueList) {
    const key = item.commitment.id;
    if (!key) continue;
    const record = byKey.get(key);
    if (!record) continue;

    due.push({
      id: key,
      description: item.commitment.description,
      counterparty: record.counterpartyName,
      owedBy: record.owedByName,
      dueDate: item.commitment.dueDate,
      businessDaysOverdue: item.businessDaysOverdue,
      attempt: item.attempt,
      followUpOwner: item.followUpOwnerPersonId ? team.getPerson(item.followUpOwnerPersonId)?.name ?? null : null,
      relationshipOwner: item.relationshipOwnerPersonId ? team.getPerson(item.relationshipOwnerPersonId)?.name ?? null : null,
      escalateToCeo: item.escalateToCeo,
      party: item.party,
      notification: renderFollowUpNotification(item, ctx),
      quote: record.quote,
    });

    byKey.set(key, LedgerCommitment.parse({
      ...record,
      commitment: { ...record.commitment, followUpCount: item.attempt, lastFollowedUpAt: syncAt },
    }));
  }

  /*
   * A commitment nobody has mentioned for a long time is not silently dropped.
   * `stale_close_action: needs_review` in followup-rules.yaml is explicit about
   * this: an unmet promise that quietly vanishes is exactly the failure the
   * commitment tracker exists to prevent.
   */
  const staleDays = config.followupRules.resolution.stale_close_business_days;
  for (const [key, record] of byKey) {
    if (record.status !== 'open') continue;
    const idle = (now.getTime() - Date.parse(record.lastSeenAt)) / 86_400_000;
    if (idle > staleDays * 1.4) {
      byKey.set(key, LedgerCommitment.parse({ ...record, status: 'dropped', statusChangedAt: syncAt }));
    }
  }

  return { ledger: { ...ledger, commitments: [...byKey.values()] }, due };
}
