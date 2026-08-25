/**
 * The fundamental system loop (brief §11).
 *
 *   EVENT → NORMALIZE → IDENTIFY → RETRIEVE CONTEXT → INTERPRET →
 *   MATCH STATE → ROUTE → PRIORITIZE → RECOMMEND → EXECUTE IF AUTHORIZED →
 *   TRACK TO COMPLETION
 *
 * This module composes the stages. It is deliberately transport-agnostic: n8n
 * supplies events and persists results, but the decision logic lives here so it
 * can be unit-tested and replayed against historical events.
 *
 * The AI stages are injected rather than called directly, which keeps the whole
 * pipeline runnable with no API key.
 */
import type { SystemConfig } from './schemas/config.js';
import type { CanonicalEvent } from './schemas/events.js';
import type { EventInterpretation, TriageResult } from './schemas/ai.js';
import type { RoutingDecision } from './schemas/routing.js';
import type { Task, TaskDraft } from './schemas/tasks.js';
import type { MatchDecision } from './schemas/core.js';
import type { BusinessSignal } from './schemas/signals.js';
import { TeamModel } from './capabilities/graph.js';
import { discoverFromEvent, type DiscoveryResult } from './people/discovery.js';
import { isAutomatedSender } from './people/resolve.js';
import { isBulkMail } from './normalization/outlook.js';
import { isSlackNoise } from './normalization/slack.js';
import { matchTask, type MatchOutcome } from './deduplication/match.js';
import { routeOwnership, type RoutingContext } from './routing/owner-selection.js';
import { RoutingRequest } from './schemas/routing.js';
import { scoreTask } from './priority/score.js';
import { shouldAggregateAsSignal, matchHints } from './routing/hints.js';

/** AI stages, injected so the pipeline runs without an API key. */
export interface AiStages {
  triage(event: CanonicalEvent): Promise<TriageResult>;
  interpret(event: CanonicalEvent, context: unknown): Promise<EventInterpretation>;
}

export interface PipelineDeps {
  config: SystemConfig;
  team: TeamModel;
  ai: AiStages;
  /** Open tasks to match against. Supplied by the caller from the database. */
  openTasks: Task[];
  workload?: Map<string, { openTasks: number; overdueTasks: number }>;
  now?: Date;
}

export type PipelineOutcome =
  | { kind: 'skipped'; stage: string; reason: string }
  | { kind: 'signal'; signalHint: string; reason: string }
  | {
      kind: 'processed';
      discovery: DiscoveryResult;
      interpretation: EventInterpretation;
      match: MatchOutcome;
      decision: MatchDecision;
      routing: RoutingDecision | null;
      taskDraft: TaskDraft | null;
      priorityScore: number | null;
    };

export async function processEvent(
  event: CanonicalEvent,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const { config, team, ai } = deps;
  const now = deps.now ?? new Date();

  // --- Stage 0: short circuit before any model call -------------------------
  // Newsletters, receipts, bot chatter and automated senders are the bulk of
  // the volume and none of it is business state. Filtering here is the single
  // largest cost saving in the pipeline.
  const skip = shouldShortCircuit(event, config);
  if (skip) return { kind: 'skipped', stage: 'short_circuit', reason: skip };

  // --- Stage 1: identify people and organizations ---------------------------
  // Never blocks: an unknown sender becomes a provisional record and the
  // pipeline continues.
  const discovery = discoverFromEvent(event, team, config.organizations);
  const participantPersonIds = discovery.resolved.map((r) => r.personId);

  // --- Stage 2: cheap triage ------------------------------------------------
  const triage = await ai.triage(event);
  if (!triage.worthInterpreting) {
    return { kind: 'skipped', stage: 'triage', reason: `${triage.category}: ${triage.reason}` };
  }

  // --- Stage 3: interpretation ----------------------------------------------
  const interpretation = await ai.interpret(event, { participantPersonIds });

  // Not every email is a task. A system that thinks so becomes noise in a week.
  if (!interpretation.createsTask) {
    return {
      kind: 'processed',
      discovery,
      interpretation,
      match: { decision: 'IGNORE', matchedTask: null, similarity: 0, reason: 'No state change implied.', candidates: [] },
      decision: 'IGNORE',
      routing: null,
      taskDraft: null,
      priorityScore: null,
    };
  }

  if (interpretation.confidence < config.aiRouting.confidence_gates.create_task) {
    return {
      kind: 'processed',
      discovery,
      interpretation,
      match: {
        decision: 'NEEDS_REVIEW', matchedTask: null, similarity: 0,
        reason: `Interpretation confidence ${interpretation.confidence.toFixed(2)} is below the task-creation gate.`,
        candidates: [],
      },
      decision: 'NEEDS_REVIEW',
      routing: null,
      taskDraft: null,
      priorityScore: null,
    };
  }

  const title = interpretation.taskTitle ?? event.subject ?? 'Untitled';

  // --- Stage 4: build the routing request -----------------------------------
  const routingRequest = RoutingRequest.parse({
    title,
    description: interpretation.taskDescription ?? event.summary ?? null,
    businessArea: interpretation.businessArea,
    requiredCapabilities: interpretation.requiredCapabilities,
    participantPersonIds,
    attributedToPersonId: resolveAttribution(interpretation, team),
    attributionSource: event.sourceSystem,
    externalOrganizationId: event.organizationId,
    valueAtStake: interpretation.valueAtStake,
    ...interpretation.flags,
  });

  // Some patterns are business SIGNALS rather than tasks -- a recurring
  // customer complaint is a trend to act on once, not thirty tickets.
  const hints = matchHints(routingRequest, config.routingRules);
  if (shouldAggregateAsSignal(hints)) {
    return {
      kind: 'signal',
      signalHint: hints.find((h) => h.aggregate_as_signal)?.name ?? 'pattern',
      reason: 'Recognized as a recurring pattern; aggregating as a business signal rather than a task.',
    };
  }

  // --- Stage 5: match against existing state --------------------------------
  const match = matchTask(
    {
      title,
      description: routingRequest.description,
      participantPersonIds,
      initiativeId: null,
      occurredAt: event.occurredAt,
      threadId: event.threadId,
      externalOrganizationId: event.organizationId,
    },
    deps.openTasks,
  );

  // An existing task absorbs the event as evidence; we do not re-route work
  // that already has an owner just because it was mentioned again.
  if (match.decision === 'UPDATE_EXISTING' || match.decision === 'NEEDS_REVIEW') {
    return {
      kind: 'processed', discovery, interpretation, match,
      decision: match.decision, routing: null, taskDraft: null, priorityScore: null,
    };
  }

  // --- Stage 6: route -------------------------------------------------------
  const routingCtx: RoutingContext = {
    team, config,
    ...(deps.workload ? { workload: deps.workload } : {}),
  };
  const routing = routeOwnership(routingRequest, routingCtx);

  // --- Stage 7: assemble the draft and score it -----------------------------
  const taskDraft = buildTaskDraft({ title, event, interpretation, routing, now });
  const priority = scoreTask({ ...taskDraft, id: 'draft' } as Task, {
    rules: config.priorityRules,
    now,
  });

  taskDraft.basePriorityScore = priority.baseScore;
  taskDraft.adjustedPriorityScore = priority.score;

  return {
    kind: 'processed',
    discovery,
    interpretation,
    match,
    decision: routing.needsReview ? 'NEEDS_REVIEW' : 'CREATE',
    routing,
    taskDraft,
    priorityScore: priority.score,
  };
}

