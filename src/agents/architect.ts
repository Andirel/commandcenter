/**
 * The Agent Architect.
 *
 * Its job is not to run the business. It is to work out which specialised
 * agents this company would actually benefit from, propose them with the
 * evidence attached, and say plainly which candidates are not worth building.
 *
 * Two disciplines govern it, and both are inherited from parts of Command
 * Center that already earned them the hard way:
 *
 *   1. The coverage gate. `assessCoverage` runs first, and its verdict caps
 *      the confidence of everything downstream. On thin data the report
 *      demotes itself to a method demonstration rather than quietly sounding
 *      the same as one built on a year.
 *
 *   2. The default answer is NOT an agent. Every candidate is tested against
 *      four outcomes, three of which mean no agent gets built. A report where
 *      everything is an agent has skipped the only judgment that matters.
 */
import type { Ledger } from '../ledger/types.js';
import type { CanonicalEvent } from '../schemas/events.js';
import { assessCoverage, type CoverageReport, type CoverageVerdict } from './coverage.js';
import { toWorkInstances, clusterWork, type WorkPattern } from './patterns.js';
import { analyzeAttention, type AttentionAnalysis } from './attention.js';
import { analyzeBottlenecks, type BottleneckAnalysis } from './bottlenecks.js';
import { scoreAll, type LeverageScore, type LeverageWeights } from './leverage.js';
import {
  AgentProposal, sanitizePermissions, type AgentPermission, type CandidateVerdict,
} from './registry.js';

export interface ArchitectInput {
  ledger: Ledger;
  events?: CanonicalEvent[];
  meetings?: number;
  now?: Date;
  ceoName?: string;
  coordinatorName?: string;
  weights?: Partial<LeverageWeights>;
}

export interface ArchitectReport {
  generatedAt: string;
  coverage: CoverageReport;
  /** Capped by coverage. Never higher than the evidence allows. */
  confidence: CoverageVerdict;
  patterns: WorkPattern[];
  attention: AttentionAnalysis;
  bottlenecks: BottleneckAnalysis;
  scores: LeverageScore[];
  proposals: AgentProposal[];
  /** Candidates deliberately not proposed as agents, with the reason. */
  notAgents: AgentProposal[];
  /** What a reader should do with this report, given its coverage. */
  readingGuidance: string;
}

/**
 * A candidate must clear this share of the maximum leverage score to be worth
 * its own agent. Below it, the work is real but does not justify persistent
 * specialised context — it is a capability of something broader.
 */
export const AGENT_THRESHOLD = 0.42;

/** Below this, the pattern is not worth building anything for at all. */
export const FLOOR_THRESHOLD = 0.18;

/**
 * How alike two candidates must be before the weaker folds into the stronger.
 *
 * Fragmentation is the failure mode this defends against, and it is a quiet
 * one: three agents that each handle a slice of retail follow-through all look
 * reasonable on their own proposal page, and only look absurd side by side.
 * Jaccard over required capabilities, because that is the fact the routing
 * engine already established rather than a judgment made here.
 */
export const FOLD_SIMILARITY = 0.5;

/**
 * A window long enough that a burst can be distinguished from a routine.
 *
 * Below this the whole record IS a burst, and demoting patterns for being
 * concentrated would reject everything.
 */
export const EPISODIC_MIN_OBSERVATION_DAYS = 60;

/** A pattern packed into this share of the observation window is an episode. */
export const EPISODIC_SPAN_SHARE = 0.15;

export function runArchitect(input: ArchitectInput): ArchitectReport {
  const now = input.now ?? new Date();
  const ceoName = input.ceoName ?? 'Adi';
  const coordinatorName = input.coordinatorName ?? 'Paul';

  // 1. Coverage first, so nothing downstream can outrun the evidence.
  const coverage = assessCoverage({
    ledger: input.ledger,
    ...(input.events ? { events: input.events } : {}),
    ...(input.meetings !== undefined ? { meetings: input.meetings } : {}),
  });

  // 2. Deterministic analysis.
  const instances = toWorkInstances(input.ledger, now);
  const patterns = clusterWork(instances);
  const attention = analyzeAttention(patterns, { ceoName, coordinatorName });
  const bottlenecks = analyzeBottlenecks(input.ledger, patterns, { now, ceoName });

  const scores = scoreAll(patterns, {
    attention,
    bottlenecks,
    totalInstances: instances.length,
    ...(input.weights ? { weights: input.weights } : {}),
  });

  // 3. Candidates, each judged against the four outcomes.
  const judged: AgentProposal[] = [];
  for (const score of scores) {
    const pattern = patterns.find((p) => p.id === score.patternId);
    if (!pattern) continue;
    judged.push(propose(pattern, score, attention, coverage, now, ceoName, coordinatorName));
  }

  // 4. Consolidation. Judging candidates one at a time cannot see that two of
  //    them are the same job described twice; this pass can.
  const consolidated = consolidate(judged, patterns);

  const proposals = consolidated.filter((p) => p.verdict === 'agent');
  const notAgents = consolidated.filter((p) => p.verdict !== 'agent');

  return {
    generatedAt: now.toISOString(),
    coverage,
    confidence: coverage.verdict,
    patterns,
    attention,
    bottlenecks,
    scores,
    proposals,
    notAgents,
    readingGuidance: guidance(coverage.verdict, proposals.length, notAgents.length),
  };
}

