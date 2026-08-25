/**
 * The leverage engine.
 *
 * Explicitly answers, for every task: can the coordinator take this off the
 * CEO's plate -- and if not entirely, which part of it?
 *
 * The person filling this role is named in config/routing-rules.yaml
 * (`leverage.person`), never here.
 */
import type { LeverageAssessment, RoutingRequest } from '../schemas/routing.js';
import type { ActionMode, LeverageClass } from '../schemas/core.js';
import type { RoutingContext } from './owner-selection.js';
import type { Hint } from './hints.js';

export interface LeverageInput {
  request: RoutingRequest;
  capabilities: string[];
  specialistRequired: boolean;
  proposedOwnerPersonId: string | null;
  ceoRequired: boolean;
  ceoActionMode: ActionMode;
  externallyOwned: boolean;
  ctx: RoutingContext;
  hints: Hint[];
}

export function assessLeverage(input: LeverageInput): LeverageAssessment {
  const { request: req, capabilities, specialistRequired, ceoRequired, ceoActionMode, externallyOwned, ctx } = input;
  const rules = ctx.config.routingRules.leverage;
  const team = ctx.team;

  const person = team.getPersonBySlug(rules.person);
  if (!person) {
    return {
      classification: 'SPECIALIST_REQUIRED',
      confidence: 0.4,
      reason: 'No leverage coordinator is configured.',
      estimatedCeoHoursSaved: 0,
      suggestedHandoff: null,
    };
  }

  const load = ctx.workload?.get(person.id) ?? {
    openTasks: person.openTaskCount, overdueTasks: person.overdueTaskCount,
  };

  // Guardrail: the leverage point is a person, not a queue. Past the hard cap
  // we stop proposing them at all.
  if (load.openTasks >= rules.max_open_tasks_hard) {
    return {
      classification: specialistRequired ? 'SPECIALIST_REQUIRED' : 'ADI_REQUIRED',
      confidence: 0.7,
      reason: `${person.name} is at capacity (${load.openTasks} open tasks); do not add ownership.`,
      estimatedCeoHoursSaved: 0,
      suggestedHandoff: null,
    };
  }

  // Never duplicate work a specialist already performs. "Paul should follow up
  // on the invoice" is a tempting suggestion that adds a task and no value,
  // because Peter simply pays it.
  for (const rule of rules.do_not_duplicate) {
    if (capabilities.includes(rule.capability)) {
      return {
        classification: 'SPECIALIST_REQUIRED',
        confidence: 0.9,
        reason: rule.reason,
        estimatedCeoHoursSaved: 0,
        suggestedHandoff: null,
      };
    }
  }

  // Past the soft cap the coordinator can still take work, but the suggestion
  // is made with lower confidence and says so.
  const atSoftCap = load.openTasks >= rules.max_open_tasks_soft;

  // An explicit hint wins over inference -- but not over workload. A hint says
  // what KIND of work this is, not that the person has room for it.
  const hinted = input.hints.find((h) => h.leverage_hint)?.leverage_hint;
  if (hinted && !specialistRequired) {
    return {
      classification: hinted,
      confidence: atSoftCap ? 0.65 : 0.85,
      reason: atSoftCap
        ? `${person.name} can take this on, but is already carrying ${load.openTasks} open items.`
        : `${person.name} can take this on: it is coordination work, not specialist or CEO work.`,
      estimatedCeoHoursSaved: estimateHoursSaved(req, hinted),
      suggestedHandoff: person.slug,
    };
  }

  // Work executed outside the company: the coordinator tracks materials and
  // deadlines rather than owning delivery.
  if (externallyOwned) {
    return {
      classification: 'PAUL_CAN_PROJECT_MANAGE',
      confidence: 0.85,
      reason: `An external partner executes; ${person.name} tracks materials, deadlines and follow-up.`,
      estimatedCeoHoursSaved: estimateHoursSaved(req, 'PAUL_CAN_PROJECT_MANAGE'),
      suggestedHandoff: person.slug,
    };
  }

  // The CEO must decide, but assembling the inputs is not CEO work.
  if (ceoRequired && (ceoActionMode === 'DECIDE' || ceoActionMode === 'APPROVE')) {
    const classification: LeverageClass = specialistRequired
      ? 'PAUL_CAN_PROJECT_MANAGE'
      : 'PAUL_CAN_PREPARE_FOR_ADI';
    return {
      classification,
      confidence: 0.8,
      reason: specialistRequired
        ? `A specialist executes and the CEO decides; ${person.name} tracks it.`
        : `The CEO makes the call, but ${person.name} can assemble the inputs and track execution.`,
      estimatedCeoHoursSaved: estimateHoursSaved(req, classification),
      suggestedHandoff: person.slug,
    };
  }

  // The CEO must genuinely do this themselves.
  if (ceoRequired && ceoActionMode === 'DO') {
    return {
      classification: 'ADI_REQUIRED',
      confidence: 0.75,
      reason: 'This requires the CEO personally; it is not delegable as specified.',
      estimatedCeoHoursSaved: 0,
      suggestedHandoff: null,
    };
  }

  // Specialist work: track, do not own.
  if (specialistRequired) {
    const blocked = capabilities.some((c) => rules.never_owner_of_capabilities.includes(c));
    return {
      classification: blocked && rules.can_project_manage_when_specialist_owns
        ? 'PAUL_CAN_PROJECT_MANAGE'
        : 'SPECIALIST_REQUIRED',
      confidence: 0.8,
      reason: blocked
        ? `Specialist execution required; ${person.name} can project-manage but should not own it.`
        : 'Specialist execution required.',
      estimatedCeoHoursSaved: estimateHoursSaved(req, 'PAUL_CAN_PROJECT_MANAGE'),
      suggestedHandoff: blocked ? person.slug : null,
    };
  }

  // Everything the coordinator can genuinely own end-to-end.
  const ownable = capabilities.length > 0 && capabilities.every((c) => rules.can_own_capabilities.includes(c));
  const strength = team.matchStrength(person.id, capabilities);

  if (ownable && strength > 0.5) {
    const classification = pickOwnershipFlavour(req);
    const hours = estimateHoursSaved(req, classification);
    if (hours < rules.min_leverage_value) {
      return {
        classification,
        confidence: 0.6,
        reason: `${person.name} could take this, though the time it frees is small.`,
        estimatedCeoHoursSaved: hours,
        suggestedHandoff: person.slug,
      };
    }
    return {
      classification,
      confidence: atSoftCap ? 0.65 : 0.85,
      reason: atSoftCap
        ? `${person.name} can own this, but is already carrying ${load.openTasks} open items.`
        : `${person.name} can own this end-to-end; it needs coordination, not specialist expertise.`,
      estimatedCeoHoursSaved: hours,
      suggestedHandoff: person.slug,
    };
  }

  if (strength > 0.3) {
    return {
      classification: 'PAUL_CAN_FOLLOW_UP',
      confidence: 0.6,
      reason: `${person.name} can at least carry the follow-up.`,
      estimatedCeoHoursSaved: estimateHoursSaved(req, 'PAUL_CAN_FOLLOW_UP'),
      suggestedHandoff: person.slug,
    };
  }

  return {
    classification: 'SPECIALIST_REQUIRED',
    confidence: 0.55,
    reason: 'This needs capability the coordinator does not have.',
    estimatedCeoHoursSaved: 0,
    suggestedHandoff: null,
  };
}