/** Reasons to stop before spending anything on a model call. */
function shouldShortCircuit(event: CanonicalEvent, config: SystemConfig): string | null {
  if (isAutomatedSender(event.actor?.email ?? null, config.organizations)) {
    return 'automated sender';
  }
  if ((event.sourceSystem === 'outlook' || event.sourceSystem === 'outlook_sent') && isBulkMail(event)) {
    return 'bulk or automated mail';
  }
  if (event.sourceSystem === 'slack' && isSlackNoise(event)) {
    return 'slack noise';
  }
  if (!event.subject && !event.body && !event.summary) {
    return 'no content to interpret';
  }
  return null;
}

/**
 * Resolve the interpretation's owner hint to a person id.
 *
 * This becomes `attributedToPersonId`, which the routing engine treats as
 * evidence to be re-examined -- not as an assignment.
 */
function resolveAttribution(interpretation: EventInterpretation, team: TeamModel): string | null {
  const hint = interpretation.suggestedOwnerHint;
  if (!hint) return null;
  return team.getPersonBySlug(hint)?.id ?? team.getPersonByAlias(hint)?.id ?? null;
}

function buildTaskDraft(args: {
  title: string;
  event: CanonicalEvent;
  interpretation: EventInterpretation;
  routing: RoutingDecision;
  now: Date;
}): TaskDraft {
  const { title, event, interpretation, routing, now } = args;
  const hints = interpretation.priorityHints;

  return {
    initiativeId: null,
    title,
    description: interpretation.taskDescription ?? null,
    businessArea: interpretation.businessArea,

    primaryOwnerPersonId: routing.primaryOwnerPersonId,
    projectManagerPersonId: routing.projectManagerPersonId,
    decisionMakerPersonId: routing.decisionMakerPersonId,
    approverPersonId: routing.approverPersonId,
    externalCounterpartyOrganizationId: routing.externalCounterpartyOrganizationId,
    collaborators: routing.collaborators,

    // Created as `proposed`: the system suggests, a human accepts. This is what
    // keeps an over-eager interpretation from silently becoming company state.
    status: 'proposed',
    deadline: interpretation.deadline ? toIso(interpretation.deadline) : null,

    priority: {
      impact: hints?.impact ?? 3,
      urgency: hints?.urgency ?? 3,
      risk: hints?.risk ?? 0,
      relationship: 0,
      ceoDependency: routing.ceoDependencyScore,
      effort: hints?.effort ?? 2,
      blocker: 0,
      strategicImportance: 3,
    },
    basePriorityScore: 0,
    adjustedPriorityScore: 0,
    priorityRank: null,

    ceoRequired: routing.ceoRequired,
    ceoActionMode: routing.ceoActionMode,
    delegable: routing.delegable,
    leverageClass: routing.leverage.classification,

    waitingOnPersonId: null,
    waitingOnOrganizationId: null,
    waitingSince: null,
    followUpDate: null,

    sourceEventId: event.id ?? null,
    sourceThreadId: event.threadId,
    confidence: Math.min(interpretation.confidence, routing.confidence),
    routingReason: routing.reason,
    approvalClass: routing.approvalClass,
    blocksTaskIds: [],
    completionConfidence: null,
    completionEvidence: null,
    lastActivityAt: now.toISOString(),
    createdAt: now.toISOString(),
    completedAt: null,
  };
}

function toIso(value: string): string | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Signals enter the same loop; they simply skip triage and interpretation. */
export function signalToRoutingRequest(signal: BusinessSignal): RoutingRequest {
  return RoutingRequest.parse({
    title: signal.summary,
    description: signal.evidence ?? signal.recommendedAction ?? null,
    businessArea: signal.businessArea,
    valueAtStake: signal.valueAtStake,
    // Severity does not itself make something a decision; routing decides.
    isDecision: false,
  });
}