/**
 * Which of the four outcomes this candidate deserves.
 *
 * Order matters. The cheapest and safest answers are tested first, so a
 * candidate has to survive being called "not worth it" and "just write the
 * code" before it can be called an agent.
 */
function decideVerdict(
  pattern: WorkPattern,
  score: LeverageScore,
  attention: AttentionAnalysis,
  observationSpanDays: number,
): { verdict: CandidateVerdict; rationale: string } {
  if (!pattern.recurring) {
    return {
      verdict: 'not_worth_it',
      rationale: `Only ${pattern.frequency} instance${pattern.frequency === 1 ? '' : 's'} — ` +
        `not yet a recurrence. Building for it would be designing around an anecdote.`,
    };
  }
  /*
   * An episode, not a pattern.
   *
   * A co-packer transition or a recall generates a dense cluster of very
   * similar work over a fortnight and then never recurs. By frequency it
   * outranks the thing that happens twice a month all year, which is exactly
   * backwards: the architecture would be built around the worst month the
   * company ever had. Checked only once the window is long enough for the
   * comparison to mean anything.
   */
  const episodicCeiling = Math.max(14, observationSpanDays * EPISODIC_SPAN_SHARE);
  if (observationSpanDays >= EPISODIC_MIN_OBSERVATION_DAYS && pattern.spanDays <= episodicCeiling) {
    return {
      verdict: 'not_worth_it',
      rationale: `All ${pattern.frequency} instances fall inside ${pattern.spanDays} days of a ` +
        `${observationSpanDays}-day record. That is an episode the company worked through, not ` +
        `recurring work — building an agent for it would design around one unusual month.`,
    };
  }

  if (score.normalized < FLOOR_THRESHOLD) {
    return {
      verdict: 'not_worth_it',
      rationale: `Leverage ${score.normalized} is below the floor: it recurs, but it consumes ` +
        `little attention and carries little at stake.`,
    };
  }

  /*
   * Work an outside firm already performs.
   *
   * Tested before anything else that could produce a build, and deliberately
   * NOT conditioned on the score: an agency doing agency work well produces a
   * high-frequency, low-friction pattern, which is exactly the shape that
   * scores well. Ranking alone would therefore recommend rebuilding the
   * supplier, which is the most expensive possible way to be wrong here.
   *
   * The distinguisher from work we merely do WITH an outsider is internal
   * involvement. A retail buyer is an external party we chase constantly; an
   * agency is an external party we hear from. Low CEO touch on every instance
   * with a partner attached is the signature of the second.
   */
  const alwaysExternal = pattern.instances.every((i) => i.externalParty);
  if (pattern.externalParties.length && alwaysExternal && pattern.ceoTouchRate < 0.25) {
    return {
      verdict: 'not_worth_it',
      rationale: `${pattern.externalParties.join(', ')} already ${pattern.externalParties.length === 1 ? 'performs' : 'perform'} ` +
        `this work on every instance and it almost never reaches the CEO. That is a supplier ` +
        `relationship to manage, not an agent to build — an agent here would duplicate a vendor.`,
    };
  }

  /*
   * Work that is entirely the CEO's judgment.
   *
   * `ceoRequired` with an irreducible mode on every instance means there is
   * nothing for an agent to carry: an approval or a decision moved elsewhere
   * is not attention saved, it is accountability relocated. Preparation can
   * still be folded into a broader agent, which is what `capability` means.
   */
  const sink = attention.ceoSinks.find((s) => s.patternId === pattern.id);
  if (sink && sink.touches >= pattern.frequency && sink.moveable === 0) {
    return {
      verdict: 'capability',
      rationale: `All ${sink.touches} instances are the CEO deciding or approving. None of it can ` +
        `be delegated to an agent without relocating accountability; the preparation belongs to a ` +
        `broader agent, the judgment stays with him.`,
    };
  }

  /*
   * Work a script does better than a model.
   *
   * Every condition here is a way of asking "is there any judgment in this?".
   * Repeatability alone is not enough — most clusters look repeatable because
   * the metadata that formed them is identical by construction. Cycle time is
   * the honest signal: work that resolves in a day or two involves nobody
   * waiting on anybody. Money, an outside party, or a non-GREEN class each
   * mean a wrong answer costs something, and code that cannot explain itself
   * is the wrong place to put that.
   */
  const repeatability = dim(score, 'repeatability');
  if (
    repeatability >= 0.85
    && (!sink || sink.touches === 0)
    && pattern.averageParticipants <= 2
    && !pattern.externalParties.length
    && pattern.totalValueAtStake === 0
    && pattern.medianCycleDays <= 3
    && worstApprovalClass(pattern) !== 'RED'
  ) {
    return {
      verdict: 'deterministic_workflow',
      rationale: `The same shape every time, no CEO involvement, ${pattern.averageParticipants} ` +
        `participant${pattern.averageParticipants === 1 ? '' : 's'}, resolved in a median ` +
        `${pattern.medianCycleDays} business day${pattern.medianCycleDays === 1 ? '' : 's'} with ` +
        `nothing at stake. A scripted workflow does this more cheaply and cannot be confidently wrong.`,
    };
  }

  if (score.normalized < AGENT_THRESHOLD) {
    return {
      verdict: 'capability',
      rationale: `Real recurring work, but leverage ${score.normalized} does not justify persistent ` +
        `specialised context, its own tools and its own evaluation.`,
    };
  }

  return {
    verdict: 'agent',
    rationale: `Leverage ${score.normalized} across ${pattern.frequency} instances, with distinct ` +
      `context and a measurable outcome.`,
  };
}

