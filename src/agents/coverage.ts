/**
 * What history exists, and whether it can bear a conclusion.
 *
 * This module runs before the Agent Architect reasons about anything, and it
 * exists because of a failure mode this codebase has already been burned by
 * twice. The unclosed-books rule refuses a profit figure from a month whose
 * expenses are half-entered. The traffic module refuses a conversion finding
 * below three standard errors. Both exist because a confident number drawn
 * from data that cannot support it is worse than silence — it gets acted on.
 *
 * An agent architecture derived from four days of email is the same mistake in
 * a more expensive costume. It would name plausible agents, attach plausible
 * reasoning, and be indistinguishable in tone from one derived from a year.
 *
 * So coverage is computed first, it is computed in code rather than described
 * by a model, and the verdict it produces is allowed to demote the entire
 * report to a method demonstration.
 */
import type { Ledger } from '../ledger/types.js';
import type { CanonicalEvent } from '../schemas/events.js';

/**
 * How much weight the resulting architecture may be given.
 *
 * Deliberately three states rather than a percentage: a reader acts on a word,
 * not on a coverage score, and "62% covered" invites the reader to round up.
 */
export type CoverageVerdict = 'sufficient' | 'provisional' | 'insufficient';

/** Below this many distinct days of activity, nothing is a pattern. */
export const MIN_DAYS_SUFFICIENT = 120;
export const MIN_DAYS_PROVISIONAL = 30;

/** A cluster needs this many instances before it is a recurrence rather than a coincidence. */
export const MIN_INSTANCES_PER_PATTERN = 3;

/** Below this many work items in total, clustering describes noise. */
export const MIN_WORK_ITEMS_SUFFICIENT = 200;
export const MIN_WORK_ITEMS_PROVISIONAL = 50;

export interface SourceCoverage {
  source: string;
  events: number;
  /** Distinct calendar days on which this source produced anything. */
  activeDays: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source is represented but plainly not continuous. */
  sparse: boolean;
}

export interface CoverageReport {
  verdict: CoverageVerdict;
  /** Plain sentence for the top of the architecture report. */
  statement: string;

  windowStart: string | null;
  windowEnd: string | null;
  spanDays: number;
  activeDays: number;

  syncCount: number;
  workItems: number;
  commitments: number;
  events: number;
  meetings: number;

  bySource: SourceCoverage[];
  /** Named, specific, and ordered by how much they distort the conclusion. */
  gaps: string[];
  /** Reasons a pattern drawn from this data might be an artefact. */
  biases: string[];
}

export interface CoverageInput {
  ledger: Ledger;
  events?: CanonicalEvent[];
  meetings?: number;
  /** Sources the system is expected to have, so absence is reportable. */
  expectedSources?: string[];
}

const DAY_MS = 86_400_000;

/**
 * Sources a complete picture of this company would include. Listing them makes
 * an ABSENT source reportable — a coverage report that only describes what it
 * found can never tell you what it is blind to.
 */
export const EXPECTED_SOURCES = [
  'outlook', 'outlook_sent', 'slack', 'zoom', 'manual', 'signal',
];

export function assessCoverage(input: CoverageInput): CoverageReport {
  const { ledger } = input;
  const events = input.events ?? [];
  const expected = input.expectedSources ?? EXPECTED_SOURCES;

  const days = new Set<string>();
  const stamps: number[] = [];

  const note = (iso: string | null | undefined) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return;
    days.add(iso.slice(0, 10));
    stamps.push(t);
  };

  for (const entry of ledger.entries) {
    note(entry.lastActivityAt);
    note(entry.firstSeenAt);
  }
  for (const e of events) note(e.occurredAt);

  const bySource = summarizeSources(events, expected);
  const workItems = ledger.entries.length;

  const windowStart = stamps.length ? new Date(Math.min(...stamps)).toISOString() : null;
  const windowEnd = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
  const spanDays = stamps.length
    ? Math.max(1, Math.round((Math.max(...stamps) - Math.min(...stamps)) / DAY_MS))
    : 0;

  const verdict = judge(spanDays, workItems, ledger.syncCount);

  return {
    verdict,
    statement: describe(verdict, spanDays, workItems, ledger.syncCount),
    windowStart,
    windowEnd,
    spanDays,
    activeDays: days.size,
    syncCount: ledger.syncCount,
    workItems,
    commitments: ledger.commitments.length,
    events: events.length,
    meetings: input.meetings ?? 0,
    bySource,
    gaps: findGaps(bySource, expected, ledger),
    biases: findBiases(spanDays, days.size, ledger, bySource),
  };
}

/**
 * The verdict takes the WORST of its inputs rather than an average.
 *
 * A year of history containing eleven tasks is not two-thirds of an answer, and
 * neither is two hundred tasks gathered in a single week. Averaging would let a
 * strong dimension launder a fatal one, which is exactly how a thin dataset
 * ends up wearing a confident label.
 */
function judge(spanDays: number, workItems: number, syncCount: number): CoverageVerdict {
  const bySpan: CoverageVerdict =
    spanDays >= MIN_DAYS_SUFFICIENT ? 'sufficient'
      : spanDays >= MIN_DAYS_PROVISIONAL ? 'provisional' : 'insufficient';

  const byVolume: CoverageVerdict =
    workItems >= MIN_WORK_ITEMS_SUFFICIENT ? 'sufficient'
      : workItems >= MIN_WORK_ITEMS_PROVISIONAL ? 'provisional' : 'insufficient';

  // One sync cannot show anything changing over time, and change is most of
  // what a bottleneck is.
  const byRuns: CoverageVerdict = syncCount >= 20 ? 'sufficient'
    : syncCount >= 5 ? 'provisional' : 'insufficient';

  const rank = { insufficient: 0, provisional: 1, sufficient: 2 } as const;
  const worst = [bySpan, byVolume, byRuns].reduce((a, b) => (rank[a] <= rank[b] ? a : b));
  return worst;
}

