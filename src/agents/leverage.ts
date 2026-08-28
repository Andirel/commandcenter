/**
 * Scoring a candidate agent, explainably.
 *
 * The brief is explicit that AI intuition must not decide the ranking, and this
 * codebase already works that way everywhere else: `src/priority/score.ts` is a
 * deterministic formula and the model may only nudge it within a clamp. The
 * same split applies here. This module produces the number; the model may
 * comment on it, reorder within a bounded range, and name things.
 *
 * Every dimension is derived from something already counted. If a dimension
 * cannot be computed from the record, it scores zero and says so rather than
 * being estimated — a score with an invented input is a guess wearing a
 * decimal point.
 */
import type { WorkPattern } from './patterns.js';
import type { AttentionAnalysis } from './attention.js';
import type { BottleneckAnalysis } from './bottlenecks.js';

export interface LeverageWeights {
  frequency: number;
  humanTime: number;
  ceoTime: number;
  economicImpact: number;
  coordinationComplexity: number;
  repeatability: number;
  dataAvailability: number;
  measurability: number;
  automationPotential: number;
  failureCost: number;
}

/**
 * Defaults, deliberately weighted toward CEO time and economic impact.
 *
 * The system's whole purpose is progress per unit of attention, so a pattern
 * that eats the scarcest attention outranks a more frequent one that does not.
 * Overridable so the weighting is a business decision rather than a constant
 * buried in a function.
 */
export const DEFAULT_WEIGHTS: LeverageWeights = {
  frequency: 1.0,
  humanTime: 1.2,
  ceoTime: 2.0,
  economicImpact: 1.8,
  coordinationComplexity: 1.2,
  repeatability: 1.4,
  dataAvailability: 1.0,
  measurability: 1.0,
  automationPotential: 1.5,
  failureCost: 1.3,
};

export interface LeverageDimension {
  name: keyof LeverageWeights;
  /** 0–1 before weighting. */
  raw: number;
  weighted: number;
  /** Why it scored what it scored, in a sentence a human can check. */
  basis: string;
  /** False when the record could not support the dimension at all. */
  computed: boolean;
}

export interface LeverageScore {
  patternId: string;
  label: string;
  total: number;
  /** Total as a share of the maximum achievable, for comparability. */
  normalized: number;
  dimensions: LeverageDimension[];
  /** Dimensions that scored zero because the data was missing, not because the value is low. */
  uncomputed: string[];
}

export interface ScoringContext {
  attention: AttentionAnalysis;
  bottlenecks: BottleneckAnalysis;
  /** Instances across all patterns, for relative frequency. */
  totalInstances: number;
  weights?: Partial<LeverageWeights>;
}