function propose(
  pattern: WorkPattern,
  score: LeverageScore,
  attention: AttentionAnalysis,
  coverage: CoverageReport,
  now: Date,
  ceoName: string,
  coordinatorName: string,
): AgentProposal {
  const { verdict, rationale } = decideVerdict(pattern, score, attention, coverage.spanDays);
  const sink = attention.ceoSinks.find((s) => s.patternId === pattern.id);
  const leverage = attention.leverageOpportunities.find((l) => l.patternId === pattern.id);

  const humanCounterpart = pickCounterpart(pattern, leverage?.currentParticipants ?? [], ceoName, coordinatorName);
  const { granted } = sanitizePermissions(permissionsFor(pattern));

  return AgentProposal.parse({
    id: `prop:${pattern.id}`,
    slug: slug(pattern.label),
    name: titleCase(pattern.label),
    verdict,
    mission: missionFor(pattern, sink),
    whyItExists: rationale,

    patternIds: [pattern.id],
    evidence: evidenceFor(pattern, sink, score),
    leverageScore: score.total,
    leverageNormalized: score.normalized,

    primaryJobs: jobsFor(pattern),
    humanCounterpart,
    decisionMaker: sink && sink.irreducible > 0 ? ceoName : humanCounterpart,
    externalCounterparts: pattern.externalParties,

    requiredData: dataFor(pattern),
    permissions: granted,
    allowedActions: [
      'Analyse the pattern and summarise state',
      'Prepare drafts for a named human to send',
      'Create and update internal tasks',
      'Surface blockers and missing information',
    ],
    // Spelled out rather than implied. The absence of a permission is the real
    // control, but a reader of the proposal should see the boundary stated.
    disallowedActions: [
      'Send any external communication',
      'Commit money or place an order',
      'Change a campaign or a production system',
      'Decide anything in the RED approval class',
    ],
    approvalClass: worstApprovalClass(pattern),
    limits: {
      maxSubjobs: 3,
      maxDepth: 2,
      maxRuntimeSeconds: 300,
      budgetCents: 500,
      allowedTargetAgents: [],
    },

    metrics: metricsFor(pattern),
    // Estimates only where the arithmetic supports one. A null here is a
    // refusal to guess, and reads as such next to a populated field.
    estimatedCeoTouchesRemoved: sink ? sink.moveable : null,
    estimatedHoursSavedPerMonth: null,
    estimatedValueAtStake: pattern.totalValueAtStake > 0 ? pattern.totalValueAtStake : null,

    // Coverage caps confidence. A perfectly-scored pattern drawn from four
    // days is still a four-day observation.
    confidence: cap(score.normalized, coverage.verdict),
    overlapsWith: [],
    // Set by `consolidate`, which is the only stage that can see a sibling.
    foldsInto: null,
    rationaleAgainst: verdict === 'agent' ? null : rationale,

    status: 'proposed',
    proposedAt: now.toISOString(),
  });
}

