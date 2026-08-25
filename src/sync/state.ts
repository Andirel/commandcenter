/**
 * The Command Center state document.
 *
 * This is the contract between whatever produces interpreted state (a Claude
 * session today, a server later) and the UI that renders it. It is deliberately
 * a plain serializable document: it embeds into the published page, writes to
 * disk, and will map onto Postgres rows unchanged.
 */
import { z } from 'zod';
import { ActionMode, ApprovalClass, Confidence, LeverageClass } from '../schemas/core.js';

export const StateTask = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable().default(null),
  source: z.enum(['Outlook', 'Zoom', 'Slack', 'Signal', 'Manual']),
  sourceRef: z.string().nullable().default(null),
  link: z.string().nullable().default(null),
  occurredAt: z.string(),

  businessArea: z.string().nullable().default(null),
  requiredCapabilities: z.array(z.string()).default([]),

  primaryOwner: z.string().nullable().default(null),
  projectManager: z.string().nullable().default(null),
  decisionMaker: z.string().nullable().default(null),
  externalParty: z.string().nullable().default(null),
  collaborators: z.array(z.string()).default([]),

  ceoRequired: z.boolean().default(false),
  ceoActionMode: ActionMode.nullable().default(null),
  leverageClass: LeverageClass.nullable().default(null),
  approvalClass: ApprovalClass.default('YELLOW'),
  delegable: z.boolean().default(true),

  deadline: z.string().nullable().default(null),
  valueAtStake: z.number().nullable().default(null),

  score: z.number().default(0),
  rank: z.number().int().nullable().default(null),
  drivers: z.array(z.string()).default([]),

  routingReason: z.string().default(''),
  /** What the source claimed, when the engine disagreed. Shown, not hidden. */
  attributedTo: z.string().nullable().default(null),
  attributionOverridden: z.boolean().default(false),

  confidence: Confidence.default(0.7),
  needsReview: z.boolean().default(false),
  /**
   * Set when this closely matches an existing task but not closely enough to
   * merge safely. The record is kept — merging on a guess destroys
   * information — but the UI groups it under the primary rather than showing
   * two near-identical items at the top of the queue.
   */
  possibleDuplicateOf: z.string().nullable().default(null),
  duplicateSimilarity: z.number().nullable().default(null),
  /** True when a model interpreted the body; false when routed on metadata only. */
  interpreted: z.boolean().default(false),
});
export type StateTask = z.infer<typeof StateTask>;

export const StateCommitment = z.object({
  id: z.string(),
  description: z.string(),
  direction: z.enum(['we_owe', 'they_owe', 'internal']),
  counterparty: z.string().nullable().default(null),
  owedBy: z.string().nullable().default(null),
  dueDate: z.string().nullable().default(null),
  businessDaysOutstanding: z.number().int().default(0),
  followUpOwner: z.string().nullable().default(null),
  relationshipOwner: z.string().nullable().default(null),
  explicit: z.boolean().default(true),
  quote: z.string().nullable().default(null),
  sourceRef: z.string().nullable().default(null),
});
export type StateCommitment = z.infer<typeof StateCommitment>;

export const StateTriageRow = z.object({
  subject: z.string(),
  kept: z.boolean(),
  reason: z.string(),
  at: z.string(),
});
export type StateTriageRow = z.infer<typeof StateTriageRow>;

export const StateMeeting = z.object({
  uuid: z.string().nullable().default(null),
  topic: z.string(),
  at: z.string(),
  attendees: z.array(z.string()).default([]),
  actionItemCount: z.number().int().default(0),
  decisions: z.array(z.string()).default([]),
});
export type StateMeeting = z.infer<typeof StateMeeting>;

export const StateSignal = z.object({
  signalType: z.string(),
  businessArea: z.string().nullable().default(null),
  severity: z.number().int().min(1).max(10),
  summary: z.string(),
  evidence: z.string().nullable().default(null),
  recommendedAction: z.string().nullable().default(null),
  likelyPeople: z.array(z.string()).default([]),
  valueAtStake: z.number().nullable().default(null),
});
export type StateSignal = z.infer<typeof StateSignal>;

/**
 * Headline figures the Business panel renders.
 *
 * Split deliberately by what is TRUE rather than by what is recent. `closed` is
 * the newest month whose books have closed, so its profit is real. `open` is
 * the month in progress, whose revenue is broadly current but whose expenses
 * are not — so it carries no profit figure at all.
 */
