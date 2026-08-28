/**
 * Agent identity, lifecycle, permissions and job limits.
 *
 * Zod schemas rather than tables, for the same reason `src/sync/state.ts` is:
 * the running system stores documents today and Postgres later, and the shapes
 * should not have to change when it moves.
 *
 * The rules that matter here are all restrictions. An agent registry whose
 * interesting parts are capabilities rather than limits is a registry that will
 * eventually let something send an email.
 */
import { z } from 'zod';
import { ApprovalClass, Confidence } from '../schemas/core.js';

/**
 * Proposed is not approved, and approved is not active.
 *
 * Three separate states because they answer different questions: whether the
 * Architect recommends it, whether a human agreed, and whether it is currently
 * doing anything. Collapsing them is how a proposal quietly starts running.
 */
export const AgentStatus = z.enum([
  'proposed', 'approved', 'rejected', 'deferred', 'active', 'paused', 'retired',
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * What the Architect concluded a candidate should BE.
 *
 * Three of the four outcomes are not agents. A report that only ever returns
 * `agent` has not done the analysis the brief asked for.
 */
export const CandidateVerdict = z.enum([
  'agent',                 // own context, tools, objectives and measurement
  'capability',            // folds into a broader agent
  'deterministic_workflow',// no judgment needed; code is cheaper and safer
  'not_worth_it',          // human, external partner, or genuinely rare
]);
export type CandidateVerdict = z.infer<typeof CandidateVerdict>;

/**
 * Least privilege, enumerated.
 *
 * Read and draft are separated from send on purpose, and there is no
 * `SEND_EXTERNAL` grant available at all while `EXTERNAL_SENDING_ENABLED` is
 * false — the safe state is expressed by the absence of the permission, not by
 * a flag an agent could be configured around.
 */
export const AgentPermission = z.enum([
  'READ_OUTLOOK', 'READ_SENT_MAIL', 'CREATE_OUTLOOK_DRAFT',
  'READ_SLACK', 'DRAFT_SLACK_MESSAGE',
  'READ_ZOOM', 'READ_DRIVE',
  'READ_FINANCIAL_SIGNALS', 'READ_COMMERCE_SIGNALS', 'READ_LEDGER',
  'CREATE_TASK', 'UPDATE_TASK', 'PROPOSE_PRIORITY_CHANGE',
  'CREATE_AGENT_JOB', 'WRITE_WORLD_STATE', 'CREATE_OPPORTUNITY', 'CREATE_EXPERIMENT',
]);
export type AgentPermission = z.infer<typeof AgentPermission>;

/** Permissions no agent may hold during development, whatever it asks for. */
export const FORBIDDEN_PERMISSIONS = [
  'SEND_OUTLOOK_EMAIL', 'POST_SLACK', 'SPEND_MONEY', 'MODIFY_CAMPAIGN',
  'PLACE_ORDER', 'APPROVE_INVOICE', 'MODIFY_PRODUCTION_SYSTEM',
] as const;

/**
 * Bounds on what one agent may set in motion.
 *
 * Present on every agent rather than on the ones that look risky: an
 * unbounded agent is one prompt away from being a recursive one, and the
 * defaults here are deliberately small enough to be raised deliberately.
 */
export const AgentLimits = z.object({
  maxSubjobs: z.number().int().min(0).max(20).default(3),
  maxDepth: z.number().int().min(0).max(5).default(2),
  maxRuntimeSeconds: z.number().int().min(1).default(300),
  /** Model spend ceiling per job, in cents, so a loop cannot run up a bill. */
  budgetCents: z.number().int().min(0).default(500),
  /** Empty means it may not delegate at all. */
  allowedTargetAgents: z.array(z.string()).default([]),
});
export type AgentLimits = z.infer<typeof AgentLimits>;

export const AgentCapability = z.object({
  capability: z.string(),
  description: z.string(),
  confidence: Confidence.default(0.6),
  toolRequirements: z.array(z.string()).default([]),
});
export type AgentCapability = z.infer<typeof AgentCapability>;

/**
 * A proposal, with the evidence that produced it.
 *
 * `evidence` and `patternIds` are required rather than optional because a
 * proposal that cannot point at what it was derived from is an opinion, and
 * this whole subsystem exists to avoid shipping opinions as findings.
 */
export const AgentProposal = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  verdict: CandidateVerdict,
  mission: z.string(),
  whyItExists: z.string(),

  patternIds: z.array(z.string()).min(1),
  evidence: z.array(z.string()).min(1),
  leverageScore: z.number(),
  leverageNormalized: z.number(),

  primaryJobs: z.array(z.string()).default([]),
  humanCounterpart: z.string().nullable().default(null),
  decisionMaker: z.string().nullable().default(null),
  externalCounterparts: z.array(z.string()).default([]),

  requiredData: z.array(z.string()).default([]),
  permissions: z.array(AgentPermission).default([]),
  allowedActions: z.array(z.string()).default([]),
  disallowedActions: z.array(z.string()).default([]),
  approvalClass: ApprovalClass.default('YELLOW'),
  limits: AgentLimits.default({}),

  metrics: z.array(z.string()).default([]),
  /** Estimates are labelled as estimates; see `agent_performance` for measured. */
  estimatedHoursSavedPerMonth: z.number().nullable().default(null),
  estimatedCeoTouchesRemoved: z.number().int().nullable().default(null),
  estimatedValueAtStake: z.number().nullable().default(null),

  confidence: Confidence.default(0.5),
  /** Named overlaps, so the reviewer can see a merge candidate immediately. */
  overlapsWith: z.array(z.string()).default([]),
  /** Populated when the verdict is not `agent` — why it is not one. */
  foldsInto: z.string().nullable().default(null),
  rationaleAgainst: z.string().nullable().default(null),

  status: AgentStatus.default('proposed'),
  proposedAt: z.string(),
  decidedAt: z.string().nullable().default(null),
  decidedBy: z.string().nullable().default(null),
  decisionNote: z.string().nullable().default(null),
});
export type AgentProposal = z.infer<typeof AgentProposal>;