/**
 * Fold near-duplicate candidates into their strongest sibling.
 *
 * Runs after every candidate has its own verdict, because relatedness is a
 * property of a pair and no single-candidate test can see it. The strongest
 * survives as the agent and the rest become capabilities of it, named rather
 * than deleted — a reviewer who disagrees with a merge needs to see what was
 * merged and on what grounds.
 */
function consolidate(all: AgentProposal[], patterns: WorkPattern[]): AgentProposal[] {
  const byId = new Map(patterns.map((p) => [p.id, p]));
  const survivors: AgentProposal[] = [];
  const out: AgentProposal[] = [];

  // Strongest first, so the survivor of any merge is the better-evidenced one
  // rather than whichever happened to be scored earlier.
  const ordered = [...all].sort((a, b) => b.leverageNormalized - a.leverageNormalized);

  for (const candidate of ordered) {
    if (candidate.verdict !== 'agent') { out.push(candidate); continue; }

    const mine = byId.get(candidate.patternIds[0]!);
    let folded: AgentProposal | null = null;
    let similarity = 0;

    for (const survivor of survivors) {
      const theirs = byId.get(survivor.patternIds[0]!);
      if (!mine || !theirs) continue;
      const sim = relatedness(mine, theirs);
      if (sim >= FOLD_SIMILARITY && sim > similarity) { folded = survivor; similarity = sim; }
    }

    if (!folded) { survivors.push(candidate); out.push(candidate); continue; }

    const shared = mine
      ? mine.capabilities.filter((c) => byId.get(folded!.patternIds[0]!)?.capabilities.includes(c))
      : [];

    out.push(AgentProposal.parse({
      ...candidate,
      verdict: 'capability',
      foldsInto: folded.slug,
      overlapsWith: [folded.slug],
      rationaleAgainst:
        `Shares ${shared.length ? shared.join(', ') : 'its business area'} with ${folded.name} ` +
        `(${Math.round(similarity * 100)}% capability overlap). Two agents holding the same ` +
        `context would split the evidence and disagree with each other; this is a capability of ` +
        `${folded.name}, not a peer.`,
    }));

    // Record the merge on the survivor too, so the fold is visible from either end.
    const i = out.indexOf(folded);
    const withOverlap = AgentProposal.parse({
      ...folded, overlapsWith: [...folded.overlapsWith, candidate.slug],
    });
    if (i >= 0) out[i] = withOverlap;
    survivors[survivors.indexOf(folded)] = withOverlap;
  }

  return out.sort((a, b) => b.leverageNormalized - a.leverageNormalized);
}

/**
 * How much two patterns are the same job.
 *
 * Capability overlap is the measure. A shared business area corroborates an
 * existing overlap but cannot create one on its own — `operations` covers both
 * a production run and a website deploy, and merging those would be worse than
 * fragmenting them.
 */
function relatedness(a: WorkPattern, b: WorkPattern): number {
  const A = new Set(a.capabilities);
  const B = new Set(b.capabilities);
  const intersection = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  const sameArea = a.businessArea !== null && a.businessArea === b.businessArea;

  if (!union) return sameArea ? 0.6 : 0;
  const jaccard = intersection / union;
  return intersection > 0 && sameArea ? Math.min(1, jaccard + 0.25) : jaccard;
}

/**
 * Coverage is a ceiling, not a multiplier.
 *
 * On insufficient data nothing may claim more than low confidence however well
 * it scored, because the score itself was computed over too little.
 */
function cap(normalized: number, verdict: CoverageVerdict): number {
  const ceiling = verdict === 'sufficient' ? 0.9 : verdict === 'provisional' ? 0.55 : 0.3;
  return Math.round(Math.min(normalized, ceiling) * 100) / 100;
}

function pickCounterpart(
  pattern: WorkPattern, participants: string[], ceoName: string, coordinatorName: string,
): string | null {
  const others = pattern.peopleInvolved.filter((p) => p !== ceoName);
  if (others.length === 1) return others[0]!;
  if (participants.includes(coordinatorName)) return coordinatorName;
  if (others.length) return others[0]!;
  // Coordination-shaped work with nobody on it defaults to the coordinator,
  // which is the point of having one.
  return pattern.delegableCount > 0 ? coordinatorName : null;
}

