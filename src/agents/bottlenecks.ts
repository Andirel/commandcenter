/**
 * Where work repeatedly slows down, and on whom.
 *
 * A bottleneck is not "something took a long time" — plenty of work is
 * legitimately slow. It is work that stopped moving while somebody was
 * expected to move it, and the distinction is what makes the output
 * actionable: the first is a schedule, the second is a name and a reason.
 *
 * Everything here is arithmetic over the ledger and the commitment record.
 * No model is consulted, because a model asked "where are the bottlenecks?"
 * will always find some.
 */
import type { Ledger } from '../ledger/types.js';
import { businessDaysBetween } from '../followup/engine.js';
import type { WorkPattern } from './patterns.js';

/** Business days of silence before an open item counts as stalled. */
export const STALL_DAYS = 5;

/** A counterparty chased this many times is a pattern, not an incident. */
export const CHASE_THRESHOLD = 2;

export type BottleneckKind =
  | 'stalled_work'        // open, quiet, nobody moving it
  | 'repeat_chasing'      // the same counterparty needing repeated nudges
  | 'unanswered_promise'  // they said they would, and did not
  | 'coordination_load'   // too many people for the size of the work
  | 'single_point';       // one person is the only route through

export interface Bottleneck {
  kind: BottleneckKind;
  subject: string;
  summary: string;
  /** Verbatim, so a wrong call can be traced back to what it read. */
  evidence: string[];
  instances: number;
  /** Days lost, measured where measurable. Null when it cannot be. */
  daysLost: number | null;
  severity: number;
  /** Who is positioned to unblock it, where the record names anyone. */
  waitingOn: string | null;
}

export interface BottleneckAnalysis {
  bottlenecks: Bottleneck[];
  stalledCount: number;
  medianStallDays: number;
  totalFollowUps: number;
}

export interface BottleneckOptions {
  now?: Date;
  ceoName?: string;
}

export function analyzeBottlenecks(
  ledger: Ledger,
  patterns: WorkPattern[],
  opts: BottleneckOptions = {},
): BottleneckAnalysis {
  const now = opts.now ?? new Date();
  const ceo = opts.ceoName ?? 'Adi';
  const out: Bottleneck[] = [];

  const stalls = findStalls(ledger, now, ceo);
  out.push(...stalls.bottlenecks);
  out.push(...findChasing(ledger));
  out.push(...findUnansweredPromises(ledger, now));
  out.push(...findCoordinationLoad(patterns));
  out.push(...findSinglePoints(patterns, ceo));

  out.sort((a, b) => b.severity - a.severity || b.instances - a.instances);

  return {
    bottlenecks: out,
    stalledCount: stalls.count,
    medianStallDays: stalls.medianDays,
    totalFollowUps: ledger.commitments.reduce((n, c) => n + c.commitment.followUpCount, 0),
  };
}

/**
 * Open work nobody has touched.
 *
 * Grouped by who it is waiting on rather than listed item by item: five stalled
 * items all waiting on the same person is one problem with five symptoms, and
 * reporting it five times buries the fact that they share a cause.
 */
function findStalls(ledger: Ledger, now: Date, ceo: string) {
  const byOwner = new Map<string, Array<{ title: string; days: number }>>();
  const allDays: number[] = [];

  for (const e of ledger.entries) {
    if (e.status !== 'open' && e.status !== 'dormant') continue;
    const days = businessDaysBetween(new Date(e.lastActivityAt), now);
    if (days < STALL_DAYS) continue;

    allDays.push(days);
    const owner = e.state.primaryOwner ?? e.state.decisionMaker ?? '(unassigned)';
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner)!.push({ title: e.state.title, days });
  }

  const bottlenecks: Bottleneck[] = [];
  for (const [owner, items] of byOwner) {
    const worst = Math.max(...items.map((i) => i.days));
    const total = items.reduce((n, i) => n + i.days, 0);
    bottlenecks.push({
      kind: 'stalled_work',
      subject: owner,
      summary: `${items.length} open item${items.length === 1 ? '' : 's'} waiting on ${owner}, ` +
        `the oldest for ${worst} business days.`,
      evidence: items.sort((a, b) => b.days - a.days).slice(0, 4)
        .map((i) => `${i.days}d — ${i.title}`),
      instances: items.length,
      daysLost: total,
      // Work stuck behind one person blocks everyone downstream, and stuck
      // behind the CEO blocks the most.
      severity: Math.min(9, 3 + Math.floor(worst / STALL_DAYS) + (owner === ceo ? 2 : 0)),
      waitingOn: owner === '(unassigned)' ? null : owner,
    });
  }

  return {
    bottlenecks,
    count: allDays.length,
    medianDays: median(allDays.sort((a, b) => a - b)),
  };
}