export const Agent = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.number().int().min(1).default(1),
  mission: z.string(),
  status: AgentStatus.default('approved'),
  proposalId: z.string().nullable().default(null),
  humanCounterpart: z.string().nullable().default(null),
  objective: z.string(),
  successDefinition: z.string(),
  capabilities: z.array(AgentCapability).default([]),
  permissions: z.array(AgentPermission).default([]),
  approvalClass: ApprovalClass.default('YELLOW'),
  limits: AgentLimits.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  retiredAt: z.string().nullable().default(null),
});
export type Agent = z.infer<typeof Agent>;

export const AgentJobStatus = z.enum([
  'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'needs_human',
]);
export type AgentJobStatus = z.infer<typeof AgentJobStatus>;

export const AgentJob = z.object({
  id: z.string(),
  agentSlug: z.string(),
  parentJobId: z.string().nullable().default(null),
  /** How deep this sits in a delegation chain. Enforced against `maxDepth`. */
  depth: z.number().int().min(0).default(0),
  triggerEventId: z.string().nullable().default(null),
  jobType: z.string(),
  objective: z.string(),
  inputContext: z.record(z.unknown()).default({}),
  constraints: z.array(z.string()).default([]),
  priority: z.number().int().default(5),
  status: AgentJobStatus.default('queued'),
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  resultId: z.string().nullable().default(null),
  budgetCents: z.number().int().default(500),
  metadata: z.record(z.unknown()).default({}),
});
export type AgentJob = z.infer<typeof AgentJob>;

export const AgentResult = z.object({
  id: z.string(),
  jobId: z.string(),
  summary: z.string(),
  findings: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  recommendedActions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  confidence: Confidence.default(0.5),
  structuredOutput: z.record(z.unknown()).default({}),
  createdAt: z.string(),
});
export type AgentResult = z.infer<typeof AgentResult>;

/**
 * How well an agent is actually doing.
 *
 * `basis` exists because the brief is right that pretending to know impact is
 * worse than admitting ignorance. A number labelled `measured` and one labelled
 * `estimated` must never be added together, and keeping the label on the record
 * is the only way that stays true as the data moves around.
 */
export const ImpactBasis = z.enum(['measured', 'estimated', 'attributed', 'unknown']);