function missionFor(pattern: WorkPattern, sink: { moveable: number } | undefined): string {
  const base = `Carry the recurring ${pattern.label} work end to end`;
  if (sink && sink.moveable > 0) {
    return `${base}, removing the ${sink.moveable} coordination touch${sink.moveable === 1 ? '' : 'es'} ` +
      `that currently reach the CEO without needing his judgment.`;
  }
  return `${base}, keeping it moving without adding to anyone's queue.`;
}

function evidenceFor(
  pattern: WorkPattern, sink: { touches: number; irreducible: number; moveable: number } | undefined,
  score: LeverageScore,
): string[] {
  const out = [
    `${pattern.frequency} instances observed, median cycle ${pattern.medianCycleDays} business days.`,
    `${pattern.averageParticipants} internal participant${pattern.averageParticipants === 1 ? '' : 's'} on average` +
      (pattern.externalParties.length ? `, with ${pattern.externalParties.join(', ')} involved.` : '.'),
  ];
  if (sink) {
    out.push(`CEO involved in ${sink.touches} instance${sink.touches === 1 ? '' : 's'}: ` +
      `${sink.irreducible} genuinely his to decide, ${sink.moveable} coordination.`);
  }
  if (pattern.totalValueAtStake > 0) {
    out.push(`$${Math.round(pattern.totalValueAtStake).toLocaleString()} at stake across the pattern.`);
  }
  if (score.uncomputed.length) {
    out.push(`Could not be scored on: ${score.uncomputed.join(', ')} — the record does not carry it yet.`);
  }
  out.push(...pattern.instances.slice(0, 3).map((i) => `Example: ${i.title}`));
  return out;
}

function jobsFor(pattern: WorkPattern): string[] {
  const jobs = [
    `Track the state of every open ${pattern.label} item`,
    'Identify what is missing or blocking, and who holds it',
  ];
  if (pattern.externalParties.length) {
    jobs.push(`Prepare follow-ups to ${pattern.externalParties.join(', ')} for a human to send`);
  }
  if (pattern.ceoTouchCount > 0) {
    jobs.push('Assemble the evidence a decision needs before it reaches the CEO');
  }
  return jobs;
}

function dataFor(pattern: WorkPattern): string[] {
  const data = ['Command Center ledger', 'Normalized events'];
  if (pattern.externalParties.length) data.push('Outlook threads with the counterparty');
  if (pattern.totalValueAtStake > 0) data.push('Financial signals');
  return data;
}

function permissionsFor(pattern: WorkPattern): string[] {
  const perms = ['READ_LEDGER', 'READ_OUTLOOK', 'CREATE_TASK', 'UPDATE_TASK'];
  if (pattern.externalParties.length) perms.push('CREATE_OUTLOOK_DRAFT');
  if (pattern.totalValueAtStake > 0) perms.push('READ_FINANCIAL_SIGNALS');
  return perms;
}

/**
 * The most restrictive class any instance carried.
 *
 * One RED instance makes the whole pattern RED. Averaging would let a stream of
 * routine work licence an agent to touch the one item that mattered.
 */
function worstApprovalClass(pattern: WorkPattern): 'GREEN' | 'YELLOW' | 'RED' {
  if (pattern.instances.some((i) => i.approvalClass === 'RED')) return 'RED';
  if (pattern.instances.some((i) => i.approvalClass === 'YELLOW')) return 'YELLOW';
  return 'GREEN';
}

function metricsFor(pattern: WorkPattern): string[] {
  const m = [
    'Median cycle time, against the current baseline',
    'CEO touches per instance',
    'Recommendation acceptance rate',
  ];
  if (pattern.externalParties.length) m.push('Follow-ups required per commitment');
  return m;
}

function guidance(verdict: CoverageVerdict, agents: number, others: number): string {
  if (verdict === 'insufficient') {
    return `Read this as a demonstration that the pipeline works, not as an architecture. ` +
      `${agents} candidate${agents === 1 ? '' : 's'} cleared the agent bar and ${others} did not, ` +
      `but on this much data those verdicts would move if a single week were added. The next ` +
      `useful step is backfill, not approval.`;
  }
  if (verdict === 'provisional') {
    return `Treat the ranking as a hypothesis. The shape is probably right and the order is not ` +
      `yet stable; approve the top one or two and let the rest accumulate more evidence.`;
  }
  return `Coverage supports these conclusions. Approve, reject or defer each proposal on its own ` +
    `evidence, and revisit the architecture once the approved agents have measured performance.`;
}

function dim(score: LeverageScore, name: string): number {
  return score.dimensions.find((d) => d.name === name)?.raw ?? 0;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'unnamed';
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
