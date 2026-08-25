/**
 * Completion detection.
 *
 * The system must care whether the business outcome actually happened, not
 * whether someone ticked a box. Nobody at a ten-person company reliably closes
 * tasks, so completion is inferred from evidence:
 *
 *   - a reply confirming receipt
 *   - a Slack message saying it is done
 *   - a new Drive file appearing
 *   - a meeting confirming the outcome
 *   - a payment confirmation
 *   - "the production run is confirmed for Sept 14"
 *
 * Deterministic patterns run first; the AI assessment is only needed for the
 * ambiguous remainder.
 */
import type { CanonicalEvent } from '../schemas/events.js';
import type { Task } from '../schemas/tasks.js';
import type { CompletionAssessment } from '../schemas/ai.js';
import { tokenSimilarity } from '../deduplication/similarity.js';

/** Phrases that assert completion outright. */
const COMPLETION_PATTERNS: Array<{ re: RegExp; confidence: number; label: string }> = [
  { re: /\b(?:it'?s |this is |that'?s )?(?:all )?(?:done|completed|finished|wrapped up)\b/i, confidence: 0.75, label: 'stated as done' },
  { re: /\b(?:has been|have been|was|were|is now|are now) (?:sent|shipped|paid|submitted|filed|delivered|completed|scheduled|confirmed|approved|signed|placed)\b/i, confidence: 0.8, label: 'stated as completed' },
  { re: /\b(?:i|we) (?:just )?(?:sent|paid|submitted|filed|shipped|uploaded|placed|scheduled|signed|approved)\b/i, confidence: 0.78, label: 'first-person completion' },
  { re: /\bconfirmed for\b/i, confidence: 0.8, label: 'confirmation with a date' },
  { re: /\b(?:payment|invoice) (?:has been |was )?(?:processed|paid|cleared|remitted)\b/i, confidence: 0.85, label: 'payment confirmation' },
  { re: /\b(?:received|got) (?:the|your) (?:document|file|form|coa|certificate|paperwork|invoice)\b/i, confidence: 0.7, label: 'receipt confirmed' },
  { re: /\ball set\b|\bgood to go\b|\btaken care of\b|\bhandled\b/i, confidence: 0.65, label: 'informal completion' },
];

/**
 * Markers that the work is NOT finished. Checked first, and decisive.
 *
 * Two distinct jobs, which is why the list is broader than simple negation:
 *
 *   1. Outright denial — "not done yet" contains "done", and reading that as
 *      completion would close live work.
 *   2. Progress, which is the far more common trap. Real status messages read
 *      like "TikTok - done. Amazon - waiting for image processing", and the
 *      naive reading closes an entire multi-marketplace task on the strength
 *      of the one line that happens to be finished. A message that reports
 *      both finished and unfinished parts is an update, not a completion, and
 *      the presence of ANY unfinished marker settles it.
 *
 * Questions are included for the same reason: someone asking which of two
 * options we want is reporting that a decision is still outstanding, however
 * confidently the rest of the message reads.
 */
const NEGATION_PATTERNS = [
  /\bnot (?:yet |quite )?(?:done|completed|finished|sent|paid|ready|confirmed)\b/i,
  /\b(?:still|haven'?t|hasn'?t|have not|has not) (?:working|waiting|been|yet|need)\b/i,
  /\bwill be (?:done|sent|paid|completed|ready)\b/i,
  /\bonce (?:it'?s|this is|that'?s) (?:done|complete|ready)\b/i,
  /\bbefore (?:we|i|you) (?:send|pay|submit|finish)\b/i,
  /\bneed(?:s)? to be (?:done|sent|paid|completed)\b/i,
  /\bcan you\b|\bcould you\b|\bplease (?:send|pay|submit|confirm)\b/i,
  // Work still in flight.
  /\bwaiting (?:for|on)\b/i,
  /\b(?:is |are |still )?pending\b/i,
  /\bin progress\b/i,
  /\bstill (?:to|needs?|working)\b/i,
  /\bnext step\b/i,
  // A question about what to do is a decision still outstanding.
  /\b(?:do|would|should) you (?:want|prefer|like)\b/i,
  /\bare we (?:going to|still)\b/i,
];

