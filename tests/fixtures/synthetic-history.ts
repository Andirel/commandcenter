/**
 * A synthetic year, because four days cannot test a pattern detector.
 *
 * The real ledger holds a handful of days of activity. That is enough to prove
 * the pipeline runs and nowhere near enough to prove it *concludes* correctly:
 * every cluster is thin, every verdict is `not_worth_it`, and the interesting
 * behaviour — folding siblings, refusing an episode, keeping a supplier
 * external — never fires. So the architecture tests run against a constructed
 * history whose right answers are known by construction.
 *
 * This is a fixture, not a simulation. It does not try to look like a year of
 * 120/Life; it encodes one situation per behaviour under test, at the smallest
 * size that makes the behaviour observable. Where a test asserts a verdict, the
 * shape that should produce it is visible here in a few lines.
 *
 * The people, capabilities and external organisations are the real ones from
 * `config/*.yaml`, so a config change that renames a capability breaks these
 * tests — which is correct, since it would also change the architecture.
 */
import { Ledger, LedgerCommitment, LedgerEntry } from '../../src/ledger/types.js';

/** Day zero of the synthetic record. Everything is expressed as an offset. */
export const HISTORY_START = new Date('2025-09-01T09:00:00.000Z');

/** Long enough that a monthly pattern repeats and a burst is distinguishable. */
export const HISTORY_DAYS = 300;

const DAY_MS = 86_400_000;

export function at(dayOffset: number, hour = 9): string {
  return new Date(HISTORY_START.getTime() + dayOffset * DAY_MS + hour * 3_600_000).toISOString();
}

export interface WorkSpec {
  title: string;
  businessArea?: string | null;
  capabilities?: string[];
  primaryOwner?: string | null;
  projectManager?: string | null;
  decisionMaker?: string | null;
  collaborators?: string[];
  externalParty?: string | null;
  ceoRequired?: boolean;
  ceoActionMode?: string | null;
  delegable?: boolean;
  approvalClass?: 'GREEN' | 'YELLOW' | 'RED';
  valueAtStake?: number | null;
  /** Days after `HISTORY_START` the work first appeared. */
  startDay: number;
  /** Calendar days it took. Completed work ends here; open work is still running. */
  durationDays?: number;
  completed?: boolean;
  seenCount?: number;
}

let counter = 0;

export function entry(spec: WorkSpec): LedgerEntry {
  const id = `syn-${++counter}`;
  const duration = spec.durationDays ?? 4;
  const firstSeenAt = at(spec.startDay);
  const lastActivityAt = at(spec.startDay + duration);
  const completed = spec.completed ?? true;

  const state = {
    id,
    title: spec.title,
    summary: null,
    source: 'Outlook' as const,
    sourceRef: `syn:${id}`,
    link: null,
    occurredAt: lastActivityAt,
    businessArea: spec.businessArea ?? null,
    requiredCapabilities: spec.capabilities ?? [],
    primaryOwner: spec.primaryOwner ?? null,
    projectManager: spec.projectManager ?? null,
    decisionMaker: spec.decisionMaker ?? null,
    externalParty: spec.externalParty ?? null,
    collaborators: spec.collaborators ?? [],
    ceoRequired: spec.ceoRequired ?? false,
    ceoActionMode: spec.ceoActionMode ?? null,
    leverageClass: null,
    approvalClass: spec.approvalClass ?? 'YELLOW',
    delegable: spec.delegable ?? true,
    deadline: null,
    valueAtStake: spec.valueAtStake ?? null,
    score: 0,
    rank: null,
    drivers: [],
    routingReason: 'synthetic fixture',
    attributedTo: null,
    attributionOverridden: false,
    confidence: 0.8,
    needsReview: false,
    possibleDuplicateOf: null,
    duplicateSimilarity: null,
    interpreted: true,
    status: 'open' as const,
    ageDays: null,
    daysSilent: null,
  };

  return LedgerEntryOf({
    key: `syn:${id}`,
    task: {
      id,
      title: spec.title,
      businessArea: spec.businessArea ?? null,
      ceoRequired: spec.ceoRequired ?? false,
      ceoActionMode: spec.ceoActionMode ?? null,
      delegable: spec.delegable ?? true,
      approvalClass: spec.approvalClass ?? 'YELLOW',
      createdAt: firstSeenAt,
      lastActivityAt,
      completedAt: completed ? lastActivityAt : null,
    },
    state,
    firstSeenAt,
    lastSeenAt: lastActivityAt,
    lastActivityAt,
    seenCount: spec.seenCount ?? Math.max(1, Math.round(duration / 2)),
    status: completed ? 'completed' : 'open',
    statusChangedAt: lastActivityAt,
    completion: completed
      ? {
        at: lastActivityAt,
        confidence: 0.85,
        evidence: 'Synthetic fixture: closed by construction.',
        label: 'completed',
        source: 'detected' as const,
        sourceRef: `syn:${id}`,
      }
      : null,
  });
}

