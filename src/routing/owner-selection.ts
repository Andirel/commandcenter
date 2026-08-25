/**
 * The owner-selection engine.
 *
 * Answers "who is genuinely best positioned to move this forward?" -- not
 * "what department does this belong to?".
 *
 * Design constraints:
 *  - No person is named in this file. Every name-specific behaviour comes from
 *    config/routing-rules.yaml and the capability graph.
 *  - Every decision produces a human-readable `reason`. Unexplained routing is
 *    a bug, not a nuance.
 *  - Below the confidence floor the engine refuses to guess and returns
 *    needsReview.
 */
import type { RoutingRulesConfig, SystemConfig } from '../schemas/config.js';
import type { CandidateScore, RoutingDecision, RoutingRequest } from '../schemas/routing.js';
import type { ActionMode } from '../schemas/core.js';
import type { Person } from '../schemas/people.js';
import { TeamModel } from '../capabilities/graph.js';
import { assessLeverage } from './leverage.js';
import { classifyApproval } from './approval.js';
import { resolveCapabilities, matchHints } from './hints.js';

export interface RoutingContext {
  team: TeamModel;
  config: SystemConfig;
  /** Current open/overdue counts keyed by person id. Falls back to Person fields. */
  workload?: Map<string, { openTasks: number; overdueTasks: number }>;
  /** People already owning work on this initiative -- continuity evidence. */
  initiativeOwners?: { primaryOwnerPersonId?: string | null; projectManagerPersonId?: string | null };
}