export const AgentPerformance = z.object({
  agentSlug: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  jobsCompleted: z.number().int().default(0),
  jobsFailed: z.number().int().default(0),
  recommendationsMade: z.number().int().default(0),
  recommendationsAccepted: z.number().int().default(0),
  correctionsReceived: z.number().int().default(0),
  averageConfidence: z.number().default(0),
  hoursSaved: z.object({ value: z.number(), basis: ImpactBasis }).nullable().default(null),
  ceoTouchesRemoved: z.object({ value: z.number(), basis: ImpactBasis }).nullable().default(null),
  revenueImpact: z.object({ value: z.number(), basis: ImpactBasis }).nullable().default(null),
});
export type AgentPerformance = z.infer<typeof AgentPerformance>;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export class PermissionError extends Error {}
export class RecursionError extends Error {}

/**
 * An agent may only do what it was granted, and may never hold a forbidden
 * permission whatever the proposal claimed.
 */
export function assertPermitted(agent: Agent, permission: string): void {
  if ((FORBIDDEN_PERMISSIONS as readonly string[]).includes(permission)) {
    throw new PermissionError(
      `${permission} is not grantable to any agent: external and money-moving actions stay manual.`,
    );
  }
  if (!agent.permissions.includes(permission as AgentPermission)) {
    throw new PermissionError(
      `${agent.slug} does not hold ${permission}. Granted: ${agent.permissions.join(', ') || '(none)'}.`,
    );
  }
}

/** Strip anything forbidden before an agent is ever instantiated. */
export function sanitizePermissions(requested: string[]): {
  granted: AgentPermission[]; refused: string[];
} {
  const granted: AgentPermission[] = [];
  const refused: string[] = [];
  for (const p of requested) {
    const ok = AgentPermission.safeParse(p);
    if (ok.success && !(FORBIDDEN_PERMISSIONS as readonly string[]).includes(p)) granted.push(ok.data);
    else refused.push(p);
  }
  return { granted, refused };
}

/**
 * Can this agent delegate to that one, at this depth?
 *
 * Three independent limits, all of which must hold: depth, fan-out, and an
 * explicit allow-list. Depth alone does not stop an agent spawning fifty
 * siblings, and an allow-list alone does not stop A→B→A.
 */
export function assertCanDelegate(
  agent: Agent,
  target: string,
  currentDepth: number,
  siblingCount: number,
  chain: string[] = [],
): void {
  if (currentDepth >= agent.limits.maxDepth) {
    throw new RecursionError(
      `${agent.slug} is at depth ${currentDepth} and may not exceed ${agent.limits.maxDepth}.`,
    );
  }
  if (siblingCount >= agent.limits.maxSubjobs) {
    throw new RecursionError(
      `${agent.slug} already has ${siblingCount} subjobs, at its limit of ${agent.limits.maxSubjobs}.`,
    );
  }
  if (!agent.limits.allowedTargetAgents.includes(target)) {
    throw new RecursionError(
      `${agent.slug} may not delegate to ${target}. Allowed: ${agent.limits.allowedTargetAgents.join(', ') || '(none)'}.`,
    );
  }
  // A cycle can form even inside the depth budget, and it is the failure that
  // burns money silently rather than loudly.
  if (chain.includes(target)) {
    throw new RecursionError(
      `Delegating to ${target} would close a cycle: ${[...chain, target].join(' → ')}.`,
    );
  }
}

/** The only legal status transitions. */
const TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  proposed: ['approved', 'rejected', 'deferred'],
  deferred: ['proposed', 'approved', 'rejected'],
  approved: ['active', 'rejected'],
  rejected: ['proposed'],
  active: ['paused', 'retired'],
  paused: ['active', 'retired'],
  retired: [],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(
  proposal: AgentProposal,
  to: AgentStatus,
  by: string,
  note: string | null,
  at: string,
): AgentProposal {
  if (!canTransition(proposal.status, to)) {
    throw new Error(`${proposal.slug}: cannot go from ${proposal.status} to ${to}.`);
  }
  return AgentProposal.parse({
    ...proposal, status: to, decidedAt: at, decidedBy: by, decisionNote: note,
  });
}