/** Which flavour of ownership best describes the work. */
function pickOwnershipFlavour(req: RoutingRequest): LeverageClass {
  if (req.isInformationGathering) return 'PAUL_CAN_RESEARCH';
  if (req.isStatusChasing) return 'PAUL_CAN_FOLLOW_UP';
  return 'PAUL_CAN_OWN';
}

/**
 * Rough CEO-hours a hand-off frees. Coarse on purpose -- it exists to filter
 * out suggestions not worth making, not to be an estimate anyone relies on.
 */
function estimateHoursSaved(req: RoutingRequest, classification: LeverageClass): number {
  const base: Record<LeverageClass, number> = {
    PAUL_CAN_OWN: 2.0,
    PAUL_CAN_PROJECT_MANAGE: 1.5,
    PAUL_CAN_PREPARE_FOR_ADI: 1.5,
    PAUL_CAN_RESEARCH: 2.0,
    PAUL_CAN_FOLLOW_UP: 0.75,
    SPECIALIST_REQUIRED: 0,
    ADI_REQUIRED: 0,
  };
  let hours = base[classification];
  // Administrative work is where a coordinator saves the most; a decision the
  // CEO still has to make saves less than it looks.
  if (req.isAdministrative) hours *= 1.5;
  if (req.isScheduling) hours *= 1.25;
  if (req.isDecision) hours *= 0.6;
  return Math.round(hours * 4) / 4;
}
