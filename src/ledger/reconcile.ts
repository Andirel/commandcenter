/**
 * Reconciling a run against the ledger.
 *
 * The governing asymmetry, which decides nearly every rule below:
 *
 *   A task wrongly left open is VISIBLE and costs a moment to dismiss.
 *   A task wrongly closed DISAPPEARS and costs whatever it was worth.
 *
 * So inference closes only what it is confident about and what is cheap to be
 * wrong about; everything consequential becomes a question. And silence never
 * closes anything at all — a task that stops appearing has usually either been
 * finished without anyone saying so or quietly died, and those need different
 * answers from the one person who knows which it is.
 */
import type { SystemConfig } from '../schemas/config.js';
import type { Task } from '../schemas/tasks.js';
import { matchTask } from '../deduplication/match.js';
import { businessDaysBetween } from '../followup/engine.js';
import type { CompletionSignal } from '../completion/detect.js';
import type { StateDelta, StateTask } from '../sync/state.js';
import { LedgerEntry, type Ledger } from './types.js';

const DAY_MS = 86_400_000;

/** Business days of silence after which a task is asked about rather than ranked. */
export const DORMANT_AFTER_BUSINESS_DAYS = 15;

/**
 * Rank movement worth reporting.
 *
 * A one-place shuffle happens every run from ordinary score drift and means
 * nothing. Reporting it teaches the reader that the delta is noise, which is
 * the one thing a delta cannot afford.
 */
export const MOVE_THRESHOLD = 3;
/** Entering or leaving the top of the queue is reportable at any distance. */
export const TOP_OF_QUEUE = 5;

export interface Reconciled {
  /** Existing entry this draft continues, or null if it is genuinely new. */
  entry: LedgerEntry | null;
  reason: string;
}

/**
 * Find the ledger entry a freshly-derived task continues.
 *
 * Deliberately reuses `matchTask` rather than inventing a second notion of
 * sameness: two matchers would drift, and the day they disagree is the day a
 * task exists twice with neither copy complete. The same thread-id shortcut
 * and the same recurrence guard apply — a match against a CLOSED entry is
 * treated as new work, not as a resurrection.
 */
export function matchToLedger(
  draft: { task: Task; state: StateTask; participantPersonIds: string[] },
  entries: LedgerEntry[],
): Reconciled {
  if (!entries.length) return { entry: null, reason: 'no ledger entries to compare against' };

  const byKey = new Map(entries.map((e) => [e.task.id, e]));

  // Exact identity: the same source event seen in an overlapping window.
  const exact = byKey.get(draft.task.id);
  if (exact) return { entry: exact, reason: 'same source event' };

  const outcome = matchTask(
    {
      title: draft.task.title,
      description: draft.task.description,
      participantPersonIds: draft.participantPersonIds,
      initiativeId: draft.task.initiativeId,
      occurredAt: draft.task.lastActivityAt ?? draft.state.occurredAt,
      threadId: draft.task.sourceThreadId,
      externalOrganizationId: draft.task.externalCounterpartyOrganizationId,
    },
    entries.map((e) => e.task),
  );

  if (outcome.decision === 'UPDATE_EXISTING' && outcome.matchedTask) {
    const entry = entries.find((e) => e.task.id === outcome.matchedTask!.id) ?? null;
    return { entry, reason: outcome.reason };
  }
  return { entry: null, reason: outcome.reason };
}

/**
 * Fold new evidence into an existing entry.
 *
 * What gets refreshed is deliberately narrow. Ownership, priority inputs and
 * routing are NOT overwritten from a later message in the thread: "thanks,
 * received" would otherwise re-route a $40k decision on the strength of a
 * two-word reply. What updates is what genuinely moved — recency, the newest
 * summary and link, and the deadline if one is now known.
 */