export function routeOwnership(req: RoutingRequest, ctx: RoutingContext): RoutingDecision {
  const { team, config } = ctx;
  const rules = config.routingRules;
  const engineVersion = rules.engine_version;

  // --- 1. Work out what the task actually requires --------------------------
  const hints = matchHints(req, rules);
  const capabilities = resolveCapabilities(req, hints, config);
  const specialistRequired = team.requiresSpecialist(capabilities);

  // --- 2. External execution partner ----------------------------------------
  // Some work is genuinely owned outside the company. An agency investigating
  // its own campaign performance is the owner of that investigation; we track
  // it, we do not perform it.
  const counterparty = resolveCounterparty(req, hints, team);

  /*
   * An external partner owns EXECUTION only when the work is the thing they do.
   *
   * A keyword hint identifies the relationship, not the direction of the work:
   * "podcast" matches both "RadioActive will source hosts" and "send our
   * interview Q&As to RadioActive". The second is ours. So external ownership
   * additionally requires that the partner's capability is actually what the
   * task needs — or that nobody internal can do it at all.
   */
  const hintedExternal = hints.some((h) => h.external_organization_capability);

  // The test is whether the PARTNER HOLDS the capability the work needs.
  // RadioActive holds podcast_advertising, so sourcing a placement is theirs;
  // it holds neither interview_support nor copywriting, so writing our own
  // interview answers is not.
  const partnerCoversWork =
    counterparty !== null &&
    (capabilities.length === 0 ||
      capabilities.some((c) => counterparty.capabilities.some((edge) => edge.capability === c)));

  const externallyOwned = counterparty !== null && hintedExternal && partnerCoversWork;

  // --- 3. Score internal candidates -----------------------------------------
  const candidates = scoreCandidates(req, capabilities, specialistRequired, ctx);
  const viable = candidates.filter((c) => !c.disqualified);
  const best = viable[0];
  const runnerUp = viable[1];

  // --- 4. CEO involvement ----------------------------------------------------
  // `ceoRequired` asks whether Adi must be involved AT ALL. The MODE says how
  // much attention that costs -- approving a run is minutes; owning it is days.
  const ceo = team.getPersonBySlug(rules.ceo.person) ?? null;
  const ceoIsBestOwner = best?.personId === ceo?.id;
  const ceoNeed = assessCeoNeed(req, rules, config, { ceoIsBestOwner, externallyOwned });

  // --- 5. Assemble ownership -------------------------------------------------
  let primaryOwnerPersonId = best?.personId ?? null;

  // Attribution ("Adi will look into X") is EVIDENCE, not instruction --
  // especially from a meeting transcript. If the attributed person is a poor
  // fit and the work is delegable, the better candidate wins.
  const attribution = evaluateAttribution(req, candidates, rules, team);
  if (attribution.honour && req.attributedToPersonId) {
    primaryOwnerPersonId = req.attributedToPersonId;
  }

  // Keeping an existing owner is preferred unless the gain is real: a handoff
  // costs context transfer and delay.
  if (req.currentOwnerPersonId && primaryOwnerPersonId !== req.currentOwnerPersonId) {
    const current = candidates.find((c) => c.personId === req.currentOwnerPersonId);
    const gain = (best?.total ?? 0) - (current?.total ?? 0);
    if (current && !current.disqualified && gain < rules.scoring.min_gain_to_reassign) {
      primaryOwnerPersonId = req.currentOwnerPersonId;
    }
  }

  // If an external partner owns execution, no internal person is the owner --
  // but someone internal must still track it.
  if (externallyOwned) primaryOwnerPersonId = null;

  // --- 6. Leverage evaluation ------------------------------------------------
  const leverage = assessLeverage({
    request: req,
    capabilities,
    specialistRequired,
    proposedOwnerPersonId: primaryOwnerPersonId,
    ceoRequired: ceoNeed.required,
    ceoActionMode: ceoNeed.mode,
    externallyOwned,
    ctx,
    hints,
  });

  const leveragePerson = team.getPersonBySlug(rules.leverage.person);

  // The leverage point becomes owner only when the classification says so AND
  // no specialist is required.
  if (leverage.classification === 'PAUL_CAN_OWN' && leveragePerson && !specialistRequired && !externallyOwned) {
    primaryOwnerPersonId = leveragePerson.id;
  }

  const projectManagerPersonId = resolveProjectManager({
    leverage, leveragePerson, primaryOwnerPersonId, counterpartyTrackerId: counterparty?.executionTrackerPersonId ?? null,
    externallyOwned, ctx,
  });

  const decisionMakerPersonId = resolveDecisionMaker(req, ceoNeed, ceo, primaryOwnerPersonId, config, team);
  const approverPersonId = ceoNeed.mode === 'APPROVE' ? (ceo?.id ?? null) : null;

  const collaborators = resolveCollaborators({
    req, capabilities, primaryOwnerPersonId, projectManagerPersonId, counterparty, team,
  });

  // --- 7. Confidence and explanation ----------------------------------------
  const confidence = computeConfidence({
    best, runnerUp, capabilities, externallyOwned, specialistRequired, hints: hints.length,
  });
  const needsReview = confidence < rules.evidence_thresholds.min_routing_confidence;

  const approvalClass = classifyApproval(req, config);

  const reason = buildReason({
    req, team, capabilities, hints, best, primaryOwnerPersonId, projectManagerPersonId,
    decisionMakerPersonId, counterparty, externallyOwned, ceoNeed, leverage, attribution,
  });

  return {
    primaryOwnerPersonId,
    projectManagerPersonId,
    decisionMakerPersonId,
    approverPersonId,
    collaborators,
    externalCounterpartyOrganizationId: counterparty?.id ?? null,
    ceoRequired: ceoNeed.required,
    ceoActionMode: ceoNeed.required ? ceoNeed.mode : null,
    ceoDependencyScore: ceoNeed.dependencyScore,
    delegable: leverage.classification !== 'ADI_REQUIRED',
    leverage,
    approvalClass,
    confidence,
    reason,
    needsReview,
    candidates,
    engineVersion,
  };
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

function scoreCandidates(
  req: RoutingRequest,
  capabilities: string[],
  specialistRequired: boolean,
  ctx: RoutingContext,
): CandidateScore[] {
  const { team, config } = ctx;
  const s = config.routingRules.scoring;
  const leverageRules = config.routingRules.leverage;
  const out: CandidateScore[] = [];

  for (const person of team.allPeople()) {
    const components: Record<string, number> = {};
    let disqualified = false;
    let disqualificationReason: string | null = null;

    if (!person.routingEligible) {
      disqualified = true;
      disqualificationReason = 'not eligible for routing';
    } else if (person.discoveryStatus === 'discovered' || person.discoveryStatus === 'inactive') {
      disqualified = true;
      disqualificationReason = `discovery status is "${person.discoveryStatus}"; not eligible to own work`;
    }

    const strength = team.matchStrength(person.id, capabilities);
    components.capability = strength * s.capability_match;

    if (team.hasPrimaryCapability(person.id, capabilities)) {
      components.primaryCapability = s.primary_capability_bonus;
    }

    // Specialist work must not fall to a generalist coordinator merely because
    // they have capacity. They may still project-manage it.
    if (specialistRequired) {
      const blocked = capabilities.some((c) => leverageRules.never_owner_of_capabilities.includes(c));
      if (blocked && person.slug === leverageRules.person) {
        disqualified = true;
        disqualificationReason = 'specialist capability required; coordinator may track but not own';
      }
      if (!disqualified && strength > 0) components.specialist = s.specialist_required_bonus;

      /*
       * Missing the specialist capability outright is disqualifying for
       * OWNERSHIP, not merely a lower score.
       *
       * matchStrength averages across the required capabilities, so someone
       * with a strong generalist capability and NOTHING on the specialist one
       * can out-average the specialist. On real data that put ASN/fulfillment
       * work on the coordinator because they scored high on "administration".
       * Averaging is right for ranking similar candidates and wrong for
       * deciding whether someone can do the job at all.
       */
      const missingSpecialist = capabilities.filter(
        (c) => team.getCapability(c)?.specialistOnly && !team.match(person.id, c),
      );
      if (!disqualified && missingSpecialist.length) {
        disqualified = true;
        disqualificationReason = `lacks required specialist capability: ${missingSpecialist.join(', ')}`;
      }
    }

    // Continuity: already carrying this initiative or this relationship.
    if (
      ctx.initiativeOwners?.primaryOwnerPersonId === person.id ||
      ctx.initiativeOwners?.projectManagerPersonId === person.id
    ) {
      components.continuity = s.continuity_bonus;
    }
    if (req.externalOrganizationId) {
      const org = team.getOrganization(req.externalOrganizationId);
      if (org?.relationshipOwnerPersonId === person.id) components.relationshipOwner = s.relationship_owner_bonus;
    }
    if (req.participantPersonIds.includes(person.id)) {
      components.recentInvolvement = s.recent_involvement_bonus;
    }

    // Workload. A real constraint, not a tiebreaker afterthought.
    const load = ctx.workload?.get(person.id) ?? {
      openTasks: person.openTaskCount, overdueTasks: person.overdueTaskCount,
    };
    components.workload = -Math.min(s.workload_penalty_cap, load.openTasks * s.workload_penalty_per_open_task);
    components.overdue = -Math.min(s.overdue_penalty_cap, load.overdueTasks * s.overdue_penalty_per_task);

    if (person.discoveryStatus === 'provisional') components.provisional = -s.provisional_person_penalty;
    if (person.internalExternal === 'external') components.external = -s.external_person_penalty;

    // Hard cap on the leverage point: past this, stop proposing them as owner.
    if (person.slug === leverageRules.person && load.openTasks >= leverageRules.max_open_tasks_hard) {
      disqualified = true;
      disqualificationReason = `at hard workload cap (${load.openTasks} open tasks)`;
    }

    const total = strength > 0 || components.continuity
      ? Object.values(components).reduce((a, b) => a + b, 0)
      : Number.NEGATIVE_INFINITY;

    out.push({
      personId: person.id,
      slug: person.slug,
      name: person.name,
      total: Number.isFinite(total) ? round(total) : -999,
      components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round(v)])),
      disqualified,
      disqualificationReason,
    });
  }

  return out.sort((a, b) => {
    if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
    return b.total - a.total;
  });
}

