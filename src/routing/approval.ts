/**
 * Approval classification.
 *
 * GREEN  -- potentially automatable once reliability is demonstrated
 * YELLOW -- a human approves before anything leaves the building
 * RED    -- always manual, never automated under any policy
 *
 * Escalation is strictly one-directional: a RED match can never be downgraded
 * by a later GREEN match. Getting this backwards is how an AI system ends up
 * auto-sending something about a contract.
 */
import type { SystemConfig } from '../schemas/config.js';
import type { ApprovalClass } from '../schemas/core.js';
import type { RoutingRequest } from '../schemas/routing.js';

const RANK: Record<ApprovalClass, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

export function escalate(a: ApprovalClass, b: ApprovalClass): ApprovalClass {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface ApprovalContext {
  /** True when we have no correspondence history with the recipient. */
  isNewContact?: boolean;
  /** Set when a message would be sent; affects nothing about internal tasks. */
  createsExternalMessage?: boolean;
}

export function classifyApproval(
  req: RoutingRequest,
  config: SystemConfig,
  ctx: ApprovalContext = {},
): ApprovalClass {
  const { triggers } = config.approvalRules;
  const text = `${req.title} ${req.description ?? ''}`.toLowerCase();

  let cls: ApprovalClass = 'GREEN';

  // --- RED ------------------------------------------------------------------
  // Structural flags first: these do not depend on wording.
  if (req.isContractOrLegal || req.isInvestorRelated || req.isHiring || req.isPublicOrReputational) {
    cls = 'RED';
  }
  if (triggers.red_keywords.some((k) => text.includes(k.toLowerCase()))) cls = 'RED';
  if (req.valueAtStake !== null && req.valueAtStake >= triggers.red_when_amount_above) cls = 'RED';

  // --- YELLOW ---------------------------------------------------------------
  if (cls !== 'RED') {
    if (req.isPricingOrOffer) cls = escalate(cls, 'YELLOW');
    if (triggers.yellow_keywords.some((k) => text.includes(k.toLowerCase()))) cls = escalate(cls, 'YELLOW');
    if (req.valueAtStake !== null && req.valueAtStake >= triggers.yellow_when_amount_above) {
      cls = escalate(cls, 'YELLOW');
    }
    // A first message to someone we have never corresponded with is never GREEN.
    if (triggers.yellow_when_new_contact && ctx.isNewContact) cls = escalate(cls, 'YELLOW');
    // Any external counterparty means a relationship is at stake.
    if (req.externalOrganizationId) cls = escalate(cls, 'YELLOW');
  }

  return cls;
}

/**
 * The single gate every outbound action passes through.
 *
 * Returns the reason it is blocked, or null when permitted. The global switches
 * are checked FIRST so that flipping `external_sending_enabled` to false halts
 * everything regardless of class.
 */
export function canActAutonomously(
  cls: ApprovalClass,
  config: SystemConfig,
  action: 'send_external' | 'create_draft' | 'post_internal',
): string | null {
  const g = config.approvalRules.global;

  if (action === 'send_external' && !g.external_sending_enabled) {
    return 'external sending is disabled system-wide';
  }
  if (action === 'create_draft' && !g.draft_creation_enabled) {
    return 'draft creation is disabled system-wide';
  }
  if (action === 'post_internal' && !g.internal_slack_posting_enabled) {
    return 'internal posting is disabled system-wide';
  }

  const def = config.approvalRules.classes[cls];
  if (!def) return `unknown approval class "${cls}"`;
  if (def.never_automate) return `${cls} actions are never automated`;
  if (def.requires_human_approval) return `${cls} actions require human approval`;

  return null;
}

/** Who approves this, by business area, escalating to the CEO above a value threshold. */
export function resolveApprover(
  businessArea: string | null,
  valueAtStake: number | null,
  config: SystemConfig,
): string {
  const { approvers } = config.approvalRules;
  if (valueAtStake !== null && valueAtStake >= approvers.ceo_approval_required_above) {
    return approvers.default;
  }
  if (businessArea && approvers.by_business_area[businessArea]) {
    return approvers.by_business_area[businessArea] as string;
  }
  return approvers.default;
}
