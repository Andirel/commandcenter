/**
 * Task matching and deduplication.
 *
 * The same real activity arriving via Zoom, Slack and email must converge to
 * ONE task carrying three pieces of evidence.
 *
 * Governing asymmetry: a wrong MERGE destroys information, while a duplicate is
 * merely annoying. So the ambiguous band resolves to NEEDS_REVIEW, never to a
 * confident guess.
 */
import type { MatchDecision } from '../schemas/core.js';
import type { Task } from '../schemas/tasks.js';
import { participantOverlap, temporalProximity, tokenSimilarity, trigramSimilarity } from './similarity.js';

export interface MatchCandidateInput {
  title: string;
  description?: string | null;
  participantPersonIds: string[];
  initiativeId?: string | null;
  occurredAt: string;
  /** Provider thread id. An exact match is near-proof of the same activity. */
  threadId?: string | null;
  externalOrganizationId?: string | null;
}

export interface ScoredMatch {
  task: Task;
  similarity: number;
  signals: Record<string, number>;
  /** True when the thread id matches exactly — decisive on its own. */
  exactThread: boolean;
}

export interface MatchOutcome {
  decision: MatchDecision;
  matchedTask: Task | null;
  similarity: number;
  reason: string;
  candidates: ScoredMatch[];
}

/** Above this we act; between the two we ask; below the lower we create. */
export const MERGE_THRESHOLD = 0.72;
export const REVIEW_THRESHOLD = 0.5;

const WEIGHTS = {
  title: 0.35,
  trigram: 0.15,
  participants: 0.2,
  initiative: 0.15,
  temporal: 0.1,
  counterparty: 0.05,
};

export function scoreCandidates(input: MatchCandidateInput, openTasks: Task[]): ScoredMatch[] {
  const inputText = `${input.title} ${input.description ?? ''}`;

  const scored = openTasks.map((task) => {
    const taskText = `${task.title} ${task.description ?? ''}`;
    const signals: Record<string, number> = {
      title: tokenSimilarity(input.title, task.title),
      trigram: trigramSimilarity(inputText, taskText),
      participants: participantOverlap(input.participantPersonIds, collectParticipants(task)),
      initiative: input.initiativeId && input.initiativeId === task.initiativeId ? 1 : 0,
      temporal: temporalProximity(input.occurredAt, task.lastActivityAt ?? task.createdAt ?? input.occurredAt),
      counterparty:
        input.externalOrganizationId && input.externalOrganizationId === task.externalCounterpartyOrganizationId
          ? 1 : 0,
    };

    const similarity = Object.entries(WEIGHTS).reduce(
      (sum, [key, weight]) => sum + (signals[key] ?? 0) * weight,
      0,
    );

    return { task, similarity: round(similarity), signals: roundAll(signals), exactThread: false };
  });

  return scored.sort((a, b) => b.similarity - a.similarity);
}

export function matchTask(
  input: MatchCandidateInput,
  openTasks: Task[],
  opts: { threadTaskIds?: Map<string, string> } = {},
): MatchOutcome {
  // A provider thread id is near-proof: a reply on the same email thread is
  // the same activity, whatever the wording.
  if (input.threadId) {
    const taskId = opts.threadTaskIds?.get(input.threadId);
    const task = taskId
      ? openTasks.find((t) => t.id === taskId)
      : openTasks.find((t) => t.sourceThreadId === input.threadId);
    if (task) {
      return {
        decision: 'UPDATE_EXISTING',
        matchedTask: task,
        similarity: 1,
        reason: 'Same source thread as an existing task.',
        candidates: [{ task, similarity: 1, signals: { thread: 1 }, exactThread: true }],
      };
    }
  }

  const candidates = scoreCandidates(input, openTasks);
  const best = candidates[0];

  if (!best || best.similarity < REVIEW_THRESHOLD) {
    return {
      decision: 'CREATE',
      matchedTask: null,
      similarity: best?.similarity ?? 0,
      reason: best
        ? `Closest existing task scores ${best.similarity.toFixed(2)}, below the review threshold.`
        : 'No open tasks to compare against.',
      candidates,
    };
  }

  // Distinguish "the same work continuing" from "the work has come back".
  // A match against a CLOSED task means a recurrence, which is NEW work --
  // merging into it would lose the previous instance's record. This is checked
  // before the thresholds because it applies across the whole matching band,
  // not only above the merge bar.
  if (best.task.status === 'completed' || best.task.status === 'superseded') {
    return {
      decision: 'NEEDS_REVIEW',
      matchedTask: best.task,
      similarity: best.similarity,
      reason: `Closely matches "${best.task.title}", which is already closed; this may be a recurrence rather than a duplicate.`,
      candidates,
    };
  }

  if (best.similarity >= MERGE_THRESHOLD) {
    return {
      decision: 'UPDATE_EXISTING',
      matchedTask: best.task,
      similarity: best.similarity,
      reason: `Matches "${best.task.title}" (${best.similarity.toFixed(2)}); attaching as further evidence.`,
      candidates,
    };
  }

  // Two candidates close together is itself a reason to ask: merging into the
  // wrong one of a near-tie is exactly the failure worth avoiding.
  const runnerUp = candidates[1];
  if (runnerUp && best.similarity - runnerUp.similarity < 0.08) {
    return {
      decision: 'NEEDS_REVIEW',
      matchedTask: best.task,
      similarity: best.similarity,
      reason: 'Two existing tasks match about equally well; a wrong merge would lose information.',
      candidates,
    };
  }

  return {
    decision: 'NEEDS_REVIEW',
    matchedTask: best.task,
    similarity: best.similarity,
    reason: `Similar to "${best.task.title}" (${best.similarity.toFixed(2)}) but below the merge threshold.`,
    candidates,
  };
}

function collectParticipants(task: Task): string[] {
  const ids = [
    task.primaryOwnerPersonId,
    task.projectManagerPersonId,
    task.decisionMakerPersonId,
    task.approverPersonId,
    ...task.collaborators.map((c) => c.personId),
  ];
  return ids.filter(Boolean) as string[];
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function roundAll(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));
}