export function scorePattern(pattern: WorkPattern, ctx: ScoringContext): LeverageScore {
  const w = { ...DEFAULT_WEIGHTS, ...(ctx.weights ?? {}) };
  const sink = ctx.attention.ceoSinks.find((s) => s.patternId === pattern.id);
  const related = ctx.bottlenecks.bottlenecks.filter(
    (b) => b.subject === pattern.label || pattern.peopleInvolved.includes(b.subject),
  );

  const dims: LeverageDimension[] = [];
  const add = (name: keyof LeverageWeights, raw: number, basis: string, computed = true) => {
    const clamped = Math.max(0, Math.min(1, raw));
    dims.push({ name, raw: round(clamped), weighted: round(clamped * w[name]), basis, computed });
  };

  // --- frequency ----------------------------------------------------------
  const share = ctx.totalInstances > 0 ? pattern.frequency / ctx.totalInstances : 0;
  add('frequency', Math.min(1, share * 4),
    `${pattern.frequency} of ${ctx.totalInstances} work items (${pct(share)}).`);

  // --- human time ---------------------------------------------------------
  // People multiplied by elapsed days: the coordination tax, not just duration.
  const humanLoad = pattern.averageParticipants * pattern.medianCycleDays;
  add('humanTime', Math.min(1, humanLoad / 30),
    `${pattern.averageParticipants} people over a median ${pattern.medianCycleDays} business days.`);

  // --- CEO time -----------------------------------------------------------
  if (sink) {
    add('ceoTime', Math.min(1, sink.drainScore / 10),
      `${sink.moveable} moveable CEO touch${sink.moveable === 1 ? '' : 'es'} of ${sink.touches} ` +
      `(${sink.irreducible} irreducible), drain score ${sink.drainScore}.`);
  } else {
    add('ceoTime', 0, 'The CEO does not appear on this pattern.', true);
  }

  // --- economic impact ----------------------------------------------------
  if (pattern.totalValueAtStake > 0) {
    // Log scale: $250k matters far more than $25k, but not ten times more for
    // ranking purposes, and a single large number should not erase everything.
    add('economicImpact', Math.min(1, Math.log10(1 + pattern.totalValueAtStake) / 6),
      `$${Math.round(pattern.totalValueAtStake).toLocaleString()} at stake across the pattern.`);
  } else {
    add('economicImpact', 0,
      'No value at stake was recorded on any instance — impact is unmeasured, not absent.', false);
  }

  // --- coordination complexity --------------------------------------------
  add('coordinationComplexity', Math.min(1, (pattern.averageParticipants - 1) / 4),
    `${pattern.averageParticipants} internal participants on average` +
    (pattern.externalParties.length ? `, plus ${pattern.externalParties.join(', ')}.` : '.'));

  // --- repeatability ------------------------------------------------------
  // Same capabilities and same shape each time means the reasoning repeats,
  // which is precisely what an agent can hold.
  const shapes = new Set(pattern.instances.map((i) => `${i.ceoActionMode}|${i.capabilities.join('+')}`));
  add('repeatability', pattern.frequency > 1 ? 1 - (shapes.size - 1) / pattern.frequency : 0,
    `${shapes.size} distinct shape${shapes.size === 1 ? '' : 's'} across ${pattern.frequency} instances.`);

  // --- data availability --------------------------------------------------
  const withArea = pattern.instances.filter((i) => i.businessArea).length;
  const withCaps = pattern.instances.filter((i) => i.capabilities.length).length;
  add('dataAvailability', (withArea + withCaps) / (pattern.frequency * 2),
    `${withCaps}/${pattern.frequency} carry capabilities, ${withArea}/${pattern.frequency} carry a business area.`);

  // --- measurability ------------------------------------------------------
  // Can we tell afterwards whether it worked? Without that an agent cannot improve.
  if (pattern.instances.some((i) => i.completed)) {
    add('measurability', pattern.completionRate,
      `${pct(pattern.completionRate)} of instances reached a recorded completion.`);
  } else {
    add('measurability', 0,
      'No instance has completed yet, so success cannot be observed after the fact.', false);
  }

  // --- automation potential ------------------------------------------------
  // Delegable work with few irreducible decisions is what an agent can carry.
  const delegableShare = pattern.delegableCount / pattern.frequency;
  const irreducibleShare = sink ? sink.irreducible / Math.max(1, sink.touches) : 0;
  add('automationPotential', delegableShare * (1 - irreducibleShare * 0.7),
    `${pct(delegableShare)} delegable; ${pct(irreducibleShare)} of CEO touches are decisions or approvals.`);

  // --- failure cost --------------------------------------------------------
  const severity = related.length ? Math.max(...related.map((b) => b.severity)) : 0;
  add('failureCost', severity / 10,
    related.length
      ? `Linked to ${related.length} recorded bottleneck${related.length === 1 ? '' : 's'}, worst severity ${severity}/10.`
      : 'No bottleneck has yet been recorded against this pattern.');

  const total = dims.reduce((n, d) => n + d.weighted, 0);
  const max = Object.values(w).reduce((n, x) => n + x, 0);

  return {
    patternId: pattern.id,
    label: pattern.label,
    total: round(total),
    normalized: round(total / max),
    dimensions: dims,
    uncomputed: dims.filter((d) => !d.computed).map((d) => d.name),
  };
}

export function scoreAll(patterns: WorkPattern[], ctx: ScoringContext): LeverageScore[] {
  return patterns
    .map((p) => scorePattern(p, ctx))
    .sort((a, b) => b.total - a.total);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