// ---------------------------------------------------------------------------
// CEO involvement
// ---------------------------------------------------------------------------

interface CeoNeed {
  required: boolean;
  mode: ActionMode;
  dependencyScore: number;
  reason: string;
}

/**
 * Determines whether the CEO is genuinely required, and in what mode.
 *
 * The distinction this function exists to preserve: a task where the CEO must
 * personally DO the work is expensive; a task where the CEO must APPROVE a
 * recommendation is cheap and often unblocks someone else's day.
 */
function assessCeoNeed(
  req: RoutingRequest,
  rules: RoutingRulesConfig,
  config: SystemConfig,
  ownership: { ceoIsBestOwner: boolean; externallyOwned: boolean },
): CeoNeed {
  const triggers: string[] = [];
  const spendThreshold = numericTrigger(rules.ceo.requires_ceo_when, 'spend_above') ?? Infinity;

  if (req.valueAtStake !== null && req.valueAtStake >= spendThreshold) {
    triggers.push(`value at stake (${req.valueAtStake}) is above the CEO threshold`);
  }
  if (req.isContractOrLegal) triggers.push('contract or legal matter');
  if (req.isInvestorRelated) triggers.push('investor-related');
  if (req.isHiring) triggers.push('hiring or personnel decision');
  if (req.isPricingOrOffer) triggers.push('pricing or offer change');
  if (req.isPublicOrReputational) triggers.push('publicly or reputationally sensitive');
  if (req.isStrategicDirection) triggers.push('strategic direction');

  // A business area whose typical decision maker is the CEO makes a genuine
  // DECISION a CEO matter -- but only when there is a decision to make.
  const area = req.businessArea ? config.businessAreas.business_areas[req.businessArea] : undefined;
  if (req.isDecision && area?.typical_decision_maker === rules.ceo.person) {
    triggers.push(`a decision in ${req.businessArea} normally rests with the CEO`);
  }
  if (req.isApproval) triggers.push('an approval is required');

  if (triggers.length === 0) {
    return { required: false, mode: 'AWARE', dependencyScore: 0, reason: 'no CEO trigger matched' };
  }

  // Work that is administrative in nature never needs the CEO to DO it, even
  // when the CEO must decide the outcome.
  const clerical = req.isAdministrative || req.isInformationGathering || req.isScheduling || req.isStatusChasing;

  // The mode depends on WHO DOES THE WORK, not only on what triggered CEO
  // involvement. A $40k production slip that Mike owns costs the CEO an
  // approval, not a day -- reporting that as DO would misprice the single
  // scarcest resource the system exists to protect.
  let mode: ActionMode;
  if (req.isApproval) mode = 'APPROVE';
  else if (req.isDecision) mode = 'DECIDE';
  else if (clerical) mode = 'REVIEW';
  else if (ownership.ceoIsBestOwner && !ownership.externallyOwned) mode = 'DO';
  else mode = 'APPROVE';

  // Dependency reflects how badly the business needs the CEO here, which is
  // separate from how much of the CEO's time it consumes.
  const dependencyScore = clampInt(
    2 + triggers.length + (mode === 'DECIDE' || mode === 'APPROVE' ? 1 : 0),
    1, 5,
  );

  return { required: true, mode, dependencyScore, reason: triggers.join('; ') };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

interface AttributionVerdict { honour: boolean; reason: string }

/**
 * Source attribution ("Adi will look into X", "Mike said he'd handle it") is
 * evidence about what was SAID, not a binding assignment. Meeting attribution
 * in particular is often just whoever spoke last.
 */
function evaluateAttribution(
  req: RoutingRequest,
  candidates: CandidateScore[],
  rules: RoutingRulesConfig,
  team: TeamModel,
): AttributionVerdict {
  if (!req.attributedToPersonId) return { honour: false, reason: 'no attribution' };

  const attributed = candidates.find((c) => c.personId === req.attributedToPersonId);
  if (!attributed || attributed.disqualified) {
    return { honour: false, reason: 'attributed person is not a viable owner for this work' };
  }

  // The reconsider list: work that is clerical in nature should be re-examined
  // even when a meeting attributed it to a specific person.
  const reconsider =
    (req.isInformationGathering && flag(rules.ceo.reconsider_ceo_attribution_when, 'task_is_information_gathering')) ||
    (req.isAdministrative && flag(rules.ceo.reconsider_ceo_attribution_when, 'task_is_administrative')) ||
    (req.isScheduling && flag(rules.ceo.reconsider_ceo_attribution_when, 'task_is_scheduling')) ||
    (req.isStatusChasing && flag(rules.ceo.reconsider_ceo_attribution_when, 'task_is_status_chasing'));

  if (!reconsider) {
    return { honour: true, reason: 'attribution is consistent with the work' };
  }

  const attributedPerson = team.getPerson(req.attributedToPersonId);
  const isCeo = attributedPerson?.slug === rules.ceo.person;
  const best = candidates.find((c) => !c.disqualified);
  const gain = (best?.total ?? 0) - attributed.total;

  if (isCeo && gain >= rules.scoring.min_gain_to_reassign) {
    return {
      honour: false,
      reason: 'attributed to the CEO, but the work is clerical and a better-positioned owner exists',
    };
  }
  if (gain >= rules.scoring.min_gain_to_reassign) {
    return { honour: false, reason: 'a materially better-positioned owner exists' };
  }
  return { honour: true, reason: 'attribution retained; no materially better owner' };
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

function resolveCounterparty(
  req: RoutingRequest,
  hints: ReturnType<typeof matchHints>,
  team: TeamModel,
) {
  if (req.externalOrganizationId) {
    const org = team.getOrganization(req.externalOrganizationId);
    if (org) return org;
  }
  for (const hint of hints) {
    if (!hint.external_organization_capability) continue;
    const [top] = team.organizationsWithCapability(hint.external_organization_capability);
    if (top) return top.organization;
  }
  return null;
}

function resolveProjectManager(args: {
  leverage: { classification: string };
  leveragePerson: Person | undefined;
  primaryOwnerPersonId: string | null;
  counterpartyTrackerId: string | null;
  externallyOwned: boolean;
  ctx: RoutingContext;
}): string | null {
  const { leverage, leveragePerson, primaryOwnerPersonId, counterpartyTrackerId, externallyOwned, ctx } = args;

  const trackingClasses = [
    'PAUL_CAN_PROJECT_MANAGE', 'PAUL_CAN_FOLLOW_UP', 'PAUL_CAN_PREPARE_FOR_ADI', 'PAUL_CAN_RESEARCH',
  ];

  if (leveragePerson) {
    if (trackingClasses.includes(leverage.classification)) return leveragePerson.id;
    // Work executed outside the company still needs someone inside tracking it.
    if (externallyOwned && counterpartyTrackerId) return counterpartyTrackerId;
    if (externallyOwned) return leveragePerson.id;
  }

  // An existing initiative PM keeps the role.
  const inherited = ctx.initiativeOwners?.projectManagerPersonId;
  if (inherited && inherited !== primaryOwnerPersonId) return inherited;

  return null;
}

function resolveDecisionMaker(
  req: RoutingRequest,
  ceoNeed: CeoNeed,
  ceo: Person | null,
  primaryOwnerPersonId: string | null,
  config: SystemConfig,
  team: TeamModel,
): string | null {
  if (ceoNeed.required && ceo) return ceo.id;

  const area = req.businessArea ? config.businessAreas.business_areas[req.businessArea] : undefined;
  if (area?.typical_decision_maker) {
    const person = team.getPersonBySlug(area.typical_decision_maker);
    if (person) return person.id;
  }
  // Absent a trigger, the person doing the work decides how to do it.
  return primaryOwnerPersonId;
}

function resolveCollaborators(args: {
  req: RoutingRequest;
  capabilities: string[];
  primaryOwnerPersonId: string | null;
  projectManagerPersonId: string | null;
  counterparty: { id: string } | null;
  team: TeamModel;
}): RoutingDecision['collaborators'] {
  const { req, capabilities, primaryOwnerPersonId, projectManagerPersonId, team } = args;
  const out: RoutingDecision['collaborators'] = [];
  const seen = new Set([primaryOwnerPersonId, projectManagerPersonId].filter(Boolean) as string[]);

  // People strong in a required capability who are not already in a role --
  // this is how shared work (two social creators, designer plus implementer)
  // keeps both parties attached without forcing single-owner semantics.
  for (const cap of capabilities) {
    const strong = team.candidatesFor([cap], { includeExternal: true })
      .filter(({ person, strength }) => strength >= 0.6 && !seen.has(person.id));
    for (const { person } of strong.slice(0, 2)) {
      seen.add(person.id);
      out.push({ personId: person.id, role: 'contributor' });
    }
  }

  // Participants in the source event who ended up with no role still get to
  // watch: they were in the conversation.
  for (const id of req.participantPersonIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ personId: id, role: 'watcher' });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Confidence and explanation
// ---------------------------------------------------------------------------

function computeConfidence(args: {
  best: CandidateScore | undefined;
  runnerUp: CandidateScore | undefined;
  capabilities: string[];
  externallyOwned: boolean;
  specialistRequired: boolean;
  hints: number;
}): number {
  const { best, runnerUp, capabilities, externallyOwned, specialistRequired, hints } = args;

  if (externallyOwned) return 0.85;
  if (!best || best.total <= 0) return 0.3;
  if (capabilities.length === 0) return 0.4;

  let confidence = 0.5;

  // A clear winner is a confident answer; a near-tie is not.
  const margin = best.total - (runnerUp?.total ?? 0);
  confidence += Math.min(0.25, margin * 0.05);

  // An explicit rule matched, so this is not a pure inference.
  if (hints > 0) confidence += 0.1;
  if (specialistRequired) confidence += 0.05;
  confidence += Math.min(0.1, best.total * 0.01);

  return Math.min(0.95, Math.max(0.1, round(confidence, 3)));
}

function buildReason(args: {
  req: RoutingRequest;
  team: TeamModel;
  capabilities: string[];
  hints: ReturnType<typeof matchHints>;
  best: CandidateScore | undefined;
  primaryOwnerPersonId: string | null;
  projectManagerPersonId: string | null;
  decisionMakerPersonId: string | null;
  counterparty: { name: string } | null;
  externallyOwned: boolean;
  ceoNeed: CeoNeed;
  leverage: { classification: string; reason: string };
  attribution: AttributionVerdict;
}): string {
  const {
    req, team, capabilities, hints, primaryOwnerPersonId, projectManagerPersonId,
    decisionMakerPersonId, counterparty, externallyOwned, ceoNeed, leverage, attribution,
  } = args;

  const parts: string[] = [];
  const nameOf = (id: string | null) => (id ? team.getPerson(id)?.name ?? id : null);

  if (capabilities.length) parts.push(`Requires ${capabilities.join(', ')}.`);
  for (const hint of hints) parts.push(hint.reason);

  if (externallyOwned && counterparty) {
    parts.push(`${counterparty.name} owns execution as the external partner.`);
  } else if (primaryOwnerPersonId) {
    parts.push(`${nameOf(primaryOwnerPersonId)} is best positioned to own the work.`);
  } else {
    parts.push('No clearly qualified internal owner was identified.');
  }

  if (projectManagerPersonId && projectManagerPersonId !== primaryOwnerPersonId) {
    parts.push(`${nameOf(projectManagerPersonId)} tracks it.`);
  }
  if (decisionMakerPersonId && decisionMakerPersonId !== primaryOwnerPersonId) {
    parts.push(`${nameOf(decisionMakerPersonId)} decides.`);
  }
  if (ceoNeed.required) {
    parts.push(`CEO involvement (${ceoNeed.mode}): ${ceoNeed.reason}.`);
  }
  if (req.attributedToPersonId && !attribution.honour) {
    parts.push(`Source attributed this to ${nameOf(req.attributedToPersonId)}, but ${attribution.reason}.`);
  }
  parts.push(leverage.reason);

  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------

function numericTrigger(list: Array<Record<string, unknown>>, key: string): number | null {
  for (const entry of list) {
    const v = entry[key];
    if (typeof v === 'number') return v;
  }
  return null;
}

function flag(list: Array<Record<string, unknown>>, key: string): boolean {
  return list.some((entry) => entry[key] === true);
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
