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
import { tokenSimilarity } from '../deduplication/similarity.js';
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
import { canAutoComplete, detectCompletion, type CompletionSignal } from '../completion/detect.js';
import { extractCommitments, type ExtractedCommitment } from '../commitments/extract.js';
import { emptyLedger, openEntries, type Ledger, type LedgerEntry } from '../ledger/types.js';
import {
  applyCompletion, carryForward, completionOptions, computeDelta, daysBetween,
  markDormant, matchToLedger, newEntry, refresh, stampRanks,
} from '../ledger/reconcile.js';
import { businessDaysBetween } from '../followup/engine.js';
import { resolveFollowUps } from './followups.js';
import { CommandCenterState, StateTask, type StateCommitment, type StateDelta, type StateMeeting, type StateSignal, type StateFinance, type StateProposal } from './state.js';

export interface SyncInput {
  events: CanonicalEvent[];
  meetings?: StateMeeting[];
  commitments?: StateCommitment[];
  /** Derived by src/signals/*; the loop consumes conclusions, not raw ledgers. */
  signals?: StateSignal[];
  proposals?: StateProposal[];
  finance?: StateFinance;
  config: SystemConfig;
  team: TeamModel;
  /** Omit to run metadata-only. */
  ai?: StageContext;
  now?: Date;
  window?: { from: string; to: string };
  /**
   * The system's memory. Omit on a first run: everything is new, nothing can
   * be completed, and the delta is null rather than a fabricated "all new".
   */
  ledger?: Ledger;
}

export interface SyncOutput {
  state: CommandCenterState;
  interpretations: InterpretationRecord[];
  /** The ledger as it stands after this run. Persist it or lose the memory. */
  ledger: Ledger;
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

  /*
   * Memory. Without a ledger the loop behaves exactly as it did before: every
   * task is new, nothing completes, and the delta is null. That is the honest
   * result of a first run, and it is why the ledger is optional rather than
   * required — the system must work before it has any history.
   */
  let ledger: Ledger = input.ledger ?? emptyLedger();
  const byKey = new Map(ledger.entries.map((e) => [e.key, e]));
  const liveKeys = openEntries(ledger).map((e) => e.key);
  /** Re-read through `byKey`: an entry closed earlier in this loop is not live. */
  const live = (): LedgerEntry[] =>
    liveKeys.map((k) => byKey.get(k)!).filter((e) => e.status === 'open' || e.status === 'dormant');
  const completionOpts = completionOptions(config);

  /** Entries this run touched, so the rest can be carried forward untouched. */
  const seenKeys = new Set<string>();
  const addedEntries: LedgerEntry[] = [];
  const completedEntries: Array<{ entry: LedgerEntry; signal: CompletionSignal }> = [];
  const awaitingEntries: Array<{ entry: LedgerEntry; signal: CompletionSignal; reason: string }> = [];
  /** Keys closed by the event currently being processed, to suppress its echo. */
  let closedByThisEvent = new Set<string>();

  /** Promises read out of the correspondence itself, keyed for dedup. */
  const foundCommitments = new Map<string, ExtractedCommitment>();

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

    /*
     * --- Stage 1b: does this event FINISH something? -------------------------
     *
     * Deliberately before triage. "All set, invoice paid" implies no new work
     * and triage is right to drop it — but it is the single most valuable mail
     * in the window, because it is the only thing that can shrink the queue.
     * Asking "does this create work?" before "does this end work?" is how a
     * queue becomes a place things go to accumulate.
     */
    closedByThisEvent = new Set<string>();
    const liveNow = live();
    if (liveNow.length) {
      const signals = detectCompletion(event, liveNow.map((e) => e.task), completionOpts);
      for (const signal of signals) {
        const entry = byKey.get(signal.taskId);
        if (!entry || entry.status === 'completed' || seenKeys.has(`closed:${entry.key}`)) continue;

        const auto = canAutoComplete(signal, completionOpts);
        const outcome = applyCompletion(entry, signal, {
          auto, syncAt: now.toISOString(), sourceRef: event.sourceExternalId,
        });
        byKey.set(entry.key, outcome.entry);

        if (outcome.applied) {
          completedEntries.push({ entry: outcome.entry, signal });
          closedByThisEvent.add(entry.key);
          seenKeys.add(entry.key);
          seenKeys.add(`closed:${entry.key}`);
        } else {
          awaitingEntries.push({ entry: outcome.entry, signal, reason: outcome.reason });
        }
      }
    }

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

