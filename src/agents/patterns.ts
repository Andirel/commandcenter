/**
 * Recurring work, extracted from what the company actually did.
 *
 * The brief is emphatic that the agent list must not be decided in advance, and
 * this module is where that promise is kept or broken. It turns ledger entries
 * into work instances, groups them by what they have in common, and refuses to
 * call anything a pattern until it has repeated.
 *
 * Grouping runs on FACTS the pipeline already established — business area,
 * required capabilities, counterparty, the set of people involved — rather than
 * on the wording of a title. Titles are written by whoever sent the email, and
 * clustering on them produces categories that describe the sender's vocabulary
 * instead of the company's work.
 *
 * Naming a cluster is left to the model. Counting one is not.
 */
import type { Ledger, LedgerEntry } from '../ledger/types.js';
import { businessDaysBetween } from '../followup/engine.js';
import { tokenSimilarity } from '../deduplication/similarity.js';
import { isRecurring } from './coverage.js';

export interface WorkInstance {
  key: string;
  title: string;
  businessArea: string | null;
  capabilities: string[];
  /** Every internal person the work touched, in a stable order. */
  people: string[];
  externalParty: string | null;
  ceoRequired: boolean;
  ceoActionMode: string | null;
  delegable: boolean;
  approvalClass: string;
  valueAtStake: number | null;
  status: string;
  firstSeenAt: string;
  lastActivityAt: string;
  /** Business days from first sighting to completion, or to now if still open. */
  cycleDays: number;
  /** How many syncs saw it. A high count with no movement is a stall. */
  seenCount: number;
  completed: boolean;
}

export interface WorkPattern {
  /** Stable slug derived from the grouping facts, not from a model. */
  id: string;
  /** Set by the model later; deterministic fallback until then. */
  label: string;
  businessArea: string | null;
  capabilities: string[];
  instances: WorkInstance[];

  // --- everything below is arithmetic, never inference ---------------------
  frequency: number;
  medianCycleDays: number;
  ceoTouchCount: number;
  ceoTouchRate: number;
  delegableCount: number;
  externalParties: string[];
  peopleInvolved: string[];
  /** Mean distinct internal people per instance — the coordination tax. */
  averageParticipants: number;
  totalValueAtStake: number;
  completionRate: number;
  /** True once the pattern has repeated enough to be more than coincidence. */
  recurring: boolean;

  /** Earliest and latest sighting, so a burst can be told from a routine. */
  firstAt: string;
  lastAt: string;
  /**
   * Calendar days from first instance to last.
   *
   * Frequency alone cannot distinguish "eight times a month, every month" from
   * "eight times during one bad fortnight and never again". The second is a
   * project that happened, not a pattern worth an agent, and only the span
   * separates them.
   */
  spanDays: number;
}

/** Ledger entries as flat work instances. */
export function toWorkInstances(ledger: Ledger, now: Date): WorkInstance[] {
  return ledger.entries.map((entry) => instanceOf(entry, now));
}

function instanceOf(entry: LedgerEntry, now: Date): WorkInstance {
  const s = entry.state;
  const completed = entry.status === 'completed';
  const end = completed && entry.completion ? new Date(entry.completion.at) : now;

  const people = [s.primaryOwner, s.projectManager, s.decisionMaker, ...s.collaborators]
    .filter((x): x is string => Boolean(x));

  return {
    key: entry.key,
    title: s.title,
    businessArea: s.businessArea,
    capabilities: [...s.requiredCapabilities].sort(),
    people: [...new Set(people)].sort(),
    externalParty: s.externalParty,
    ceoRequired: s.ceoRequired,
    ceoActionMode: s.ceoActionMode,
    delegable: s.delegable,
    approvalClass: s.approvalClass,
    valueAtStake: s.valueAtStake,
    status: entry.status,
    firstSeenAt: entry.firstSeenAt,
    lastActivityAt: entry.lastActivityAt,
    cycleDays: businessDaysBetween(new Date(entry.firstSeenAt), end),
    seenCount: entry.seenCount,
    completed,
  };
}

/**
 * Group work by what it is, not by what it was called.
 *
 * The grouping key is capability set + business area, because those are the two
 * facts the routing engine already had to establish in order to assign an
 * owner. Instances with neither fall back to a title-similarity pass, which is
 * weaker and marked as such — it is a last resort, not the method.
 */