function LedgerEntryOf(raw: unknown): LedgerEntry {
  return LedgerEntry.parse(raw);
}

/** Repeat a shape on a cadence, so a recurrence is a recurrence and not a copy. */
export function recurring(
  spec: Omit<WorkSpec, 'startDay'>,
  opts: { firstDay: number; everyDays: number; times: number; titles?: string[] },
): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (let i = 0; i < opts.times; i++) {
    out.push(entry({
      ...spec,
      title: opts.titles?.[i] ?? `${spec.title} #${i + 1}`,
      startDay: opts.firstDay + i * opts.everyDays,
    }));
  }
  return out;
}

/**
 * The situations under test, one block per behaviour.
 *
 * Read this as the answer key: each block's comment states what the Architect
 * is supposed to conclude about it, and the tests assert exactly that.
 */
export function syntheticLedger(): Ledger {
  counter = 0;
  const entries: LedgerEntry[] = [];

  // 1. RETAIL BUYER FOLLOW-THROUGH — should become an agent.
  //    Recurs all year, drags the CEO in for coordination he does not need to
  //    do, real money attached, and Paul is already alongside him.
  entries.push(...recurring({
    title: 'Retail buyer follow-through',
    businessArea: 'retail',
    capabilities: ['retail', 'follow_up'],
    primaryOwner: 'Adi',
    projectManager: 'Paul',
    collaborators: ['Paul'],
    externalParty: 'Sprouts',
    ceoRequired: true,
    ceoActionMode: 'FOLLOW_UP',
    delegable: true,
    valueAtStake: 45_000,
    durationDays: 12,
  }, { firstDay: 5, everyDays: 21, times: 12 }));

  // 2. RETAIL PROMOTIONAL CALENDAR — should FOLD into (1), not stand alone.
  //    Same business area, capabilities overlapping on `retail`. On its own
  //    page it looks like a distinct agent; side by side it is the same job.
  entries.push(...recurring({
    title: 'Retail promo calendar coordination',
    businessArea: 'retail',
    capabilities: ['retail', 'coordination', 'follow_up'],
    primaryOwner: 'Adi',
    projectManager: 'Paul',
    collaborators: ['Paul'],
    externalParty: 'Wegmans',
    ceoRequired: true,
    ceoActionMode: 'REVIEW',
    delegable: true,
    valueAtStake: 22_000,
    durationDays: 9,
  }, { firstDay: 14, everyDays: 28, times: 9 }));

  // 3. PODCAST ADVERTISING PLACEMENT — RadioActive Media stays EXTERNAL.
  //    A real recurring workload, but it is an agency doing agency work and it
  //    rarely reaches the CEO. The right answer is a supplier, not an agent.
  entries.push(...recurring({
    title: 'Podcast flight booking',
    businessArea: 'marketing',
    capabilities: ['podcast_advertising'],
    primaryOwner: 'Paul',
    externalParty: 'RadioActive Media',
    ceoRequired: false,
    delegable: true,
    valueAtStake: 8_000,
    durationDays: 5,
  }, { firstDay: 9, everyDays: 30, times: 9 }));

  // 4. PAID MEDIA REPORTING — Quartile stays EXTERNAL, same reasoning.
  entries.push(...recurring({
    title: 'Paid media weekly reporting',
    businessArea: 'marketing',
    capabilities: ['paid_media'],
    primaryOwner: 'Paul',
    externalParty: 'Quartile',
    ceoRequired: false,
    delegable: true,
    durationDays: 3,
  }, { firstDay: 3, everyDays: 14, times: 18 }));

  // 5. PRODUCTION RUN COORDINATION — Mike alone on every instance.
  //    A single point of failure, which is a continuity finding rather than a
  //    workload complaint. Should surface as a bottleneck naming Mike.
  entries.push(...recurring({
    title: 'Production run coordination',
    businessArea: 'operations',
    capabilities: ['manufacturing', 'supply_chain'],
    primaryOwner: 'Mike',
    ceoRequired: false,
    delegable: false,
    valueAtStake: 60_000,
    durationDays: 16,
  }, { firstDay: 7, everyDays: 24, times: 11 }));

  // 6. ORDER EXCEPTION RECONCILIATION — a DETERMINISTIC WORKFLOW.
  //    Identical every time, one person, no CEO. Code does this more cheaply
  //    than a model and cannot be confidently wrong about it.
  entries.push(...recurring({
    title: 'Order exception reconciliation',
    businessArea: 'operations',
    capabilities: ['fulfillment'],
    primaryOwner: 'Susan',
    ceoRequired: false,
    delegable: true,
    durationDays: 1,
    approvalClass: 'GREEN',
  }, { firstDay: 2, everyDays: 7, times: 34 }));

  // 7. CO-PACKER TRANSITION — an EPISODE, not a pattern.
  //    Nine instances inside eleven days, then never again. By raw frequency it
  //    beats things that happen all year; the architecture must not be built
  //    around the worst fortnight the company had.
  entries.push(...recurring({
    title: 'Co-packer transition workstream',
    businessArea: 'operations',
    capabilities: ['manufacturing', 'vendor_coordination', 'production'],
    primaryOwner: 'Mike',
    collaborators: ['Adi', 'Paul'],
    decisionMaker: 'Adi',
    ceoRequired: true,
    ceoActionMode: 'DECIDE',
    delegable: false,
    valueAtStake: 150_000,
    durationDays: 6,
  }, { firstDay: 120, everyDays: 1.4, times: 9 }));

  // 8. INVESTOR REPORTING — irreducible CEO work, RED class.
  //    Recurs, matters, and is not delegable at any price. It should never be
  //    proposed as an agent that acts; at most one that prepares.
  entries.push(...recurring({
    title: 'Investor update',
    businessArea: 'finance',
    capabilities: ['strategy'],
    primaryOwner: 'Adi',
    decisionMaker: 'Adi',
    ceoRequired: true,
    ceoActionMode: 'DECIDE',
    delegable: false,
    approvalClass: 'RED',
    durationDays: 5,
  }, { firstDay: 20, everyDays: 90, times: 4 }));

  // 9. ONE-OFF WORK — must not be called a pattern at all.
  entries.push(entry({
    title: 'Trademark renewal filing',
    businessArea: 'legal',
    capabilities: ['legal_coordination'],
    primaryOwner: 'Adi',
    ceoRequired: true,
    ceoActionMode: 'APPROVE',
    delegable: false,
    approvalClass: 'RED',
    startDay: 60,
    durationDays: 20,
  }));

  // 10. STILL-OPEN, LONG-QUIET WORK — the stall the bottleneck pass should find.
  entries.push(entry({
    title: 'Wegmans category review packet',
    businessArea: 'retail',
    capabilities: ['retail', 'follow_up'],
    primaryOwner: 'Adi',
    externalParty: 'Wegmans',
    ceoRequired: true,
    ceoActionMode: 'DO',
    startDay: HISTORY_DAYS - 40,
    durationDays: 0,
    completed: false,
    seenCount: 14,
  }));

  return Ledger.parse({
    version: 1,
    updatedAt: at(HISTORY_DAYS),
    previousSyncAt: at(HISTORY_DAYS - 1),
    // A year of daily-ish syncs: enough runs that "carried forward" and "gone
    // quiet" reflect the company rather than the sync schedule.
    syncCount: 210,
    entries,
    commitments: syntheticCommitments(),
  });
}

