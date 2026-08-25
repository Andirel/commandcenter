/**
 * The deterministic priority engine.
 *
 * Every weight comes from config/priority-rules.yaml, and every score is
 * returned decomposed. A score that cannot be explained is not usable: the
 * daily brief has to be able to say "moved #8 -> #2 because inventory coverage
 * is projected to fall below threshold", and that sentence has to be true.
 *
 * The AI portfolio pass (src/priority/portfolio.ts) may adjust these scores
 * within a bounded ratio. It does not replace them.
 */
import type { PriorityRulesConfig } from '../schemas/config.js';
import type { BusinessSignal } from '../schemas/signals.js';
import type { Task } from '../schemas/tasks.js';

const DAY_MS = 86_400_000;

export interface ScoreComponent {
  label: string;
  value: number;
  /** Why this component contributed what it did, in plain language. */
  explanation: string;
}

export interface PriorityResult {
  score: number;
  baseScore: number;
  components: ScoreComponent[];
  /** Ordered, human-readable drivers, strongest first. */
  drivers: string[];
}

export interface ScoringContext {
  rules: PriorityRulesConfig;
  now?: Date;
  /** Signals currently attached to this task's business area or entities. */
  signals?: BusinessSignal[];
  /** How many other open tasks this one blocks. */
  blocksCount?: number;
}

export function scoreTask(task: Task, ctx: ScoringContext): PriorityResult {
  const { rules } = ctx;
  const now = ctx.now ?? new Date();
  const components: ScoreComponent[] = [];

  const p = task.priority;
  const w = rules.weights;

  // --- Base dimensions -------------------------------------------------------
  push(components, 'impact', p.impact * w.impact, `impact ${p.impact}/5`);
  push(components, 'urgency', p.urgency * w.urgency, `urgency ${p.urgency}/5`);
  push(components, 'risk', p.risk * w.risk, `risk ${p.risk}/5`);
  push(components, 'relationship', p.relationship * w.relationship, `relationship importance ${p.relationship}/5`);
  push(components, 'strategic', p.strategicImportance * w.strategic_importance,
    `strategic importance ${p.strategicImportance}/5`);
  push(components, 'blockerScore', p.blocker * w.blocker, `blocker weight ${p.blocker}/5`);

  // CEO dependency raises priority because CEO time is the constraint being
  // managed -- NOT because the CEO owns it. Those are different things.
  push(components, 'ceoDependency', p.ceoDependency * w.decision_dependency,
    `CEO dependency ${p.ceoDependency}/5`);

  push(components, 'effort', -(p.effort * w.effort_penalty), `effort ${p.effort}/5 (penalty)`);

  // --- Deadline --------------------------------------------------------------
  const deadlineBonus = deadlineComponent(task, rules, now);
  if (deadlineBonus) components.push(deadlineBonus);

  // --- Unblocking others -----------------------------------------------------
  // A task that unblocks other work is worth more than its own score suggests.
  const blocks = ctx.blocksCount ?? task.blocksTaskIds.length;
  if (blocks > 0) {
    const value = Math.min(
      rules.bonuses.blocks_other_tasks_cap,
      blocks * rules.bonuses.blocks_other_tasks_each,
    );
    push(components, 'unblocks', value, `unblocks ${blocks} other ${plural(blocks, 'task')}`);
  }

  // --- Cheap CEO actions with large downstream effect ------------------------
  // A decision costs minutes and can free days. This is why an assembled,
  // decision-ready item outranks CEO-owned work of similar raw impact.
  if (task.ceoActionMode === 'DECIDE' && task.status !== 'proposed') {
    push(components, 'decisionReady', rules.bonuses.decision_ready_bonus,
      'assembled and waiting only on a decision');
  }
  if (task.ceoActionMode === 'APPROVE') {
    push(components, 'approveOnly', rules.bonuses.approve_only_bonus,
      'needs only an approval');
  }

  // --- Relationship debt -----------------------------------------------------
  if (task.status === 'waiting_external' && task.waitingOnOrganizationId === null) {
    push(components, 'weOweExternal', rules.bonuses.we_owe_external_bonus,
      'an outside party is waiting on us');
  }

  // --- Penalties -------------------------------------------------------------
  const stale = stalenessComponent(task, rules, now);
  if (stale) components.push(stale);

  if (task.status === 'proposed') {
    push(components, 'unconfirmed', -rules.penalties.unconfirmed_proposal_penalty,
      'system-proposed and not yet accepted by a human');
  }
  if (task.confidence < rules.penalties.low_confidence_threshold) {
    push(components, 'lowConfidence', -rules.penalties.low_confidence_penalty,
      `interpretation confidence is only ${task.confidence.toFixed(2)}`);
  }
  if (task.status === 'waiting_external') {
    push(components, 'waitingExternal', -rules.penalties.waiting_external_penalty,
      'blocked on an external party');
  } else if (task.status === 'waiting_internal') {
    push(components, 'waitingInternal', -rules.penalties.waiting_internal_penalty,
      'blocked on someone internal');
  }

  const baseScore = round(components.reduce((sum, c) => sum + c.value, 0));

  // --- Signal multipliers and compound rules ---------------------------------
  const { score, extra } = applySignals(baseScore, ctx);
  components.push(...extra);

  const drivers = components
    .filter((c) => Math.abs(c.value) >= 0.5)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map((c) => c.explanation);

  return { score: round(score), baseScore, components, drivers };
}