export function clusterWork(instances: WorkInstance[]): WorkPattern[] {
  const groups = new Map<string, WorkInstance[]>();
  const unkeyed: WorkInstance[] = [];

  for (const w of instances) {
    const key = groupKey(w);
    if (!key) { unkeyed.push(w); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(w);
  }

  for (const [key, group] of titleFallback(unkeyed)) groups.set(key, group);

  return [...groups.entries()]
    .map(([id, group]) => summarize(id, group))
    .sort((a, b) => b.frequency - a.frequency || b.ceoTouchCount - a.ceoTouchCount);
}

function groupKey(w: WorkInstance): string | null {
  if (w.capabilities.length) return `cap:${w.capabilities.join('+')}`;
  if (w.businessArea) return `area:${w.businessArea}`;
  return null;
}

/**
 * Last resort for work the pipeline never managed to characterise.
 *
 * Single-link grouping on title similarity: cheap, and honest about being weak.
 * The threshold is high on purpose — a loose one here would sweep unrelated
 * work into a group and then report it as a recurring pattern, which is the
 * most expensive mistake this module can make.
 */
const TITLE_GROUP_THRESHOLD = 0.55;

function titleFallback(items: WorkInstance[]): Array<[string, WorkInstance[]]> {
  const groups: WorkInstance[][] = [];
  for (const item of items) {
    const hit = groups.find((g) => g.some((x) => tokenSimilarity(x.title, item.title) >= TITLE_GROUP_THRESHOLD));
    if (hit) hit.push(item); else groups.push([item]);
  }
  return groups.map((g, i) => [`title:${slug(g[0]!.title)}:${i}`, g]);
}

const DAY_MS = 86_400_000;

function summarize(id: string, group: WorkInstance[]): WorkPattern {
  const cycles = group.map((w) => w.cycleDays).sort((a, b) => a - b);
  const ceoTouches = group.filter((w) => w.ceoRequired).length;
  const completedCount = group.filter((w) => w.completed).length;

  const capabilities = [...new Set(group.flatMap((w) => w.capabilities))].sort();
  const people = [...new Set(group.flatMap((w) => w.people))].sort();
  const externals = [...new Set(group.map((w) => w.externalParty).filter((x): x is string => Boolean(x)))].sort();

  const areas = group.map((w) => w.businessArea).filter((x): x is string => Boolean(x));

  const stamps = group.map((w) => Date.parse(w.firstSeenAt)).filter((t) => !Number.isNaN(t));
  const first = stamps.length ? Math.min(...stamps) : Date.parse(group[0]!.firstSeenAt);
  const last = stamps.length ? Math.max(...stamps) : first;

  return {
    id,
    label: fallbackLabel(capabilities, areas[0] ?? null, group),
    businessArea: areas[0] ?? null,
    capabilities,
    instances: group,
    frequency: group.length,
    medianCycleDays: median(cycles),
    ceoTouchCount: ceoTouches,
    ceoTouchRate: round(ceoTouches / group.length),
    delegableCount: group.filter((w) => w.delegable).length,
    externalParties: externals,
    peopleInvolved: people,
    averageParticipants: round(group.reduce((n, w) => n + w.people.length, 0) / group.length),
    totalValueAtStake: group.reduce((n, w) => n + (w.valueAtStake ?? 0), 0),
    completionRate: round(completedCount / group.length),
    recurring: isRecurring(group.length),
    firstAt: new Date(first).toISOString(),
    lastAt: new Date(last).toISOString(),
    spanDays: Math.max(0, Math.round((last - first) / DAY_MS)),
  };
}

/**
 * A readable name without a model call.
 *
 * The Architect replaces this with something better, but a deterministic label
 * means the pipeline is inspectable and testable on its own — and if the model
 * stage is skipped or fails, the report degrades to plain language rather than
 * to an opaque key.
 */
function fallbackLabel(capabilities: string[], area: string | null, group: WorkInstance[]): string {
  if (capabilities.length) return capabilities.join(' + ').replace(/_/g, ' ');
  if (area) return area.replace(/_/g, ' ');
  return group[0]?.title.slice(0, 48) ?? 'unclassified';
}

/** Patterns that repeated. The rest are kept for the coverage story, not for design. */
export function recurringOnly(patterns: WorkPattern[]): WorkPattern[] {
  return patterns.filter((p) => p.recurring);
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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