export function refresh(entry: LedgerEntry, draft: { task: Task; state: StateTask }, syncAt: string): LedgerEntry {
  const newer = (draft.task.lastActivityAt ?? draft.state.occurredAt) > entry.lastActivityAt;
  return LedgerEntry.parse({
    ...entry,
    task: { ...entry.task, lastActivityAt: newer ? draft.task.lastActivityAt ?? entry.lastActivityAt : entry.task.lastActivityAt,
            deadline: entry.task.deadline ?? draft.task.deadline },
    state: {
      ...entry.state,
      summary: newer ? draft.state.summary ?? entry.state.summary : entry.state.summary,
      link: newer ? draft.state.link ?? entry.state.link : entry.state.link,
      occurredAt: newer ? draft.state.occurredAt : entry.state.occurredAt,
      deadline: entry.state.deadline ?? draft.state.deadline,
    },
    lastSeenAt: syncAt,
    lastActivityAt: newer ? draft.task.lastActivityAt ?? entry.lastActivityAt : entry.lastActivityAt,
    seenCount: entry.seenCount + 1,
    // Evidence arriving after a close means the work came back. Say so rather
    // than leaving a completed item quietly accruing activity.
    status: entry.status === 'dormant' && newer ? 'open' : entry.status,
    statusChangedAt: entry.status === 'dormant' && newer ? syncAt : entry.statusChangedAt,
  });
}

export function newEntry(
  draft: { task: Task; state: StateTask },
  syncAt: string,
): LedgerEntry {
  const activity = draft.task.lastActivityAt ?? draft.state.occurredAt;
  return LedgerEntry.parse({
    key: draft.task.id,
    task: draft.task,
    state: draft.state,
    firstSeenAt: syncAt,
    lastSeenAt: syncAt,
    lastActivityAt: activity,
    seenCount: 1,
    status: 'open',
    statusChangedAt: syncAt,
  });
}

export interface CompletionOutcome {
  entry: LedgerEntry;
  applied: boolean;
  reason: string;
}

/**
 * Apply one completion signal to an entry.
 *
 * `canAutoComplete` has already decided whether inference is allowed to act.
 * When it is not, the evidence is not discarded — it becomes a question the
 * CEO can answer in one click, which is the whole point: the system did the
 * noticing, the human did the deciding.
 */
export function applyCompletion(
  entry: LedgerEntry,
  signal: CompletionSignal,
  opts: { auto: boolean; syncAt: string; sourceRef?: string | null },
): CompletionOutcome {
  const record = {
    at: opts.syncAt,
    confidence: signal.confidence,
    evidence: signal.evidence,
    label: signal.label,
    source: 'detected' as const,
    sourceRef: opts.sourceRef ?? null,
  };

  if (!opts.auto) {
    return {
      entry: LedgerEntry.parse({ ...entry, pendingConfirmation: record, lastSeenAt: opts.syncAt }),
      applied: false,
      reason: signal.requiresHumanVerification
        ? 'too consequential to close on inference'
        : `confidence ${signal.confidence.toFixed(2)} below the auto-close bar`,
    };
  }

  return {
    entry: LedgerEntry.parse({
      ...entry,
      task: { ...entry.task, status: 'completed', completedAt: opts.syncAt,
              completionConfidence: signal.confidence, completionEvidence: signal.evidence },
      status: 'completed',
      statusChangedAt: opts.syncAt,
      completion: record,
      pendingConfirmation: null,
      lastSeenAt: opts.syncAt,
    }),
    applied: true,
    reason: signal.label,
  };
}

/**
 * Move entries that have gone quiet out of the daily plan.
 *
 * Note what this does NOT do: it does not close them. Dormancy is a statement
 * about evidence, not about the work. The entry keeps its place in the Queue
 * under a group that says how long it has been silent, so the answer comes
 * from the person who knows rather than from an assumption.
 */