// ---------------------------------------------------------------------------

function deadlineComponent(task: Task, rules: PriorityRulesConfig, now: Date): ScoreComponent | null {
  if (!task.deadline) return null;
  const b = rules.bonuses.deadline_bonus;
  const days = (Date.parse(task.deadline) - now.getTime()) / DAY_MS;

  if (days < 0) {
    return comp('deadline', b.overdue, `overdue by ${Math.abs(Math.floor(days))} ${plural(Math.abs(Math.floor(days)), 'day')}`);
  }
  if (days <= 1) return comp('deadline', b.within_24h, 'due within 24 hours');
  if (days <= 3) return comp('deadline', b.within_3d, 'due within 3 days');
  if (days <= 7) return comp('deadline', b.within_7d, 'due within a week');
  if (days <= 14) return comp('deadline', b.within_14d, 'due within two weeks');
  return null;
}

/**
 * Work nobody has touched loses urgency but never disappears -- it surfaces in
 * the stale review instead of silently rotting at the bottom of the list.
 */
function stalenessComponent(task: Task, rules: PriorityRulesConfig, now: Date): ScoreComponent | null {
  if (!task.lastActivityAt) return null;
  const days = (now.getTime() - Date.parse(task.lastActivityAt)) / DAY_MS;
  if (days < rules.penalties.stale_days_threshold) return null;
  return comp('stale', -rules.penalties.stale_penalty, `no activity for ${Math.floor(days)} days`);
}

/**
 * Financial and operational reality changes priority on its own.
 *
 * Compound rules are the point of this section: a production payment coming
 * due is moderate, low inventory coverage is moderate, and the two together
 * are urgent. A single-source system cannot see that.
 */
function applySignals(
  base: number,
  ctx: ScoringContext,
): { score: number; extra: ScoreComponent[] } {
  const signals = ctx.signals ?? [];
  if (!signals.length) return { score: base, extra: [] };

  const extra: ScoreComponent[] = [];
  const types = new Set(signals.map((s) => s.signalType));
  let score = base;

  // Highest single multiplier applies; multipliers do not compound with each
  // other, or a task touching four signals would run away with the ranking.
  let bestType: string | null = null;
  let bestMultiplier = 1;
  for (const type of types) {
    const m = ctx.rules.signal_multipliers[type];
    if (m && m > bestMultiplier) { bestMultiplier = m; bestType = type; }
  }
  if (bestType && bestMultiplier > 1) {
    const delta = score * (bestMultiplier - 1);
    score += delta;
    extra.push(comp('signal', round(delta), `${bestType.replace(/_/g, ' ')} signal is active`));
  }

  for (const rule of ctx.rules.compound_rules) {
    if (!compoundMatches(rule, types)) continue;
    if (rule.multiplier) {
      const delta = score * (rule.multiplier - 1);
      score += delta;
      extra.push(comp(`compound:${rule.name}`, round(delta), rule.reason));
    }
    if (rule.bonus) {
      score += rule.bonus;
      extra.push(comp(`compound:${rule.name}`, rule.bonus, rule.reason));
    }
  }

  return { score, extra };
}

function compoundMatches(rule: PriorityRulesConfig['compound_rules'][number], types: Set<string>): boolean {
  const when = rule.when as { all?: Array<Record<string, unknown>> };
  if (!Array.isArray(when.all)) return false;
  // Only the signal-based conditions are evaluated here; the time-based ones
  // (waiting_external_days_gte, blocks_other_tasks_gte) are applied by the
  // caller, which holds that state.
  const signalConditions = when.all.filter((c) => typeof c.signal === 'string');
  if (!signalConditions.length) return false;
  return signalConditions.every((c) => types.has(c.signal as string));
}

// ---------------------------------------------------------------------------

function comp(label: string, value: number, explanation: string): ScoreComponent {
  return { label, value: round(value), explanation };
}

function push(list: ScoreComponent[], label: string, value: number, explanation: string): void {
  if (value === 0) return;
  list.push(comp(label, value, explanation));
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
