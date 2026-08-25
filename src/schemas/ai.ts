/**
 * Output contracts for every AI call.
 *
 * Every model response is validated against one of these before it can touch
 * state. An invalid response is retried once, then parked as NEEDS_REVIEW --
 * it is never silently dropped and never written through unvalidated.
 */
import { z } from 'zod';
import { ActionMode, Confidence, MatchDecision, Score05 } from './core.js';
import { PersonCandidate } from './people.js';

/**
 * Cheap pre-filter. Runs before any expensive call so that newsletters,
 * receipts and automated noise never reach a large model.
 */
export const TriageResult = z.object({
  worthInterpreting: z.boolean(),
  category: z.enum([
    'business_correspondence', 'newsletter', 'automated_notification',
    'receipt', 'spam', 'out_of_office', 'calendar_only', 'personal', 'unclear',
  ]),
  reason: z.string(),
  confidence: Confidence,
});
export type TriageResult = z.infer<typeof TriageResult>;

/**
 * What an event MEANS for the business. Note `createsTask` is a judgment the
 * model must justify -- not every email is a task, and a system that thinks so
 * becomes noise within a week.
 */
export const EventInterpretation = z.object({
  summary: z.string(),
  businessArea: z.string().nullable(),
  materiality: z.enum(['none', 'low', 'moderate', 'high', 'critical']),

  createsTask: z.boolean(),
  taskTitle: z.string().nullable().default(null),
  taskDescription: z.string().nullable().default(null),

  requiredCapabilities: z.array(z.string()).default([]),
  deadline: z.string().nullable().default(null),
  valueAtStake: z.number().nullable().default(null),

  priorityHints: z.object({
    impact: Score05,
    urgency: Score05,
    risk: Score05,
    effort: Score05,
  }).nullable().default(null),

  /** Classification flags consumed by the routing engine. */
  flags: z.object({
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
  }).default({}),

  /** Suggested owner by slug. A hint for the routing engine, never a command. */
  suggestedOwnerHint: z.string().nullable().default(null),

  confidence: Confidence,
  reasoning: z.string(),
});
export type EventInterpretation = z.infer<typeof EventInterpretation>;

export const CommitmentExtraction = z.object({
  commitments: z.array(z.object({
    description: z.string(),
    direction: z.enum(['we_owe', 'they_owe', 'internal']),
    committedBy: z.string().nullable(),
    owedTo: z.string().nullable(),
    dueDate: z.string().nullable(),
    /** Explicit promise vs. inferred expectation -- affects how hard we chase. */
    explicit: z.boolean().default(true),
    confidence: Confidence,
    quote: z.string().nullable().default(null),
  })).default([]),
  confidence: Confidence,
});
export type CommitmentExtraction = z.infer<typeof CommitmentExtraction>;

export const PeopleDiscoveryResult = z.object({
  candidates: z.array(PersonCandidate).default([]),
  confidence: Confidence,
});
export type PeopleDiscoveryResult = z.infer<typeof PeopleDiscoveryResult>;

/**
 * Meeting analysis. Zoom's own action items are preserved verbatim and
 * re-evaluated -- "Adi will look into X" means someone SAID that, not that Adi
 * should own it.
 */
export const MeetingAnalysis = z.object({
  normalizedSummary: z.string(),
  decisions: z.array(z.object({
    decision: z.string(),
    reasoning: z.string().nullable(),
    madeBy: z.string().nullable(),
    confidence: Confidence,
  })).default([]),
  actionItems: z.array(z.object({
    originalText: z.string(),
    normalizedTitle: z.string(),
    description: z.string().nullable().default(null),
    /** Who the meeting attributed it to -- evidence to be re-examined. */
    attributedTo: z.string().nullable().default(null),
    requiredCapabilities: z.array(z.string()).default([]),
    businessArea: z.string().nullable().default(null),
    deadline: z.string().nullable().default(null),
    isDecision: z.boolean().default(false),
    isInformationGathering: z.boolean().default(false),
    valueAtStake: z.number().nullable().default(null),
    confidence: Confidence,
  })).default([]),
  externalOrganizationsMentioned: z.array(z.string()).default([]),
  confidence: Confidence,
});
export type MeetingAnalysis = z.infer<typeof MeetingAnalysis>;

/** Dedup adjudication when deterministic similarity is ambiguous. */
export const MatchResult = z.object({
  decision: MatchDecision,
  matchedTaskId: z.string().nullable().default(null),
  similarity: z.number().min(0).max(1),
  reason: z.string(),
  confidence: Confidence,
});
export type MatchResult = z.infer<typeof MatchResult>;

/**
 * The portfolio pass. Looks at open work as a whole rather than one task at a
 * time -- which is the only way to answer "what unblocks the most?".
 */
export const PortfolioReview = z.object({
  adjustments: z.array(z.object({
    taskId: z.string(),
    /** Bounded by max_ai_adjustment_ratio; the deterministic layer stays the backbone. */
    scoreDelta: z.number(),
    reason: z.string(),
  })).default([]),
  topCeoActions: z.array(z.object({
    taskId: z.string(),
    mode: ActionMode,
    whyItMatters: z.string(),
    whatChanged: z.string().nullable().default(null),
    recommendedNextMove: z.string(),
  })).default([]),
  delegationOpportunities: z.array(z.object({
    taskId: z.string(),
    delegateToSlug: z.string(),
    reason: z.string(),
    estimatedCeoHoursSaved: z.number().min(0).default(0),
  })).default([]),
  staleItems: z.array(z.object({ taskId: z.string(), reason: z.string() })).default([]),
  shouldDropOrDefer: z.array(z.object({ taskId: z.string(), reason: z.string() })).default([]),
  risks: z.array(z.object({ summary: z.string(), severity: Score05 })).default([]),
  opportunities: z.array(z.object({ summary: z.string(), value: Score05 })).default([]),
  confidence: Confidence,
});
export type PortfolioReview = z.infer<typeof PortfolioReview>;

/** Completion detection -- evidence-based, not checkbox-based. */
export const CompletionAssessment = z.object({
  likelyComplete: z.boolean(),
  evidence: z.string(),
  confidence: Confidence,
  /** True for consequential items: a human confirms even when the model is sure. */
  requiresHumanVerification: z.boolean().default(false),
});
export type CompletionAssessment = z.infer<typeof CompletionAssessment>;
