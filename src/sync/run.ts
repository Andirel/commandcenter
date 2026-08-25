/**
 * The sync orchestrator.
 *
 * Takes normalized events, runs the full loop, and produces the state document
 * the Command Center renders:
 *
 *   events → triage → interpret → match → route → score → rank → state
 *
 * Interpretation is optional. Without an AI client the loop still runs on
 * metadata alone and marks every task `interpreted: false`, so the UI can say
 * plainly which mode produced the result rather than implying more confidence
 * than the run earned.
 */
import type { SystemConfig } from '../schemas/config.js';
import type { CanonicalEvent } from '../schemas/events.js';
import type { Task } from '../schemas/tasks.js';
import type { EventInterpretation } from '../schemas/ai.js';
import { TeamModel } from '../capabilities/graph.js';
import { routeOwnership } from '../routing/owner-selection.js';
import { matchHints, shouldAggregateAsSignal } from '../routing/hints.js';
import { matchTask } from '../deduplication/match.js';
import { scoreTask } from '../priority/score.js';
import { rankTasks } from '../priority/rank.js';
import { discoverFromEvent } from '../people/discovery.js';
import { isAutomatedSender } from '../people/resolve.js';
import { isBulkMail } from '../normalization/outlook.js';
import { isSlackNoise } from '../normalization/slack.js';
import { RoutingRequest } from '../schemas/routing.js';
import { Task as TaskSchema } from '../schemas/tasks.js';
import type { StageContext, InterpretationRecord } from '../ai/stages.js';
import { interpretEvent, triage, teamContext, capabilityContext } from '../ai/stages.js';
import { CommandCenterState, StateTask, type StateCommitment, type StateMeeting } from './state.js';

export interface SyncInput {
  events: CanonicalEvent[];
  meetings?: StateMeeting[];
  commitments?: StateCommitment[];
  config: SystemConfig;
  team: TeamModel;
  /** Omit to run metadata-only. */
  ai?: StageContext;
  now?: Date;
  window?: { from: string; to: string };
}

export interface SyncOutput {
  state: CommandCenterState;
  interpretations: InterpretationRecord[];
}

