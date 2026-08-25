/**
 * The ledger — the only part of the system with memory.
 *
 * Everything else is a pure function of a window: give the sync seven days of
 * mail and it produces a queue. Run it again tomorrow and it produces another
 * one, with no idea that it has ever run before. That is fine for signals,
 * which are genuinely about now, and wrong for work, which persists.
 *
 * Two consequences of having no memory, both fatal to a daily tool:
 *
 *   1. Nothing can ever be finished. A task completed yesterday is rebuilt
 *      from the same email today, so the queue only grows and eventually
 *      becomes archaeology the reader learns to scroll past.
 *   2. Nothing can be compared. "Three new, one slipped, this has been waiting
 *      on Ira for nine days" is worth more than any snapshot, and it is not
 *      computable from a single run.
 *
 * The ledger stores what survives a run: identity, status, and the score at
 * the previous sync. It is deliberately a plain document — it writes to disk
 * today and maps onto Postgres rows unchanged later.
 */
import { z } from 'zod';
import { Commitment, Task } from '../schemas/tasks.js';
import { StateTask } from '../sync/state.js';

/**
 * `dormant` is not a synonym for done.
 *
 * A task that stops appearing has usually either been completed without anyone
 * saying so, or quietly died. Both are common at a ten-person company, and
 * neither is safe to assume. So silence moves an entry out of the daily plan
 * and into a group that gets asked about once, rather than deleting it or
 * leaving it to sit at rank 4 forever.
 */
export const LedgerStatus = z.enum(['open', 'completed', 'dormant', 'dismissed']);
export type LedgerStatus = z.infer<typeof LedgerStatus>;

export const CompletionRecord = z.object({
  at: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
  label: z.string(),
  /** How we came to believe it: inferred, confirmed by the CEO, or asserted. */
  source: z.enum(['detected', 'confirmed', 'manual']),
  /** The event that carried the evidence, so a wrong close can be traced. */
  sourceRef: z.string().nullable().default(null),
});
export type CompletionRecord = z.infer<typeof CompletionRecord>;

export const LedgerEntry = z.object({
  key: z.string(),
  /** Canonical task, kept so matching and routing run on the same shape. */
  task: Task,
  /** Render record from the last run that saw evidence for this entry. */
  state: StateTask,

  firstSeenAt: z.string(),
  /** The last sync that observed evidence — not the last sync that ran. */
  lastSeenAt: z.string(),
  /** Timestamp of the newest piece of evidence itself. */
  lastActivityAt: z.string(),
  /** How many syncs have seen it. A high count with no movement is a smell. */
  seenCount: z.number().int().default(1),

  status: LedgerStatus.default('open'),
  statusChangedAt: z.string(),
  completion: CompletionRecord.nullable().default(null),
  /** Set when evidence looks conclusive but the item is too consequential to close on inference. */
  pendingConfirmation: CompletionRecord.nullable().default(null),

  /** Rank and score at the previous sync, so a move is reportable. */
  previousRank: z.number().int().nullable().default(null),
  previousScore: z.number().nullable().default(null),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/**
 * Commitments carry their own memory: how many times we have chased, and when.
 *
 * Without it the follow-up engine re-fires the first nudge every single day,
 * which is how a chasing tool becomes a nagging one and gets turned off.
 */
export const LedgerCommitment = z.object({
  key: z.string(),
  commitment: Commitment,
  counterpartyName: z.string().nullable().default(null),
  owedByName: z.string().nullable().default(null),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  status: z.enum(['open', 'fulfilled', 'dropped']).default('open'),
  statusChangedAt: z.string(),
  quote: z.string().nullable().default(null),
  sourceRef: z.string().nullable().default(null),
});
export type LedgerCommitment = z.infer<typeof LedgerCommitment>;

export const Ledger = z.object({
  version: z.literal(1),
  /** `generatedAt` of the sync that last wrote this ledger. */
  updatedAt: z.string(),
  /** `generatedAt` of the sync before that — the basis for "since". */
  previousSyncAt: z.string().nullable().default(null),
  syncCount: z.number().int().default(0),
  entries: z.array(LedgerEntry).default([]),
  commitments: z.array(LedgerCommitment).default([]),
});
export type Ledger = z.infer<typeof Ledger>;

export function emptyLedger(): Ledger {
  return Ledger.parse({ version: 1, updatedAt: new Date().toISOString(), entries: [], commitments: [] });
}

/** Entries the matcher and the completion detector should consider live. */
export function openEntries(ledger: Ledger): LedgerEntry[] {
  return ledger.entries.filter((e) => e.status === 'open' || e.status === 'dormant');
}
