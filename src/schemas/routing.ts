/**
 * Contracts for the owner-selection engine and the Paul leverage engine.
 *
 * Governing question (docs/team-model.md §1):
 *   NOT "is this a CEO task?" / "what department owns this?"
 *   BUT "who is genuinely best positioned?" and "does this actually need Adi?"
 */
import { z } from 'zod';
import { ActionMode, ApprovalClass, Confidence, LeverageClass } from './core.js';
import { TaskCollaborator } from './tasks.js';

/** Everything the engine is allowed to consider. */
export const RoutingRequest = z.object({
  title: z.string(),
  description: z.string().nullable().default(null),
  businessArea: z.string().nullable().default(null),

  /** Capabilities the work genuinely needs. Drives candidate scoring. */
  requiredCapabilities: z.array(z.string()).default([]),

  /** People present in the source event -- weak evidence of involvement. */
  participantPersonIds: z.array(z.string()).default([]),

  /** Attribution from the source ("Adi will look into X"). Evidence, NOT instruction. */
  attributedToPersonId: z.string().nullable().default(null),
  attributionSource: z.string().nullable().default(null),

  initiativeId: z.string().nullable().default(null),
  externalOrganizationId: z.string().nullable().default(null),

  /** Estimated value at stake, used for approval class and CEO thresholds. */
  valueAtStake: z.number().nullable().default(null),

  /** Signals from classification that change who should be involved. */
  isDecision: z.boolean().default(false),
  isApproval: z.boolean().default(false),
  isAdministrative: z.boolean().default(false),
  isInformationGathering: z.boolean().default(false),
  isScheduling: z.boolean().default(false),
  isStatusChasing: z.boolean().default(false),
  isContractOrLegal: z.boolean().default(false),
  isHiring: z.boolean().default(false),
  isInvestorRelated: z.boolean().default(false),
  isPricingOrOffer: z.boolean().default(false),
  isPublicOrReputational: z.boolean().default(false),
  isStrategicDirection: z.boolean().default(false),

  /** An existing owner, when re-routing rather than routing fresh. */
  currentOwnerPersonId: z.string().nullable().default(null),
  priorityScore: z.number().default(0),
});
export type RoutingRequest = z.infer<typeof RoutingRequest>;

/** One candidate's score, fully decomposed so the decision can be explained. */
export const CandidateScore = z.object({
  personId: z.string(),
  slug: z.string().nullable().default(null),
  name: z.string(),
  total: z.number(),
  components: z.record(z.number()),
  disqualified: z.boolean().default(false),
  disqualificationReason: z.string().nullable().default(null),
});
export type CandidateScore = z.infer<typeof CandidateScore>;

export const LeverageAssessment = z.object({
  classification: LeverageClass,
  confidence: Confidence,
  reason: z.string(),
  /** Rough CEO-hours this hand-off would save. Gates low-value suggestions. */
  estimatedCeoHoursSaved: z.number().min(0).default(0),
  suggestedHandoff: z.string().nullable().default(null),
});
export type LeverageAssessment = z.infer<typeof LeverageAssessment>;

export const RoutingDecision = z.object({
  primaryOwnerPersonId: z.string().nullable(),
  projectManagerPersonId: z.string().nullable(),
  decisionMakerPersonId: z.string().nullable(),
  approverPersonId: z.string().nullable(),
  collaborators: z.array(TaskCollaborator).default([]),
  externalCounterpartyOrganizationId: z.string().nullable().default(null),

  ceoRequired: z.boolean(),
  ceoActionMode: ActionMode.nullable(),
  ceoDependencyScore: z.number().int().min(0).max(5),
  delegable: z.boolean(),

  leverage: LeverageAssessment,
  approvalClass: ApprovalClass,

  confidence: Confidence,
  /** Always populated. An unexplained routing decision is a bug. */
  reason: z.string(),
  /** Set when confidence is below the floor -- the engine asks rather than guesses. */
  needsReview: z.boolean().default(false),

  candidates: z.array(CandidateScore).default([]),
  engineVersion: z.string(),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;
