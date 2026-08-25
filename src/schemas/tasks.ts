/**
 * Work items.
 *
 * There is deliberately no single `assignee`. Real work at 120/Life has a
 * primary owner, a project manager, a decision maker, an approver,
 * collaborators, and often an external counterparty (docs/team-model.md §2).
 */
import { z } from 'zod';
import {
  ActionMode, ApprovalClass, CommitmentDirection, CommitmentStatus, Confidence,
  Importance, InitiativeStatus, LeverageClass, Score05, TaskCollaboratorRole, TaskStatus,
} from './core.js';

export const TaskCollaborator = z.object({
  personId: z.string(),
  role: TaskCollaboratorRole.default('contributor'),
});
export type TaskCollaborator = z.infer<typeof TaskCollaborator>;

/** The decomposed priority inputs. Stored separately so a score is explainable. */
export const PriorityInputs = z.object({
  impact: Score05.default(3),
  urgency: Score05.default(3),
  risk: Score05.default(0),
  relationship: Score05.default(0),
  ceoDependency: Score05.default(0),
  effort: Score05.default(2),
  blocker: Score05.default(0),
  strategicImportance: Score05.default(3),
});
export type PriorityInputs = z.infer<typeof PriorityInputs>;

export const Task = z.object({
  id: z.string(),
  initiativeId: z.string().nullable().default(null),
  title: z.string(),
  description: z.string().nullable().default(null),
  businessArea: z.string().nullable().default(null),

  primaryOwnerPersonId: z.string().nullable().default(null),
  projectManagerPersonId: z.string().nullable().default(null),
  decisionMakerPersonId: z.string().nullable().default(null),
  approverPersonId: z.string().nullable().default(null),
  externalCounterpartyOrganizationId: z.string().nullable().default(null),
  collaborators: z.array(TaskCollaborator).default([]),

  status: TaskStatus.default('proposed'),
  deadline: z.string().datetime().nullable().default(null),

  priority: PriorityInputs.default({}),
  basePriorityScore: z.number().default(0),
  adjustedPriorityScore: z.number().default(0),
  priorityRank: z.number().int().nullable().default(null),

  /** `ceoRequired` means Adi must be involved at all; the MODE says how much it costs. */
  ceoRequired: z.boolean().default(false),
  ceoActionMode: ActionMode.nullable().default(null),
  delegable: z.boolean().default(true),
  leverageClass: LeverageClass.nullable().default(null),

  waitingOnPersonId: z.string().nullable().default(null),
  waitingOnOrganizationId: z.string().nullable().default(null),
  waitingSince: z.string().datetime().nullable().default(null),
  followUpDate: z.string().datetime().nullable().default(null),

  sourceEventId: z.string().nullable().default(null),
  confidence: Confidence.default(0.7),
  routingReason: z.string().nullable().default(null),
  approvalClass: ApprovalClass.default('YELLOW'),

  /** Number of other open tasks this one blocks; feeds the blocker bonus. */
  blocksTaskIds: z.array(z.string()).default([]),

  completionConfidence: Confidence.nullable().default(null),
  completionEvidence: z.string().nullable().default(null),

  lastActivityAt: z.string().datetime().optional(),
  createdAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().nullable().default(null),
});
export type Task = z.infer<typeof Task>;

/** A proposed task before it has an id and a database row. */
export const TaskDraft = Task.omit({ id: true }).extend({ id: z.string().optional() });
export type TaskDraft = z.infer<typeof TaskDraft>;

export const Initiative = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  businessArea: z.string().nullable().default(null),
  objective: z.string().nullable().default(null),
  primaryOwnerPersonId: z.string().nullable().default(null),
  projectManagerPersonId: z.string().nullable().default(null),
  decisionMakerPersonId: z.string().nullable().default(null),
  status: InitiativeStatus.default('active'),
  strategicImportance: Importance.default(3),
  targetDate: z.string().nullable().default(null),
  successDefinition: z.string().nullable().default(null),
});
export type Initiative = z.infer<typeof Initiative>;

export const Commitment = z.object({
  id: z.string().optional(),
  initiativeId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),

  committedByPersonId: z.string().nullable().default(null),
  committedByOrganizationId: z.string().nullable().default(null),
  owedToPersonId: z.string().nullable().default(null),
  owedToOrganizationId: z.string().nullable().default(null),

  direction: CommitmentDirection.default('we_owe'),
  description: z.string(),
  dueDate: z.string().datetime().nullable().default(null),
  status: CommitmentStatus.default('open'),

  /** Distinct from the commitment's owner: Adi may own the relationship, Paul the chasing. */
  followUpOwnerPersonId: z.string().nullable().default(null),
  lastFollowedUpAt: z.string().datetime().nullable().default(null),
  followUpCount: z.number().int().min(0).default(0),

  sourceEventId: z.string().nullable().default(null),
  confidence: Confidence.default(0.7),
});
export type Commitment = z.infer<typeof Commitment>;