export function markDormant(ledger: Ledger, now: Date, afterBusinessDays = DORMANT_AFTER_BUSINESS_DAYS): {
  ledger: Ledger; wentQuiet: LedgerEntry[];
} {
  const wentQuiet: LedgerEntry[] = [];
  const entries = ledger.entries.map((entry) => {
    if (entry.status !== 'open') return entry;
    const silent = businessDaysBetween(new Date(entry.lastActivityAt), now);
    if (silent < afterBusinessDays) return entry;
    const next = LedgerEntry.parse({ ...entry, status: 'dormant', statusChangedAt: now.toISOString() });
    wentQuiet.push(next);
    return next;
  });
  return { ledger: { ...ledger, entries }, wentQuiet };
}

/** Calendar days, rounded down. Used for display, not for cadence. */
export function daysBetween(fromIso: string, to: Date): number {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((to.getTime() - t) / DAY_MS));
}

/**
 * Compute what changed, comparing each entry's current rank against the rank
 * it carried out of the previous sync.
 */
export function computeDelta(
  ledger: Ledger,
  ranked: StateTask[],
  events: {
    added: LedgerEntry[];
    completed: Array<{ entry: LedgerEntry; signal: CompletionSignal }>;
    awaiting: Array<{ entry: LedgerEntry; signal: CompletionSignal; reason: string }>;
    reopened: LedgerEntry[];
    wentQuiet: LedgerEntry[];
  },
  now: Date,
  /** When the previous sync ran. `ledger.previousSyncAt` is one run older. */
  since: string | null = null,
): StateDelta {
  const rankById = new Map(ranked.map((t) => [t.id, t.rank]));
  const moved: StateDelta['moved'] = [];

  for (const entry of ledger.entries) {
    if (entry.status !== 'open') continue;
    const toRank = rankById.get(entry.key) ?? null;
    const fromRank = entry.previousRank;
    if (fromRank === null || toRank === null) continue;
    const distance = Math.abs(fromRank - toRank);
    const crossesTop = (fromRank <= TOP_OF_QUEUE) !== (toRank <= TOP_OF_QUEUE);
    if (distance < MOVE_THRESHOLD && !crossesTop) continue;
    moved.push({ id: entry.key, title: entry.task.title, fromRank, toRank });
  }

  moved.sort((a, b) => (a.toRank ?? 999) - (b.toRank ?? 999));

  return {
    since: since ?? ledger.previousSyncAt,
    syncCount: ledger.syncCount,
    added: events.added.map((e) => ({ id: e.key, title: e.task.title, rank: rankById.get(e.key) ?? null })),
    completed: events.completed.map(({ entry, signal }) => ({
      id: entry.key, title: entry.task.title,
      evidence: signal.evidence, label: signal.label, confidence: signal.confidence,
    })),
    awaitingConfirmation: events.awaiting.map(({ entry, signal, reason }) => ({
      id: entry.key, title: entry.task.title,
      evidence: signal.evidence, label: signal.label, confidence: signal.confidence, reason,
    })),
    moved,
    quiet: events.wentQuiet.map((e) => ({
      id: e.key, title: e.task.title, daysSilent: daysBetween(e.lastActivityAt, now),
    })),
    reopened: events.reopened.map((e) => ({ id: e.key, title: e.task.title })),
  };
}

/** Write this run's ranks into the ledger so the next run can compare. */
export function stampRanks(ledger: Ledger, ranked: StateTask[], syncAt: string, previousSyncAt: string | null): Ledger {
  const byId = new Map(ranked.map((t) => [t.id, t]));
  return {
    ...ledger,
    version: 1,
    updatedAt: syncAt,
    previousSyncAt,
    syncCount: ledger.syncCount + 1,
    entries: ledger.entries.map((entry) => {
      const t = byId.get(entry.key);
      if (!t) return entry;
      return LedgerEntry.parse({ ...entry, state: t, previousRank: t.rank, previousScore: t.score });
    }),
  };
}

