/**
 * Ranking and change explanation.
 *
 * The rank itself is easy. The valuable part is knowing WHY something moved,
 * and being disciplined about which movements are worth a human's attention --
 * a brief that narrates every one-place shuffle teaches the reader to skim.
 */
import type { PriorityRulesConfig } from '../schemas/config.js';
import type { Task } from '../schemas/tasks.js';
import { scoreTask, type PriorityResult, type ScoringContext } from './score.js';

export interface RankedTask {
  task: Task;
  score: number;
  rank: number;
  result: PriorityResult;
}

export interface RankChange {
  taskId: string;
  title: string;
  oldRank: number | null;
  newRank: number | null;
  oldScore: number;
  newScore: number;
  /** Populated only when the change is material. */
  reason: string;
  material: boolean;
}

export function rankTasks(
  tasks: Task[],
  ctxFor: (task: Task) => ScoringContext,
): RankedTask[] {
  const scored = tasks.map((task) => {
    const result = scoreTask(task, ctxFor(task));
    return { task, score: result.score, result, rank: 0 };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable, meaningful tiebreak: an earlier deadline goes first, then the
    // older task, so ordering does not jitter between runs.
    const ad = a.task.deadline ? Date.parse(a.task.deadline) : Infinity;
    const bd = b.task.deadline ? Date.parse(b.task.deadline) : Infinity;
    if (ad !== bd) return ad - bd;
    return (a.task.createdAt ?? '').localeCompare(b.task.createdAt ?? '');
  });

  scored.forEach((entry, i) => { entry.rank = i + 1; });
  return scored;
}

/**
 * Diff two rankings.
 *
 * `material` gates what reaches a brief. Everything is still recorded in
 * priority_history -- we suppress narration, not the audit trail.
 */
export function diffRankings(
  previous: RankedTask[],
  current: RankedTask[],
  rules: PriorityRulesConfig,
): RankChange[] {
  const prevById = new Map(previous.map((r) => [r.task.id, r]));
  const changes: RankChange[] = [];

  for (const entry of current) {
    const before = prevById.get(entry.task.id);

    if (!before) {
      changes.push({
        taskId: entry.task.id,
        title: entry.task.title,
        oldRank: null,
        newRank: entry.rank,
        oldScore: 0,
        newScore: entry.score,
        reason: `New: ${entry.result.drivers[0] ?? 'entered the working set'}.`,
        material: entry.rank <= rules.ranking.daily_brief.ceo_top_n,
      });
      continue;
    }

    const rankDelta = before.rank - entry.rank;
    const scoreDelta = entry.score - before.score;
    if (rankDelta === 0 && Math.abs(scoreDelta) < rules.ranking.material_score_change) continue;

    const material =
      Math.abs(rankDelta) >= rules.ranking.material_rank_change ||
      Math.abs(scoreDelta) >= rules.ranking.material_score_change;

    changes.push({
      taskId: entry.task.id,
      title: entry.task.title,
      oldRank: before.rank,
      newRank: entry.rank,
      oldScore: before.score,
      newScore: entry.score,
      reason: explainChange(before, entry, rankDelta),
      material,
    });
  }

  return changes.sort((a, b) => Math.abs((b.oldRank ?? 99) - (b.newRank ?? 99)) - Math.abs((a.oldRank ?? 99) - (a.newRank ?? 99)));
}

/**
 * Explain a movement by finding which score components actually changed,
 * rather than restating the new score.
 */
function explainChange(before: RankedTask, after: RankedTask, rankDelta: number): string {
  const beforeByLabel = new Map(before.result.components.map((c) => [c.label, c]));
  const gains: string[] = [];

  for (const comp of after.result.components) {
    const prior = beforeByLabel.get(comp.label);
    const delta = comp.value - (prior?.value ?? 0);
    if (Math.abs(delta) < 0.5) continue;
    gains.push(comp.explanation);
  }

  for (const comp of before.result.components) {
    if (after.result.components.some((c) => c.label === comp.label)) continue;
    if (Math.abs(comp.value) < 0.5) continue;
    gains.push(`no longer ${comp.explanation}`);
  }

  const direction = rankDelta > 0 ? 'moved up' : rankDelta < 0 ? 'moved down' : 'changed score';
  const movement = before.rank !== after.rank ? `${direction} #${before.rank} → #${after.rank}` : direction;
  const cause = gains.length ? gains.slice(0, 2).join('; ') : after.result.drivers[0] ?? 'scoring inputs changed';
  return `${movement} because ${cause}.`;
}

/** Tasks worth a human's attention today. */
export function briefWorthy(ranked: RankedTask[], rules: PriorityRulesConfig): RankedTask[] {
  return ranked.filter((r) => r.score >= rules.ranking.brief_inclusion_floor);
}