export const StateFinance = z.object({
  closed: z.object({
    period: z.string(),
    netSales: z.number(),
    netProfit: z.number(),
    paidAds: z.number(),
    priorPeriod: z.string().nullable().default(null),
    priorNetProfit: z.number().nullable().default(null),
    dailyNetSales: z.number().nullable().default(null),
    priorDailyNetSales: z.number().nullable().default(null),
  }).nullable().default(null),

  open: z.object({
    period: z.string(),
    daysElapsed: z.number().int(),
    /** Revenue only. There is deliberately no profit field here. */
    netSales: z.number(),
    closesOn: z.string(),
  }).nullable().default(null),

  /** Order-level, unaffected by the accounting close. */
  dailySales: z.array(z.object({ day: z.string(), value: z.number() })).default([]),
  salesChangeRatio: z.number().nullable().default(null),

  /** Site funnel. Compared in multi-week blocks; weekly counts are too noisy. */
  traffic: z.object({
    recentSessions: z.number(), priorSessions: z.number(),
    recentRate: z.number(), priorRate: z.number(),
    weeks: z.number().int(), sigma: z.number(),
    weekly: z.array(z.object({ week: z.string(), sessions: z.number(), rate: z.number() })).default([]),
  }).nullable().default(null),

  /** Email judged on revenue per recipient, not open rate. */
  email: z.object({
    totalRevenue: z.number(), totalRecipients: z.number(),
    windowDays: z.number().int().default(30),
    flows: z.array(z.object({
      name: z.string(), recipients: z.number(), revenue: z.number(),
      revenuePerRecipient: z.number(), openRate: z.number(), clickRate: z.number(),
    })).default([]),
  }).nullable().default(null),
}).nullable();
export type StateFinance = z.infer<typeof StateFinance>;

/**
 * One thing the company could do, grounded in what actually happened.
 *
 * A proposal is not a task. It is a choice put to the CEO, and it only becomes
 * work once accepted — at which point `generates` is routed through the same
 * owner-selection engine everything else uses, so a chosen strategy arrives
 * with real owners rather than as a note.
 */
export const StateProposal = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  /** The specific facts it rests on. A proposal with no basis is an opinion. */
  basis: z.array(z.string()).default([]),
  horizon: z.enum(['now', 'quarter', 'year']),
  expectedImpact: z.number().int().min(1).max(5),
  effort: z.number().int().min(1).max(5),
  businessArea: z.string().nullable().default(null),
  valueAtStake: z.number().nullable().default(null),
  confidence: Confidence.default(0.6),

  /** What accepting it would create. Routed on selection, not before. */
  generates: z.array(z.object({
    title: z.string(),
    description: z.string().nullable().default(null),
    businessArea: z.string().nullable().default(null),
    requiredCapabilities: z.array(z.string()).default([]),
    isDecision: z.boolean().default(false),
    isApproval: z.boolean().default(false),
    isStrategicDirection: z.boolean().default(false),
    isPricingOrOffer: z.boolean().default(false),
    isInformationGathering: z.boolean().default(false),
    valueAtStake: z.number().nullable().default(null),
  })).default([]),
});
export type StateProposal = z.infer<typeof StateProposal>;

export const CommandCenterState = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  /** How the state was produced — the UI tells the reader which it is. */
  producedBy: z.enum(['session', 'api', 'metadata-only']),
  window: z.object({ from: z.string(), to: z.string() }),

  tasks: z.array(StateTask).default([]),
  commitments: z.array(StateCommitment).default([]),
  triage: z.array(StateTriageRow).default([]),
  meetings: z.array(StateMeeting).default([]),
  signals: z.array(StateSignal).default([]),
  proposals: z.array(StateProposal).default([]),
  finance: StateFinance.default(null),

  counts: z.object({
    mailSeen: z.number().int().default(0),
    mailKept: z.number().int().default(0),
    meetingsSeen: z.number().int().default(0),
    actionItems: z.number().int().default(0),
    tasksCreated: z.number().int().default(0),
    duplicatesMerged: z.number().int().default(0),
    needsReview: z.number().int().default(0),
  }).default({}),

  /** Populated when a stage failed; the UI says so rather than pretending. */
  problems: z.array(z.object({ stage: z.string(), detail: z.string() })).default([]),
});
export type CommandCenterState = z.infer<typeof CommandCenterState>;

export function emptyState(producedBy: CommandCenterState['producedBy'] = 'metadata-only'): CommandCenterState {
  const now = new Date().toISOString();
  return CommandCenterState.parse({
    version: 1,
    generatedAt: now,
    producedBy,
    window: { from: now, to: now },
  });
}