export interface CompletionSignal {
  taskId: string;
  confidence: number;
  evidence: string;
  label: string;
  /** Consequential items need a human even when the model is confident. */
  requiresHumanVerification: boolean;
}

export interface CompletionOptions {
  /** Above this, completion may be applied automatically. */
  autoCompleteConfidence?: number;
  /** Tasks at or above this importance always need human confirmation. */
  humanVerificationImportance?: number;
  /** Value at stake above which a human must confirm. */
  humanVerificationValue?: number;
}

/**
 * Look for evidence in one event that a candidate task is complete.
 *
 * Requires BOTH a completion phrase and topical overlap with the task: a
 * message saying "done" in a channel where an unrelated task is open must not
 * close it.
 */
export function detectCompletion(
  event: CanonicalEvent,
  candidates: Task[],
  opts: CompletionOptions = {},
): CompletionSignal[] {
  /*
   * A message cannot finish the work it asked for.
   *
   * The sync window overlaps between runs, so the message that created a task
   * on Monday is read again on Tuesday. Without this, a request containing any
   * completion-shaped phrase closes the very task it opened — silently, and
   * one day after the task appeared.
   */
  const selfId = event.sourceExternalId;
  const text = `${event.subject ?? ''} ${event.body ?? ''} ${event.summary ?? ''}`.trim();
  if (!text) return [];

  // Decisive, and checked before any completion phrase: a message reporting
  // unfinished work does not close a task no matter what else it says.
  if (NEGATION_PATTERNS.some((re) => re.test(text))) return [];

  const matched = COMPLETION_PATTERNS.find((p) => p.re.test(text));
  if (!matched) return [];

  const signals: CompletionSignal[] = [];

  for (const task of candidates) {
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'superseded') continue;
    if (selfId && (task.id === selfId || task.sourceEventId === selfId)) continue;

    // Topical overlap guards against closing the wrong task.
    const overlap = tokenSimilarity(text, `${task.title} ${task.description ?? ''}`);
    if (overlap < 0.12) continue;

    // Same-thread evidence is much stronger than a loose topical match.
    const sameThread = Boolean(event.threadId && task.sourceThreadId === event.threadId);
    const confidence = Math.min(
      0.95,
      matched.confidence * (sameThread ? 1.1 : 0.85) + Math.min(0.1, overlap * 0.2),
    );

    signals.push({
      taskId: task.id,
      confidence: round(confidence),
      evidence: excerpt(text, matched.re),
      label: matched.label,
      requiresHumanVerification: needsHumanVerification(task, opts),
    });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Consequential work is confirmed by a human even when the model is sure.
 * The cost of wrongly closing a $40k commitment is far higher than the cost of
 * asking.
 */
export function needsHumanVerification(task: Task, opts: CompletionOptions = {}): boolean {
  if (task.approvalClass === 'RED') return true;
  const importanceFloor = opts.humanVerificationImportance ?? 5;
  if (task.priority.impact >= importanceFloor) return true;
  if (task.ceoRequired && task.ceoActionMode === 'APPROVE') return true;
  return false;
}

/** Whether a signal may be applied without asking. */
export function canAutoComplete(signal: CompletionSignal, opts: CompletionOptions = {}): boolean {
  if (signal.requiresHumanVerification) return false;
  return signal.confidence >= (opts.autoCompleteConfidence ?? 0.85);
}

/** Merge deterministic and AI assessments, preferring the more cautious. */
export function reconcileAssessment(
  deterministic: CompletionSignal | null,
  ai: CompletionAssessment | null,
): CompletionSignal | null {
  if (!deterministic && !ai) return null;
  if (!ai) return deterministic;
  if (!deterministic) return null;

  // Disagreement resolves toward NOT closing: a task wrongly left open is
  // visible and fixable; one wrongly closed disappears.
  if (!ai.likelyComplete) return null;

  return {
    ...deterministic,
    confidence: Math.min(deterministic.confidence, ai.confidence),
    evidence: ai.evidence || deterministic.evidence,
    requiresHumanVerification: deterministic.requiresHumanVerification || ai.requiresHumanVerification,
  };
}

function excerpt(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return text.slice(0, 200);
  const start = Math.max(0, m.index - 60);
  const end = Math.min(text.length, m.index + m[0].length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