/**
 * Entries that should be re-ranked this run even though nothing new arrived.
 *
 * This is what makes the queue outlive its window. A task derived from an
 * email nine days ago is still work; the window it came from has moved on.
 * Re-scoring it against today's clock is also the point at which an
 * approaching deadline finally lifts it, which a snapshot of the last seven
 * days can never do.
 */
export function carryForward(ledger: Ledger, seenKeys: Set<string>): LedgerEntry[] {
  return ledger.entries.filter(
    (e) => (e.status === 'open' || e.status === 'dormant') && !seenKeys.has(e.key),
  );
}

/**
 * Answers a human gave in the page, folded back into memory.
 *
 * These are the most valuable records the system holds. Everything else it
 * knows is inference over evidence it happened to see; this is the one channel
 * where someone who actually knows tells it whether it was right. Applied
 * before anything else in a run, so the sync never re-asks a question that has
 * already been answered.
 *
 * "Still open" is treated as evidence of life, not merely as a refusal: a
 * person saying so is the strongest signal available that the work is live, so
 * it resets the silence clock exactly as a message would.
 */
export function applyViewerAnswers(
  ledger: Ledger,
  answers: { completed?: Record<string, { at?: string; by?: string }>; stillOpen?: Record<string, string> },
  syncAt: string,
): { ledger: Ledger; confirmed: number; reopened: number } {
  const completed = answers.completed ?? {};
  const stillOpen = answers.stillOpen ?? {};
  let confirmed = 0;
  let reopened = 0;

  const entries = ledger.entries.map((entry) => {
    const answer = completed[entry.key];
    if (answer && entry.status !== 'completed') {
      confirmed++;
      const at = answer.at ?? syncAt;
      return LedgerEntry.parse({
        ...entry,
        task: { ...entry.task, status: 'completed', completedAt: at,
                completionConfidence: 1, completionEvidence: 'Confirmed by hand in the Command Center.' },
        status: 'completed',
        statusChangedAt: at,
        completion: {
          at, confidence: 1, label: answer.by === 'manual' ? 'marked done' : 'confirmed by hand',
          evidence: 'Confirmed by hand in the Command Center.',
          source: 'confirmed' as const, sourceRef: null,
        },
        pendingConfirmation: null,
      });
    }

    const said = stillOpen[entry.key];
    if (said) {
      if (entry.status === 'dormant') reopened++;
      return LedgerEntry.parse({
        ...entry,
        status: 'open',
        statusChangedAt: entry.status === 'open' ? entry.statusChangedAt : syncAt,
        lastActivityAt: said,
        pendingConfirmation: null,
      });
    }
    return entry;
  });

  // Commitments are answered under a prefixed key, since ids from the two
  // sources are not guaranteed to be distinct.
  const commitments = ledger.commitments.map((c) => {
    const answer = completed[`commitment:${c.key}`];
    if (!answer || c.status !== 'open') return c;
    confirmed++;
    return { ...c, status: 'fulfilled' as const, statusChangedAt: answer.at ?? syncAt };
  });

  return { ledger: { ...ledger, entries, commitments }, confirmed, reopened };
}

/** Config-derived completion thresholds, so the rules live in YAML not here. */
export function completionOptions(config: SystemConfig) {
  const res = config.followupRules.resolution;
  return {
    autoCompleteConfidence: res.auto_resolve_confidence,
    humanVerificationValue: valueFloor(res.require_human_confirmation_when),
    humanVerificationImportance: importanceFloor(res.require_human_confirmation_when),
  };
}

function valueFloor(rules: Array<Record<string, unknown>>): number | undefined {
  for (const r of rules) if (typeof r.value_at_stake_above === 'number') return r.value_at_stake_above;
  return undefined;
}

function importanceFloor(rules: Array<Record<string, unknown>>): number | undefined {
  for (const r of rules) if (typeof r.importance_gte === 'number') return r.importance_gte;
  return undefined;
}