export async function runSync(input: SyncInput): Promise<SyncOutput> {
  const { config, team } = input;
  const now = input.now ?? new Date();
  const interpretations: InterpretationRecord[] = input.ai?.log ?? [];
  const problems: Array<{ stage: string; detail: string }> = [];

  const triageRows: CommandCenterState['triage'] = [];
  const drafts: Array<{ task: Task; state: StateTask }> = [];
  const accepted: Task[] = [];

  let mailSeen = 0, mailKept = 0, duplicates = 0, needsReview = 0;

  for (const event of input.events) {
    const isMail = event.sourceSystem === 'outlook' || event.sourceSystem === 'outlook_sent';
    if (isMail) mailSeen++;

    // --- Stage 0: short circuit, before anything expensive -------------------
    const dropped = shortCircuit(event, config);
    if (dropped) {
      if (isMail) triageRows.push({ subject: event.subject ?? '(no subject)', kept: false, reason: dropped, at: event.occurredAt });
      continue;
    }

    // --- Stage 1: identity, never blocking -----------------------------------
    const discovery = discoverFromEvent(event, team, config.organizations);
    const participantPersonIds = discovery.resolved.map((r) => r.personId);

    // --- Stage 2 & 3: triage and interpretation ------------------------------
    let interpretation: EventInterpretation | null = null;

    if (input.ai) {
      const eventKey = event.sourceExternalId ?? `${event.sourceSystem}:${event.occurredAt}`;

      const t = await triage(input.ai, {
        __key: eventKey,
        from: event.actor?.email ?? event.actor?.name ?? 'unknown',
        subject: event.subject ?? '',
        headers: JSON.stringify(event.metadata.headers ?? {}),
        preview: (event.summary ?? event.body ?? '').slice(0, 1200),
      });
      if (t.ok && !t.value.worthInterpreting) {
        if (isMail) triageRows.push({ subject: event.subject ?? '(no subject)', kept: false, reason: t.value.category, at: event.occurredAt });
        continue;
      }
      if (!t.ok) problems.push({ stage: 'triage', detail: t.error });

      const r = await interpretEvent(input.ai, {
        __key: eventKey,
        capabilities: capabilityContext(config),
        team_context: teamContext(config),
        thread_history: '(not assembled in this run)',
        related_tasks: accepted.slice(0, 12).map((x) => `- ${x.title}`).join('\n'),
        from: event.actor?.email ?? 'unknown',
        to: event.participants.map((p) => p.email ?? p.name).filter(Boolean).join(', '),
        date: event.occurredAt,
        subject: event.subject ?? '',
        body: (event.body ?? event.summary ?? '').slice(0, 6000),
      });

      if (r.ok) {
        interpretation = r.value;
      } else {
        /*
         * Interpretation was ATTEMPTED and FAILED. That is different from a run
         * that deliberately never interprets, and must not quietly degrade into
         * one: the resulting task would be indistinguishable from a considered
         * metadata-only result while actually resting on a subject line the
         * model could not make sense of. Hold it for review instead.
         */
        problems.push({ stage: 'interpretation', detail: r.error });
        needsReview++;
        if (isMail) {
          triageRows.push({
            subject: event.subject ?? '(no subject)',
            kept: false,
            reason: 'interpretation failed — held for review',
            at: event.occurredAt,
          });
        }
        continue;
      }
    }

    // Interpretation may decide this changes nothing. That is a real answer.
    if (interpretation && !interpretation.createsTask) {
      if (isMail) triageRows.push({ subject: event.subject ?? '(no subject)', kept: false, reason: 'no action implied', at: event.occurredAt });
      continue;
    }
    if (interpretation && interpretation.confidence < config.aiRouting.confidence_gates.create_task) {
      needsReview++;
      if (isMail) triageRows.push({ subject: event.subject ?? '(no subject)', kept: false, reason: 'low confidence — held for review', at: event.occurredAt });
      continue;
    }

    if (isMail) { mailKept++; triageRows.push({ subject: event.subject ?? '(no subject)', kept: true, reason: interpretation ? 'interpreted' : 'routed on metadata', at: event.occurredAt }); }

    // --- Stage 4: routing request --------------------------------------------
    const title = interpretation?.taskTitle ?? event.subject ?? 'Untitled';
    const attributedId = resolveAttribution(event, interpretation, team);

    const request = RoutingRequest.parse({
      title,
      description: interpretation?.taskDescription ?? event.summary ?? null,
      businessArea: interpretation?.businessArea ?? null,
      requiredCapabilities: interpretation?.requiredCapabilities ?? [],
      participantPersonIds,
      attributedToPersonId: attributedId,
      attributionSource: event.sourceSystem,
      externalOrganizationId: event.organizationId,
      valueAtStake: interpretation?.valueAtStake ?? null,
      ...(interpretation?.flags ?? {}),
    });

    // Recurring patterns are signals, not tasks.
    if (shouldAggregateAsSignal(matchHints(request, config.routingRules))) continue;

    // --- Stage 5: dedup ------------------------------------------------------
    const match = matchTask(
      {
        title,
        description: request.description,
        participantPersonIds,
        initiativeId: null,
        occurredAt: event.occurredAt,
        threadId: event.threadId,
        externalOrganizationId: event.organizationId,
      },
      accepted,
    );
    if (match.decision === 'UPDATE_EXISTING') { duplicates++; continue; }

    // NEEDS_REVIEW keeps the record but marks the suspected relationship, so
    // the queue can group rather than repeat.
    let possibleDuplicateOf: string | null = null;
    let duplicateSimilarity: number | null = null;
    if (match.decision === 'NEEDS_REVIEW' && match.matchedTask) {
      needsReview++;
      possibleDuplicateOf = match.matchedTask.id;
      duplicateSimilarity = match.similarity;
    } else if (match.decision === 'NEEDS_REVIEW') {
      needsReview++;
    }

    // --- Stage 6 & 7: route and score ----------------------------------------
    const routing = routeOwnership(request, { team, config });
    const hints = interpretation?.priorityHints;

    const task = TaskSchema.parse({
      id: event.sourceExternalId ?? `${event.sourceSystem}:${event.occurredAt}`,
      title,
      description: request.description,
      businessArea: request.businessArea,
      primaryOwnerPersonId: routing.primaryOwnerPersonId,
      projectManagerPersonId: routing.projectManagerPersonId,
      decisionMakerPersonId: routing.decisionMakerPersonId,
      approverPersonId: routing.approverPersonId,
      externalCounterpartyOrganizationId: routing.externalCounterpartyOrganizationId,
      collaborators: routing.collaborators,
      status: 'proposed',
      deadline: interpretation?.deadline ? isoOrNull(interpretation.deadline) : null,
      priority: {
        impact: hints?.impact ?? 3,
        urgency: hints?.urgency ?? 3,
        risk: hints?.risk ?? 0,
        relationship: routing.externalCounterpartyOrganizationId ? 2 : 0,
        ceoDependency: routing.ceoDependencyScore,
        effort: hints?.effort ?? 2,
        blocker: 0,
        strategicImportance: 3,
      },
      ceoRequired: routing.ceoRequired,
      ceoActionMode: routing.ceoActionMode,
      delegable: routing.delegable,
      leverageClass: routing.leverage.classification,
      sourceThreadId: event.threadId,
      confidence: Math.min(interpretation?.confidence ?? 0.6, routing.confidence),
      routingReason: routing.reason,
      approvalClass: routing.approvalClass,
      lastActivityAt: event.occurredAt,
      createdAt: event.occurredAt,
    });

    accepted.push(task);

    const attributedName = attributedId ? team.getPerson(attributedId)?.name ?? null : null;
    drafts.push({
      task,
      state: StateTask.parse({
        id: task.id,
        title: task.title,
        summary: (event.summary ?? '').slice(0, 240) || null,
        source: sourceLabel(event.sourceSystem),
        sourceRef: event.sourceExternalId,
        link: event.rawReference,
        occurredAt: event.occurredAt,
        businessArea: task.businessArea,
        requiredCapabilities: request.requiredCapabilities,
        primaryOwner: nameOf(team, routing.primaryOwnerPersonId),
        projectManager: nameOf(team, routing.projectManagerPersonId),
        decisionMaker: nameOf(team, routing.decisionMakerPersonId),
        externalParty: routing.externalCounterpartyOrganizationId
          ? team.getOrganization(routing.externalCounterpartyOrganizationId)?.name ?? null : null,
        collaborators: routing.collaborators.map((c) => nameOf(team, c.personId)).filter(Boolean) as string[],
        ceoRequired: routing.ceoRequired,
        ceoActionMode: routing.ceoActionMode,
        leverageClass: routing.leverage.classification,
        approvalClass: routing.approvalClass,
        delegable: routing.delegable,
        deadline: task.deadline,
        valueAtStake: request.valueAtStake,
        routingReason: routing.reason,
        attributedTo: attributedName,
        attributionOverridden: Boolean(attributedId && attributedId !== routing.primaryOwnerPersonId),
        confidence: task.confidence,
        needsReview: routing.needsReview || match.decision === 'NEEDS_REVIEW',
        possibleDuplicateOf,
        duplicateSimilarity,
        interpreted: Boolean(interpretation),
      }),
    });
  }

  // --- Rank ------------------------------------------------------------------
  const ranked = rankTasks(drafts.map((d) => d.task), () => ({ rules: config.priorityRules, now }));
  const rankById = new Map(ranked.map((r) => [r.task.id, r]));

  const tasks = drafts.map((d) => {
    const r = rankById.get(d.task.id);
    return StateTask.parse({
      ...d.state,
      score: r?.score ?? 0,
      rank: r?.rank ?? null,
      drivers: r?.result.drivers.slice(0, 3) ?? [],
    });
  }).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  const state = CommandCenterState.parse({
    version: 1,
    generatedAt: now.toISOString(),
    producedBy: input.ai ? (input.ai.client.name === 'session' ? 'session' : 'api') : 'metadata-only',
    window: input.window ?? { from: now.toISOString(), to: now.toISOString() },
    tasks,
    commitments: input.commitments ?? [],
    triage: triageRows,
    meetings: input.meetings ?? [],
    counts: {
      mailSeen,
      mailKept,
      meetingsSeen: (input.meetings ?? []).length,
      actionItems: (input.meetings ?? []).reduce((n, m) => n + m.actionItemCount, 0),
      tasksCreated: tasks.length,
      duplicatesMerged: duplicates,
      needsReview,
    },
    problems,
  });

  return { state, interpretations };
}

