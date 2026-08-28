/**
 * Where attention goes, and where it does not have to.
 *
 * Three questions the brief asks separately because they have different
 * answers: what is consuming the CEO, what could Paul absorb, and where does
 * Mike's load concentrate.
 *
 * The distinction that makes this worth computing is one Command Center
 * already encodes and most tools miss: **needing the CEO is not the same as
 * being the CEO's job.** A decision only Adi can make is not a candidate for
 * delegation at any price. Coordination, chasing and research that happen to
 * pass through him are. Lumping them together produces the useless conclusion
 * that the CEO is busy; separating them produces a list of work that can move.
 *
 * `ActionMode` and `LeverageClass` already carry that judgment per task, so
 * this module aggregates rather than re-deciding.
 */
import type { WorkInstance, WorkPattern } from './patterns.js';

/**
 * Modes that are the CEO's to keep. A decision or an approval is the exercise
 * of authority; moving it elsewhere does not save attention, it relocates
 * accountability.
 */
const IRREDUCIBLE_MODES = new Set(['DECIDE', 'APPROVE']);

/**
 * Modes that are attention leaks. Each is the CEO doing something because
 * nobody else picked it up, not because it required him.
 */
const MOVEABLE_MODES = new Set(['DO', 'FOLLOW_UP', 'REVIEW', 'DELEGATE', 'AWARE']);

export interface AttentionSink {
  patternId: string;
  label: string;
  /** How many instances pulled the CEO in at all. */
  touches: number;
  /** Of those, how many were his to make. */
  irreducible: number;
  /** Of those, how many were coordination he happened to be holding. */
  moveable: number;
  /** Instances flagged delegable by the routing engine. */
  delegable: number;
  medianCycleDays: number;
  totalValueAtStake: number;
  /** Ranking figure: moveable touches weighted by how slow the pattern is. */
  drainScore: number;
  /** Named person the work could move to, where the evidence names one. */
  couldMoveTo: string[];
  examples: string[];
}

export interface LeverageOpportunity {
  patternId: string;
  label: string;
  /** Instances where the CEO is involved AND the work is delegable. */
  instances: number;
  medianCycleDays: number;
  /** Who is already doing this kind of work alongside him. */
  currentParticipants: string[];
  reason: string;
  examples: string[];
}

export interface LoadCluster {
  person: string;
  patterns: Array<{ patternId: string; label: string; instances: number }>;
  totalInstances: number;
  medianCycleDays: number;
  /** Patterns where this person is the only internal participant. */
  soleOwnerPatterns: number;
}

export interface AttentionAnalysis {
  ceoSinks: AttentionSink[];
  ceoIrreducibleCount: number;
  ceoMoveableCount: number;
  leverageOpportunities: LeverageOpportunity[];
  loadByPerson: LoadCluster[];
}

export interface AttentionOptions {
  ceoName?: string;
  /** Whoever absorbs coordination. Named so the analysis can say where work goes. */
  coordinatorName?: string;
}

