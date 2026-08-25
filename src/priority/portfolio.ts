/**
 * The AI portfolio pass.
 *
 * Deterministic scoring looks at one task at a time, which cannot answer
 * "what unblocks the most?" or "what has quietly become pointless?". This pass
 * looks at open work as a whole.
 *
 * It is a corrective, not a replacement: adjustments are clamped to
 * max_ai_adjustment_ratio so the deterministic layer stays the backbone and a
 * confidently wrong model cannot reorder the company's day.
 */
import type { PriorityRulesConfig } from '../schemas/config.js';
import type { PortfolioReview } from '../schemas/ai.js';
import type { RankedTask } from './rank.js';

export interface PortfolioInput {
  ranked: RankedTask[];
  rules: PriorityRulesConfig;
}

export interface AppliedAdjustment {
  taskId: string;
  requestedDelta: number;
  appliedDelta: number;
  clamped: boolean;
  reason: string;
}

export interface PortfolioOutcome {
  adjusted: RankedTask[];
  applied: AppliedAdjustment[];
  /** Adjustments the model asked for that were rejected outright. */
  rejected: Array<{ taskId: string; reason: string }>;
}

export function applyPortfolioReview(
  input: PortfolioInput,
  review: PortfolioReview,
): PortfolioOutcome {
  const { ranked, rules } = input;
  const maxRatio = rules.portfolio_review.max_ai_adjustment_ratio;

  const byId = new Map(ranked.map((r) => [r.task.id, r]));
  const applied: AppliedAdjustment[] = [];
  const rejected: Array<{ taskId: string; reason: string }> = [];

  const adjustedScores = new Map<string, number>();

  for (const adj of review.adjustments) {
    const entry = byId.get(adj.taskId);
    if (!entry) {
      rejected.push({ taskId: adj.taskId, reason: 'task is not in the reviewed working set' });
      continue;
    }

    // Clamp against the task's OWN deterministic score, so the bound scales
    // with what the task is actually worth.
    const limit = Math.abs(entry.score) * maxRatio;
    const appliedDelta = Math.max(-limit, Math.min(limit, adj.scoreDelta));
    const clamped = appliedDelta !== adj.scoreDelta;

    adjustedScores.set(adj.taskId, entry.score + appliedDelta);
    applied.push({
      taskId: adj.taskId,
      requestedDelta: adj.scoreDelta,
      appliedDelta: round(appliedDelta),
      clamped,
      reason: adj.reason,
    });
  }

  const adjusted = ranked
    .map((entry) => ({ ...entry, score: adjustedScores.get(entry.task.id) ?? entry.score }))
    .sort((a, b) => b.score - a.score)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));

  return { adjusted, applied, rejected };
}

/**
 * The context handed to the portfolio prompt.
 *
 * Deliberately compact: the model gets what it needs to compare items against
 * each other, not full task bodies. Sending everything is expensive and makes
 * the model worse at the comparison it is actually being asked to make.
 */
export function buildPortfolioContext(ranked: RankedTask[]): Array<Record<string, unknown>> {
  return ranked.map((entry) => ({
    taskId: entry.task.id,
    title: entry.task.title,
    rank: entry.rank,
    score: entry.score,
    status: entry.task.status,
    businessArea: entry.task.businessArea,
    deadline: entry.task.deadline,
    ceoRequired: entry.task.ceoRequired,
    ceoActionMode: entry.task.ceoActionMode,
    leverageClass: entry.task.leverageClass,
    blocksCount: entry.task.blocksTaskIds.length,
    lastActivityAt: entry.task.lastActivityAt,
    drivers: entry.result.drivers.slice(0, 3),
  }));
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