// ---------------------------------------------------------------------------

function shortCircuit(event: CanonicalEvent, config: SystemConfig): string | null {
  if (isAutomatedSender(event.actor?.email ?? null, config.organizations)) return 'automated sender';
  if ((event.sourceSystem === 'outlook' || event.sourceSystem === 'outlook_sent') && isBulkMail(event)) return 'bulk mail';
  if (event.sourceSystem === 'slack' && isSlackNoise(event)) return 'slack noise';
  if (!event.subject && !event.body && !event.summary) return 'no content';
  return null;
}

function resolveAttribution(
  event: CanonicalEvent,
  interpretation: EventInterpretation | null,
  team: TeamModel,
): string | null {
  const hint = interpretation?.suggestedOwnerHint
    ?? (event.metadata.attributedTo as string | undefined)
    ?? null;
  if (!hint) return null;
  return team.getPersonBySlug(hint)?.id ?? team.getPersonByAlias(hint)?.id ?? null;
}

function sourceLabel(source: CanonicalEvent['sourceSystem']): StateTask['source'] {
  if (source === 'zoom') return 'Zoom';
  if (source === 'slack') return 'Slack';
  if (source === 'outlook' || source === 'outlook_sent') return 'Outlook';
  if (source === 'manual') return 'Manual';
  return 'Signal';
}

function nameOf(team: TeamModel, id: string | null): string | null {
  return id ? team.getPerson(id)?.name ?? null : null;
}

function isoOrNull(value: string): string | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