export function analyzeAttention(
  patterns: WorkPattern[],
  opts: AttentionOptions = {},
): AttentionAnalysis {
  const ceo = opts.ceoName ?? 'Adi';
  const coordinator = opts.coordinatorName ?? 'Paul';

  const ceoSinks: AttentionSink[] = [];
  const leverageOpportunities: LeverageOpportunity[] = [];
  let irreducibleTotal = 0;
  let moveableTotal = 0;

  for (const p of patterns) {
    const touched = p.instances.filter((w) => w.ceoRequired || w.people.includes(ceo));
    if (!touched.length) continue;

    const irreducible = touched.filter((w) => w.ceoActionMode && IRREDUCIBLE_MODES.has(w.ceoActionMode));
    const moveable = touched.filter((w) => !w.ceoActionMode || MOVEABLE_MODES.has(w.ceoActionMode));
    const delegable = touched.filter((w) => w.delegable);

    irreducibleTotal += irreducible.length;
    moveableTotal += moveable.length;

    ceoSinks.push({
      patternId: p.id,
      label: p.label,
      touches: touched.length,
      irreducible: irreducible.length,
      moveable: moveable.length,
      delegable: delegable.length,
      medianCycleDays: p.medianCycleDays,
      totalValueAtStake: p.totalValueAtStake,
      /*
       * Slow work costs more attention than its instance count suggests: each
       * extra day is another day it can resurface, be asked about, and be
       * re-read. The log keeps a very slow pattern from swamping the ranking
       * outright.
       */
      drainScore: round(moveable.length * (1 + Math.log10(1 + p.medianCycleDays))),
      couldMoveTo: whoElse(touched, ceo),
      examples: touched.slice(0, 3).map((w) => w.title),
    });

    // A leverage opportunity is narrower than a sink: the CEO is involved, the
    // engine says it is delegable, and it is not an act of authority.
    const candidates = touched.filter(
      (w) => w.delegable && (!w.ceoActionMode || MOVEABLE_MODES.has(w.ceoActionMode)),
    );
    if (candidates.length) {
      const others = whoElse(candidates, ceo);
      leverageOpportunities.push({
        patternId: p.id,
        label: p.label,
        instances: candidates.length,
        medianCycleDays: p.medianCycleDays,
        currentParticipants: others,
        reason: reasonFor(candidates, others, coordinator),
        examples: candidates.slice(0, 3).map((w) => w.title),
      });
    }
  }

  ceoSinks.sort((a, b) => b.drainScore - a.drainScore);
  leverageOpportunities.sort((a, b) => b.instances - a.instances || b.medianCycleDays - a.medianCycleDays);

  return {
    ceoSinks,
    ceoIrreducibleCount: irreducibleTotal,
    ceoMoveableCount: moveableTotal,
    leverageOpportunities,
    loadByPerson: loadByPerson(patterns, ceo),
  };
}

/** Internal people on this work other than the CEO. */
function whoElse(instances: WorkInstance[], ceo: string): string[] {
  const names = new Set<string>();
  for (const w of instances) for (const p of w.people) if (p !== ceo) names.add(p);
  return [...names].sort();
}

function reasonFor(instances: WorkInstance[], others: string[], coordinator: string): string {
  const n = instances.length;
  if (others.includes(coordinator)) {
    return `${coordinator} is already on ${n === 1 ? 'this' : 'these'} — the work is being ` +
      `coordinated jointly rather than handed over.`;
  }
  if (others.length) {
    return `${others.join(', ')} already ${others.length === 1 ? 'carries' : 'carry'} this work; ` +
      `the CEO's involvement looks like oversight rather than execution.`;
  }
  return `Nobody else is on this yet, so it stays with the CEO by default rather than by design.`;
}

/**
 * Where each person's work concentrates.
 *
 * `soleOwnerPatterns` is the number that matters most: a person who is the only
 * internal participant across several recurring patterns is a single point of
 * failure, which is a different problem from simply being busy.
 */
function loadByPerson(patterns: WorkPattern[], ceo: string): LoadCluster[] {
  const acc = new Map<string, { rows: LoadCluster['patterns']; cycles: number[]; sole: number }>();

  for (const p of patterns) {
    for (const person of p.peopleInvolved) {
      if (person === ceo) continue;
      const involved = p.instances.filter((w) => w.people.includes(person));
      if (!involved.length) continue;

      if (!acc.has(person)) acc.set(person, { rows: [], cycles: [], sole: 0 });
      const a = acc.get(person)!;
      a.rows.push({ patternId: p.id, label: p.label, instances: involved.length });
      a.cycles.push(p.medianCycleDays);

      const alone = involved.every((w) => w.people.filter((x) => x !== ceo).length === 1);
      if (alone) a.sole++;
    }
  }

  return [...acc.entries()]
    .map(([person, a]) => ({
      person,
      patterns: a.rows.sort((x, y) => y.instances - x.instances),
      totalInstances: a.rows.reduce((n, r) => n + r.instances, 0),
      medianCycleDays: median([...a.cycles].sort((x, y) => x - y)),
      soleOwnerPatterns: a.sole,
    }))
    .sort((a, b) => b.totalInstances - a.totalInstances);
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