function describe(v: CoverageVerdict, spanDays: number, workItems: number, syncCount: number): string {
  const facts = `${spanDays} day${spanDays === 1 ? '' : 's'} of activity, ` +
    `${workItems} work item${workItems === 1 ? '' : 's'}, ${syncCount} sync${syncCount === 1 ? '' : 's'}`;

  if (v === 'sufficient') {
    return `Coverage is sufficient: ${facts}. Recurrence claims below rest on real repetition.`;
  }
  if (v === 'provisional') {
    return `Coverage is provisional: ${facts}. Patterns here are plausible but under-sampled — ` +
      `treat the ranking as a hypothesis, not a finding.`;
  }
  return `Coverage is insufficient: ${facts}. What follows demonstrates the method and must not ` +
    `be read as a recommendation — nothing repeats often enough here to establish a pattern.`;
}

function summarizeSources(events: CanonicalEvent[], expected: string[]): SourceCoverage[] {
  const acc = new Map<string, { days: Set<string>; count: number; first: number; last: number }>();

  for (const e of events) {
    const t = Date.parse(e.occurredAt);
    if (Number.isNaN(t)) continue;
    const key = e.sourceSystem;
    if (!acc.has(key)) acc.set(key, { days: new Set(), count: 0, first: t, last: t });
    const a = acc.get(key)!;
    a.days.add(e.occurredAt.slice(0, 10));
    a.count++;
    a.first = Math.min(a.first, t);
    a.last = Math.max(a.last, t);
  }

  const out: SourceCoverage[] = [];
  for (const source of new Set([...expected, ...acc.keys()])) {
    const a = acc.get(source);
    out.push({
      source,
      events: a?.count ?? 0,
      activeDays: a?.days.size ?? 0,
      firstSeen: a ? new Date(a.first).toISOString() : null,
      lastSeen: a ? new Date(a.last).toISOString() : null,
      // Present but thin: a handful of events across one or two days says the
      // source is reachable, not that it has been observed.
      sparse: Boolean(a) && (a!.count < 10 || a!.days.size < 3),
    });
  }
  return out.sort((x, y) => y.events - x.events);
}

function findGaps(bySource: SourceCoverage[], expected: string[], ledger: Ledger): string[] {
  const gaps: string[] = [];

  for (const source of expected) {
    const s = bySource.find((x) => x.source === source);
    if (!s || s.events === 0) {
      gaps.push(`${source}: no events captured at all.`);
    } else if (s.sparse) {
      gaps.push(`${source}: ${s.events} events across ${s.activeDays} day${s.activeDays === 1 ? '' : 's'} — reachable, not continuously observed.`);
    }
  }

  // Sent mail deserves its own line: the commitment extractor is built to read
  // promises WE made and cannot see them without this folder.
  const sent = bySource.find((x) => x.source === 'outlook_sent');
  if (!sent || sent.events === 0) {
    gaps.push('Promises we made are invisible: sent mail is not captured, so every commitment ' +
      'found so far is one somebody made TO us.');
  }

  if (!ledger.entries.some((e) => e.status === 'completed')) {
    gaps.push('No work item has completed yet, so cycle time and completion rate cannot be measured.');
  }
  if (!ledger.entries.some((e) => e.status === 'dormant')) {
    gaps.push('Nothing has gone dormant yet, so the stall rate is unmeasured.');
  }

  return gaps;
}

function findBiases(spanDays: number, activeDays: number, ledger: Ledger, bySource: SourceCoverage[]): string[] {
  const biases: string[] = [];

  if (spanDays > 0 && spanDays < 35) {
    biases.push(`The window is ${spanDays} days, so anything seasonal, monthly or quarterly is ` +
      `either invisible or counted exactly once and mistaken for routine.`);
  }
  if (spanDays >= 7 && activeDays / spanDays < 0.5) {
    biases.push(`Activity appears on ${activeDays} of ${spanDays} days — the record is bursty, ` +
      `so frequency counts overstate anything that happened during a burst.`);
  }

  const dominant = bySource.filter((s) => s.events > 0).sort((a, b) => b.events - a.events)[0];
  const total = bySource.reduce((n, s) => n + s.events, 0);
  if (dominant && total > 0 && dominant.events / total > 0.8) {
    biases.push(`${Math.round((dominant.events / total) * 100)}% of evidence comes from ` +
      `${dominant.source} alone, so work that happens elsewhere is systematically under-weighted.`);
  }

  if (ledger.syncCount <= 2) {
    biases.push('With this few syncs, "carried forward" and "gone quiet" reflect the sync schedule ' +
      'more than they reflect how the company actually works.');
  }

  return biases;
}

/**
 * Whether a candidate pattern has enough instances to be called recurring.
 *
 * Used by the clustering step rather than the report, so a thin cluster is
 * excluded at source instead of being presented and caveated.
 */
export function isRecurring(instanceCount: number): boolean {
  return instanceCount >= MIN_INSTANCES_PER_PATTERN;
}