/** Promises, including one counterparty who needs chasing every single time. */
function syntheticCommitments() {
  const rows: unknown[] = [];

  for (let i = 0; i < 6; i++) {
    rows.push({
      key: `syn-commit-sprouts-${i}`,
      commitment: {
        direction: 'they_owe',
        description: `Sprouts to confirm the Q${(i % 4) + 1} planogram slot`,
        dueDate: at(20 + i * 40),
        status: 'open',
        followUpCount: 3,
        confidence: 0.85,
      },
      counterpartyName: 'Sprouts',
      owedByName: 'Sprouts',
      firstSeenAt: at(14 + i * 40),
      lastSeenAt: at(30 + i * 40),
      status: 'open',
      statusChangedAt: at(30 + i * 40),
      quote: 'We will come back to you on the slot by the end of the month.',
      sourceRef: `syn:commit-${i}`,
    });
  }

  // Never chased once — the worse case, because nobody has even noticed.
  rows.push({
    key: 'syn-commit-radioactive',
    commitment: {
      direction: 'they_owe',
      description: 'RadioActive to send the make-good schedule',
      dueDate: at(HISTORY_DAYS - 30),
      status: 'open',
      followUpCount: 0,
      confidence: 0.8,
    },
    counterpartyName: 'RadioActive Media',
    owedByName: 'RadioActive Media',
    firstSeenAt: at(HISTORY_DAYS - 45),
    lastSeenAt: at(HISTORY_DAYS - 30),
    status: 'open',
    statusChangedAt: at(HISTORY_DAYS - 30),
    quote: 'Make-good schedule coming over this week.',
    sourceRef: 'syn:commit-ra',
  });

  return rows.map((r) => LedgerCommitment.parse(r));
}

/** `now` for the synthetic world: the day after the record ends. */
export function syntheticNow(): Date {
  return new Date(HISTORY_START.getTime() + (HISTORY_DAYS + 1) * DAY_MS);
}