    /*
     * --- Stage 1c: did anyone PROMISE anything? ------------------------------
     *
     * Also before triage, and for the same reason completion is. "I'll look
     * into those and follow up" implies no work for us and triage is right to
     * drop it — while being the only place a commitment we will later need to
     * chase is ever recorded. Nobody writes these down anywhere else.
     */
    for (const found of extractCommitments(event)) {
      // The earliest sighting wins: the follow-up clock should start when the
      // promise was made, not when the thread was last re-read.
      const prior = foundCommitments.get(found.id);
      if (!prior || found.occurredAt < prior.occurredAt) foundCommitments.set(found.id, found);
    }

    /*
     * --- Stage 5: dedup, against this run AND everything remembered ----------
     *
     * Matching only within the window is what made the queue grow forever: a
     * reply on Thursday to Monday's thread arrives as a different event id and
     * became a second copy of the same work. The ledger's open entries join
     * the comparison so a continuation attaches to what it continues.
     */
    /*
     * Closed entries stay in the comparison for a while, for two reasons that
     * pull in opposite directions and both matter. The email that closed a
     * task sits in the window for days afterward, and without the closed entry
     * to match against it re-creates the very task it finished — completion
     * that lasts one morning. But a genuinely NEW request that resembles
     * finished work is a recurrence, not a duplicate, and `matchTask` already
     * holds that for review rather than merging into a closed record.
     * Telling the two apart is a question about the evidence, not the wording:
     * the same source event is an echo, a different one is news.
     */
    // Read through `byKey`, not `ledger.entries`: an entry closed moments ago
    // by this very event is only up to date in the map.
    const closedRecently = [...byKey.values()].filter(
      (e) => e.status === 'completed' && daysBetween(e.statusChangedAt, now) <= ECHO_WINDOW_DAYS);
    const ledgerCandidates = live().concat(closedRecently);
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
      accepted.concat(ledgerCandidates.map((e) => e.task)),
    );

    // An event that closed a task usually also reads as one ("invoice paid").
    // Creating work from the news that work is finished is the obvious trap,
    // and it springs again every morning the closing message is still in view.
    if (match.matchedTask && isEchoOfClosed(match, byKey.get(match.matchedTask.id), event, closedByThisEvent)) {
      duplicates++;
      continue;
    }

    if (match.decision === 'UPDATE_EXISTING' && match.matchedTask) {
      const existing = byKey.get(match.matchedTask.id);
      if (existing) {
        // Continuation of remembered work: fold in the new evidence, keep the
        // routing that was decided when there was enough context to decide it.
        byKey.set(existing.key, refresh(existing, {
          task: { ...existing.task, lastActivityAt: event.occurredAt,
                  deadline: interpretation?.deadline ? isoOrNull(interpretation.deadline) : existing.task.deadline },
          state: { ...existing.state, summary: (event.summary ?? '').slice(0, 240) || existing.state.summary,
                   link: event.rawReference ?? existing.state.link, occurredAt: event.occurredAt,
                   // What the NEW message said it is worth. `refresh` ratchets
                   // this upward only — spreading the existing state alone
                   // would hide a first hard number behind an earlier guess.
                   valueAtStake: request.valueAtStake ?? existing.state.valueAtStake },
        }, now.toISOString()));
        seenKeys.add(existing.key);
      }
      duplicates++;
      continue;
    }
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

  /*
   * --- Commit this run to memory --------------------------------------------
   *
   * A draft is either the first sight of something or a continuation of
   * something remembered. Continuations were folded in above; what reaches
   * here is genuinely new, so it enters the ledger and is announced as new.
   */
  const priorStatus = new Map(ledger.entries.map((e) => [e.key, e.status]));
  for (const draft of drafts) {
    const existing = byKey.get(draft.task.id);
    if (existing) {
      byKey.set(existing.key, refresh(existing, draft, now.toISOString()));
      seenKeys.add(existing.key);
      continue;
    }
    const created = newEntry(draft, now.toISOString());
    byKey.set(created.key, created);
    addedEntries.push(created);
    seenKeys.add(created.key);
  }
  ledger = { ...ledger, entries: [...byKey.values()] };

  /*
   * --- Carry forward ---------------------------------------------------------
   *
   * The queue is the ledger, not the window. Work derived from an email nine
   * days ago is still work; re-ranking it against today's clock is also the
   * moment an approaching deadline finally lifts it, which a snapshot of the
   * last seven days can never do.
   */
  const dormancy = markDormant(ledger, now, config.followupRules.resolution.stale_close_business_days
    ? Math.min(15, config.followupRules.resolution.stale_close_business_days) : 15);
  ledger = dormancy.ledger;
  const carried = carryForward(ledger, seenKeys);

  const queue = ledger.entries.filter((e) => e.status === 'open' || e.status === 'dormant');
  const stateByKey = new Map<string, StateTask>();
  for (const d of drafts) stateByKey.set(d.task.id, d.state);
  for (const e of queue) if (!stateByKey.has(e.key)) stateByKey.set(e.key, e.state);

  // --- Rank ------------------------------------------------------------------
  const ranked = rankTasks(queue.map((e) => e.task), () => ({ rules: config.priorityRules, now }));
  const rankById = new Map(ranked.map((r) => [r.task.id, r]));
  const addedKeys = new Set(addedEntries.map((e) => e.key));

  const tasks = queue.map((entry) => {
    const r = rankById.get(entry.key);
    const base = stateByKey.get(entry.key) ?? entry.state;
    return StateTask.parse({
      ...base,
      score: r?.score ?? 0,
      rank: r?.rank ?? null,
      drivers: r?.result.drivers.slice(0, 3) ?? [],
      status: entry.status === 'dormant' ? 'dormant' : 'open',
      ageDays: daysBetween(entry.firstSeenAt, now),
      daysSilent: businessDaysBetween(new Date(entry.lastActivityAt), now),
      isNew: addedKeys.has(entry.key),
      seenCount: entry.seenCount,
    });
  }).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  // Work that had gone quiet and has now come back. Worth saying out loud:
  // it is the one case where an old item deserves fresh attention.
  const reopened = ledger.entries.filter(
    (e) => e.status === 'open' && priorStatus.get(e.key) === 'dormant');

  /*
   * --- Who owes us something, and has for how long ---------------------------
   *
   * The counters live in the ledger, which is the whole reason this can run at
   * all: a nudge that does not remember it already nudged is just noise on a
   * schedule.
   */
  /*
   * Hand-supplied commitments win on a collision. Someone who typed one in
   * knows something the text did not say — often the real deadline — and an
   * extraction should never overwrite that.
   */
  const supplied = input.commitments ?? [];
  const suppliedIds = new Set(supplied.map((c) => c.id));
  const extracted = [...foundCommitments.values()]
    .filter((c) => !suppliedIds.has(c.id))
    .map((c) => toStateCommitment(c, team, now))
    /*
     * Matching ids is not enough. The extractor derives its id from the words
     * of the sentence; a person writing the same promise by hand words it
     * differently, and both then get chased separately — two nudges to one
     * counterparty about one promise, which is worse than missing it.
     *
     * The decisive test is the SOURCE, not the wording: a person and the
     * extractor reading the same message in the same direction have found the
     * same promise, however differently they phrased it. Direction has to be
     * part of it — one message routinely carries a question we owe an answer
     * to and a promise they made us, and those are two commitments, not one.
     * Word overlap stays as a fallback for hand-written entries with no source.
     */
    .filter((c) => !supplied.some((s) =>
      s.direction === c.direction &&
      ((s.sourceRef && c.sourceRef && s.sourceRef === c.sourceRef) ||
       tokenSimilarity(s.description, c.description) >= 0.4)));

  const followUpResult = resolveFollowUps(supplied.concat(extracted), ledger, team, config, now);
  ledger = followUpResult.ledger;

  const delta: StateDelta | null = input.ledger
    ? computeDelta(ledger, tasks, {
        added: addedEntries, completed: completedEntries, awaiting: awaitingEntries,
        reopened, wentQuiet: dormancy.wentQuiet,
      }, now, input.ledger.updatedAt)
    : null;

  const state = CommandCenterState.parse({
    version: 1,
    generatedAt: now.toISOString(),
    producedBy: input.ai ? (input.ai.client.name === 'session' ? 'session' : 'api') : 'metadata-only',
    window: input.window ?? { from: now.toISOString(), to: now.toISOString() },
    tasks,
    commitments: supplied.concat(extracted),
    triage: triageRows,
    meetings: input.meetings ?? [],
    signals: input.signals ?? [],
    proposals: input.proposals ?? [],
    finance: input.finance ?? null,
    delta,
    followUps: followUpResult.due,
    counts: {
      mailSeen,
      mailKept,
      meetingsSeen: (input.meetings ?? []).length,
      actionItems: (input.meetings ?? []).reduce((n, m) => n + m.actionItemCount, 0),
      tasksCreated: tasks.length,
      duplicatesMerged: duplicates,
      needsReview,
      carriedForward: carried.length,
      completedThisRun: completedEntries.length,
    },
    problems,
  });

  ledger = stampRanks(ledger, tasks, now.toISOString(), input.ledger?.updatedAt ?? null);

  return { state, interpretations, ledger };
}