/** Counterparties that need repeated nudging to do what they said. */
function findChasing(ledger: Ledger): Bottleneck[] {
  const byParty = new Map<string, { chases: number; items: string[] }>();

  for (const c of ledger.commitments) {
    if (c.commitment.followUpCount < CHASE_THRESHOLD) continue;
    const party = c.counterpartyName ?? c.owedByName ?? '(unnamed)';
    if (!byParty.has(party)) byParty.set(party, { chases: 0, items: [] });
    const a = byParty.get(party)!;
    a.chases += c.commitment.followUpCount;
    a.items.push(`${c.commitment.followUpCount}× — ${c.commitment.description}`);
  }

  return [...byParty.entries()].map(([party, a]) => ({
    kind: 'repeat_chasing' as const,
    subject: party,
    summary: `${party} has needed ${a.chases} follow-up${a.chases === 1 ? '' : 's'} across ` +
      `${a.items.length} commitment${a.items.length === 1 ? '' : 's'}.`,
    evidence: a.items.slice(0, 4),
    instances: a.items.length,
    daysLost: null,
    severity: Math.min(8, 4 + a.items.length),
    waitingOn: party,
  }));
}

/**
 * Promises made to us that are still outstanding.
 *
 * Counted separately from chasing because an unchased promise is the worse
 * case: nobody has even noticed it is late.
 */
function findUnansweredPromises(ledger: Ledger, now: Date): Bottleneck[] {
  const open = ledger.commitments.filter(
    (c) => c.status === 'open' && c.commitment.direction === 'they_owe',
  );
  if (!open.length) return [];

  const aged = open.map((c) => ({
    party: c.counterpartyName ?? c.owedByName ?? '(unnamed)',
    text: c.commitment.description,
    quote: c.quote,
    days: businessDaysBetween(new Date(c.commitment.dueDate ?? c.firstSeenAt), now),
    chased: c.commitment.followUpCount,
  })).filter((x) => x.days >= STALL_DAYS);

  if (!aged.length) return [];

  const unchased = aged.filter((x) => x.chased === 0);
  const worst = Math.max(...aged.map((x) => x.days));

  return [{
    kind: 'unanswered_promise',
    subject: 'outstanding commitments',
    summary: `${aged.length} promise${aged.length === 1 ? '' : 's'} made to us ${aged.length === 1 ? 'is' : 'are'} ` +
      `still outstanding, the oldest by ${worst} business days` +
      (unchased.length ? `; ${unchased.length} ${unchased.length === 1 ? 'has' : 'have'} never been chased.` : '.'),
    evidence: aged.sort((a, b) => b.days - a.days).slice(0, 4)
      .map((x) => `${x.days}d — ${x.party}: ${x.quote ? `"${x.quote}"` : x.text}`),
    instances: aged.length,
    daysLost: aged.reduce((n, x) => n + x.days, 0),
    severity: Math.min(9, 4 + unchased.length + Math.floor(worst / 10)),
    waitingOn: null,
  }];
}

/**
 * Work that routinely needs more people than its size warrants.
 *
 * Every extra participant is a handoff, and handoffs are where things wait.
 */
function findCoordinationLoad(patterns: WorkPattern[]): Bottleneck[] {
  return patterns
    .filter((p) => p.recurring && p.averageParticipants >= 3)
    .map((p) => ({
      kind: 'coordination_load' as const,
      subject: p.label,
      summary: `${p.label} pulls in ${p.averageParticipants} people on average across ` +
        `${p.frequency} instances, taking a median ${p.medianCycleDays} business days.`,
      evidence: p.instances.slice(0, 3).map((w) => `${w.people.join(', ')} — ${w.title}`),
      instances: p.frequency,
      daysLost: null,
      severity: Math.min(8, 3 + Math.floor(p.averageParticipants)),
      waitingOn: null,
    }));
}

/**
 * Patterns with exactly one internal person across every instance.
 *
 * Not a complaint about workload — it is a continuity risk. If that person is
 * away, the pattern stops entirely.
 */
function findSinglePoints(patterns: WorkPattern[], ceo: string): Bottleneck[] {
  // Grouped by person for the same reason stalls are: one person who is the
  // sole route through four patterns is one continuity risk, not four. Listing
  // it four times buries the fact that they share a cause — and the cause is
  // the finding.
  const byPerson = new Map<string, WorkPattern[]>();

  for (const p of patterns) {
    if (!p.recurring) continue;
    const others = p.peopleInvolved.filter((x) => x !== ceo);
    if (others.length !== 1) continue;
    const person = others[0]!;
    if (!byPerson.has(person)) byPerson.set(person, []);
    byPerson.get(person)!.push(p);
  }

  return [...byPerson.entries()].map(([person, ps]) => {
    const instances = ps.reduce((n, p) => n + p.frequency, 0);
    return {
      kind: 'single_point' as const,
      subject: person,
      summary: ps.length === 1
        ? `${person} is the only person on all ${ps[0]!.frequency} instances of ${ps[0]!.label}.`
        : `${person} is the only person on ${ps.length} recurring patterns ` +
          `(${instances} instances): ${ps.map((p) => p.label).join('; ')}.`,
      evidence: ps.map((p) => `${p.frequency}× — ${p.label}`),
      instances,
      daysLost: null,
      // Breadth is the risk, not volume: being alone on four different kinds of
      // work is worse than being alone on one that happens often.
      severity: Math.min(8, 3 + Math.floor(instances / 8) + (ps.length - 1)),
      waitingOn: person,
    };
  });
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