// ---------------------------------------------------------------------------

/**
 * How long a closed entry keeps guarding against its own closing evidence.
 * Comfortably longer than any pull window, and short enough that the same
 * request six months later is correctly read as new work.
 */
const ECHO_WINDOW_DAYS = 45;

/**
 * An extracted promise in the shape the rest of the system speaks.
 *
 * `explicit` records whether the person said it outright or the extractor
 * inferred it from a softer phrasing, because the follow-up wording should not
 * claim someone promised something when they only offered to look.
 */
function toStateCommitment(c: ExtractedCommitment, team: TeamModel, now: Date): StateCommitment {
  /*
   * Prefer the counterparty the pipeline already resolved for this event over
   * re-deriving one from the sender's domain. It uses more than the domain,
   * and a commitment attributed to no organization can never be routed to a
   * chaser — which is how a found promise ends up owned by nobody.
   */
  const org = (c.organizationId ? team.getOrganization(c.organizationId) : undefined)
    ?? (c.speakerEmail ? team.getOrganizationByDomain(domainOf(c.speakerEmail)) : undefined);
  const person = (c.speakerEmail ? team.getPersonByEmail(c.speakerEmail) : undefined)
    ?? (c.speakerSlackId ? team.getPersonBySlackId(c.speakerSlackId) : undefined)
    ?? (c.speakerName ? team.getPersonByAlias(c.speakerName) : undefined);
  return {
    id: c.id,
    description: c.description,
    direction: c.direction,
    counterparty: org && org.organizationType !== 'internal' ? org.name : null,
    owedBy: person?.name ?? c.speakerName,
    dueDate: c.dueDate,
    businessDaysOutstanding: businessDaysBetween(new Date(c.dueDate ?? c.occurredAt), now),
    followUpOwner: null,
    relationshipOwner: null,
    explicit: c.label === 'explicit promise',
    quote: c.quote,
    sourceRef: c.sourceRef,
  };
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * Is this draft the closing message re-read, rather than new work?
 *
 * Only two things qualify: the entry was closed by this very event earlier in
 * this run, or it was closed by this event on a previous run. Anything else
 * that merely resembles closed work is a possible recurrence, and belongs in
 * review rather than in silence.
 */
function isEchoOfClosed(
  match: ReturnType<typeof matchTask>,
  entry: LedgerEntry | undefined,
  event: CanonicalEvent,
  closedByThisEvent: Set<string>,
): boolean {
  if (!match.matchedTask) return false;
  if (closedByThisEvent.has(match.matchedTask.id)) return true;
  if (!entry || entry.status !== 'completed') return false;
  return Boolean(event.sourceExternalId && entry.completion?.sourceRef === event.sourceExternalId);
}

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
