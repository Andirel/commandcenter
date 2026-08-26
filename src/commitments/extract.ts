/**
 * Finding promises in what people actually wrote.
 *
 * The follow-up engine can chase anything it is handed, and until now it was
 * only ever handed commitments somebody had typed in by hand. That is exactly
 * backwards: the promises worth chasing are the ones nobody wrote down, made
 * in the third paragraph of an email on a Tuesday and forgotten by Thursday.
 *
 * This reads them straight out of the correspondence.
 *
 * The hard part is not finding sentences that sound like promises. It is
 * refusing the four things that sound identical and are not:
 *
 *   a request      "can you send the COA?"        -- work, not a promise
 *   a suggestion   "we should send the COA"       -- nobody has committed
 *   a condition    "if we proceed I'll send it"   -- not yet owed
 *   an auto-reply  "I will be out until the 4th"  -- not a promise at all
 *
 * A false commitment is expensive in a specific way: it produces a nudge to a
 * real counterparty about something they never agreed to, which costs the
 * relationship the system exists to protect. So the bar is deliberately high
 * and the failure mode is silence.
 */
import type { CanonicalEvent } from '../schemas/events.js';
import type { StateCommitment } from '../sync/state.js';

/**
 * Who is speaking decides who owes, and it is structural rather than
 * linguistic — far more reliable than trying to read intent from the words.
 * Mail we sent is us promising; mail we received is them promising; an
 * internal colleague in chat is neither.
 */
export type Direction = StateCommitment['direction'];

export interface ExtractedCommitment {
  id: string;
  description: string;
  direction: Direction;
  /** The sentence, verbatim. It is what the follow-up shows the chaser. */
  quote: string;
  dueDate: string | null;
  confidence: number;
  /** Which pattern fired, so a wrong extraction can be traced to a rule. */
  label: string;
  speakerName: string | null;
  speakerEmail: string | null;
  speakerSlackId: string | null;
  /** Counterparty the pipeline already resolved for this event, if any. */
  organizationId: string | null;
  sourceRef: string | null;
  threadId: string | null;
  occurredAt: string;
}

/**
 * First-person promises. Deliberately limited to the speaker committing
 * themselves: "you said you'd send it" is a reference to a promise rather than
 * the making of one, and treating it as new produces a second copy of a
 * commitment already being chased.
 */
const PROMISE_PATTERNS: Array<{ re: RegExp; confidence: number; label: string }> = [
  { re: /\b(?:i|we)\s?(?:'ll|␟will)\s+(?!be\s+(?:out|away|off|on\s+(?:leave|holiday|vacation|pto)))([a-z][^.!?;]{3,140})/i,
    confidence: 0.82, label: 'explicit promise' },
  { re: /\b(?:i'?m|we'?re)\s+going\s+to\s+([a-z][^.!?;]{3,140})/i,
    confidence: 0.78, label: 'stated intention' },
  { re: /\b(?:i|we)\s+(?:plan|planned)\s+(?:on|to)\s+([a-z][^.!?;]{3,140})/i,
    confidence: 0.72, label: 'stated plan' },
  { re: /\blet\s+me\s+([a-z][^.!?;]{3,140})/i,
    confidence: 0.68, label: 'offer to act' },
  { re: /\b(?:i|we)\s+can\s+have\s+([a-z][^.!?;]{3,140})/i,
    confidence: 0.72, label: 'offered delivery' },
  { re: /\b(?:i|we)\s+(?:'ve|␟have)\s+asked\s+([a-z][^.!?;]{3,140})\s+(?:to|for)\b/i,
    confidence: 0.6, label: 'delegated onward' },
];

/**
 * Disqualifiers that apply to the WHOLE message.
 *
 * These say "this is not correspondence between two people", and that verdict
 * cannot be reached sentence by sentence: a marketing blast promises things in
 * one line and carries its unsubscribe footer in another, and an out-of-office
 * often says "I'll respond when I return" after announcing the absence. Judged
 * per sentence, both would yield a promise nobody made.
 */
const NOT_CORRESPONDENCE: Array<{ re: RegExp; why: string }> = [
  { re: /\b(?:out\s+of\s+(?:the\s+)?office|on\s+(?:leave|vacation|holiday|pto)|limited\s+access\s+to\s+email|away\s+from\s+my\s+desk)\b/i, why: 'auto-reply' },
  { re: /\bunsubscribe\b|\b(?:do\s+not|don'?t)\s+reply\b|\bview\s+(?:this|in)\s+(?:email\s+)?(?:in\s+)?(?:your\s+)?browser\b/i, why: 'bulk mail' },
  { re: /\bthis\s+is\s+an\s+automated\b|\bno-?reply@/i, why: 'automated' },
];

/**
 * Disqualifiers that apply to ONE sentence.
 *
 * These are judged line by line on purpose: a mail can perfectly well ask a
 * question in one sentence and make a promise in the next, and discarding the
 * whole message would lose the promise — which is the thing worth having.
 */
const NOT_A_PROMISE: Array<{ re: RegExp; why: string }> = [
  // The speaker is asking someone else to act.
  { re: /\b(?:can|could|would|will)\s+you\b/i, why: 'request' },
  { re: /\bplease\s+(?:send|share|confirm|let|advise|provide|forward|review)\b/i, why: 'request' },
  { re: /\bdo\s+you\s+want\s+(?:me|us)\s+to\b/i, why: 'question' },
  // Nobody has committed yet.
  { re: /\b(?:we|i|you)\s+(?:should|might|may|could)\b/i, why: 'suggestion' },
  { re: /\b(?:maybe|perhaps|possibly)\b/i, why: 'speculation' },
  // Conditional on something that has not happened.
  { re: /\b(?:if|once|when|assuming|provided|unless)\b[^.!?]{0,80}\b(?:i|we)\s?(?:'ll|␟will)\b/i, why: 'conditional' },
  // Reporting someone else's promise rather than making one.
  { re: /\b(?:he|she|they|you)\s+(?:said|says|mentioned|confirmed)\s+(?:that\s+)?(?:he|she|they|you)?\s?(?:'d|␟would|will)\b/i, why: 'reported speech' },
  /*
   * A sentence that opens by explaining the sender's own business is
   * describing standing practice, not promising anything chaseable. Real
   * example: "As <company> operates across 36 languages and 180+ countries,
   * we will utilize AI technology to translate." Nobody can ever ask whether
   * that got done, which is the test a commitment has to pass.
   *
   * Kept deliberately narrow — it wants a present-tense description of how the
   * sender operates. A broader "starts with a subordinate clause" rule would
   * swallow "As we discussed on Friday, I'll send it over", which is one of the
   * commonest ways a real promise is phrased.
   */
  { re: /^(?:as|since|because)\s+[^,]{4,90}\b(?:operates?|works?|serves?|provides?|offers?|supports?|spans?|covers?|specialised?s?|specialized?s?|is\s+available)\b[^,]{0,60},\s/i,
    why: 'explanatory boilerplate' },
];

/**
 * Objects that point at something said earlier rather than naming it.
 *
 * "I plan on doing that this week" is a real promise whose description is
 * useless on its own. The referent is almost always the preceding sentence,
 * which is exactly where a human reader looks.
 */
const ANAPHORIC = /^(?:doing|do|it|that|this|these|those|them|the\s+above|so)\b/i;

/** Softeners. A hedged promise is still a promise, but a weaker one. */
const HEDGES = [
  /\b(?:try|trying)\s+to\b/i,
  /\bhopefully\b/i,
  /\b(?:should|ought\s+to)\s+be\s+able\s+to\b/i,
  /\baim\s+to\b/i,
  /\bdo\s+my\s+best\b/i,
  /\bif\s+(?:i|we)\s+can\b/i,
];

const HEDGE_PENALTY = 0.22;
/** Below this a sentence is not reported at all. */
export const MIN_CONFIDENCE = 0.6;

/**
 * Pull commitments out of one event.
 *
 * Returns at most one commitment per sentence, and stops after the first few:
 * a message containing eight promises is almost always a status roundup, and
 * chasing each line separately would produce exactly the nagging the cadence
 * rules exist to prevent.
 */
export function extractCommitments(event: CanonicalEvent, opts: { maxPerEvent?: number } = {}): ExtractedCommitment[] {
  const text = (event.body ?? event.summary ?? '').trim();
  if (!text) return [];

  const direction = directionOf(event);
  if (!direction) return [];

  // Whole-message verdict first: a blast or an auto-reply yields nothing at
  // all, however promising its individual sentences look.
  const whole = `${event.subject ?? ''} ${text} ${event.actor?.email ?? ''}`;
  if (NOT_CORRESPONDENCE.some((p) => p.re.test(whole))) return [];

  const out: ExtractedCommitment[] = [];
  const seen = new Set<string>();
  const lines = sentences(text);

  for (let i = 0; i < lines.length; i++) {
    const sentence = lines[i]!;
    if (sentence.length < 12 || sentence.length > 400) continue;
    // Contractions are normalized to a private separator so one pattern can
    // match "I'll" and "I will" without a combinatorial explosion of alternates.
    const probe = sentence.replace(/\b(i|we|they|he|she|you)\s+(will|would|have)\b/gi, (_m, a, b) => `${a}␟${b}`);

    if (NOT_A_PROMISE.some((p) => p.re.test(probe))) continue;

    const hit = PROMISE_PATTERNS.find((p) => p.re.test(probe));
    if (!hit) continue;

    const match = hit.re.exec(probe);
    const clause = (match?.[1] ?? '').replace(/␟/g, ' ').trim();
    if (!clause || clause.split(/\s+/).length < 2) continue;

    let confidence = hit.confidence;
    if (HEDGES.some((re) => re.test(sentence))) confidence -= HEDGE_PENALTY;

    const dueDate = parseDue(sentence, event.occurredAt);
    // A promise with a date is a firmer promise, and a far more useful one.
    if (dueDate) confidence += 0.08;

    confidence = Math.min(0.95, Math.round(confidence * 100) / 100);
    if (confidence < MIN_CONFIDENCE) continue;

    /*
     * Resolve a pointer to what it points at. Taken verbatim from the previous
     * sentence rather than rewritten: a clumsy description sitting next to the
     * real quote is recoverable, an invented one is not. With nothing to point
     * at, the promise is dropped — "doing that" in a list helps no one.
     */
    let description = describe(clause);
    if (ANAPHORIC.test(clause)) {
      const referent = i > 0 ? antecedent(lines[i - 1]!) : null;
      if (!referent) continue;
      description = referent;
    }
    const key = description.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: commitmentId(event, key),
      description,
      direction,
      quote: sentence.trim(),
      dueDate,
      confidence,
      label: hit.label,
      speakerName: event.actor?.name ?? null,
      speakerEmail: event.actor?.email ?? null,
      speakerSlackId: event.actor?.slackUserId ?? null,
      organizationId: event.organizationId,
      sourceRef: event.sourceExternalId,
      threadId: event.threadId,
      occurredAt: event.occurredAt,
    });

    if (out.length >= (opts.maxPerEvent ?? 3)) break;
  }

  return out;
}

/**
 * Who owes, from the shape of the event rather than from the words.
 *
 * Returns null when the event cannot say — a meeting transcript has many
 * speakers and the actor is only the host, so attributing every promise in the
 * room to them would be worse than extracting nothing.
 */
export function directionOf(event: CanonicalEvent): Direction | null {
  if (event.sourceSystem === 'outlook_sent') return 'we_owe';
  if (event.sourceSystem === 'outlook') return 'they_owe';
  if (event.sourceSystem === 'slack') return 'internal';
  return null;
}

/** Split on sentence boundaries without breaking on decimals or abbreviations. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<![A-Z][a-z]\.)(?<=[.!?])\s+(?=[A-Z"'(])/)
    .flatMap((s) => s.split(/\n+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Turn the matched clause into something readable in a list.
 *
 * Deliberately conservative: it trims trailing time expressions (the date is
 * carried separately) and capitalizes, but does not rewrite. The quote is
 * always shown alongside, so a clumsy description is recoverable in a way an
 * invented one is not.
 */
export function describe(clause: string): string {
  let s = clause
    .replace(/\s+/g, ' ')
    .replace(/\s*(?:,)?\s*\b(?:by|on|before|no\s+later\s+than)\s+(?:the\s+)?(?:end\s+of\s+(?:the\s+)?)?(?:today|tomorrow|tonight|this|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|eod|cob)\b[^,]*$/i, '')
    .replace(/\s*\b(?:today|tomorrow|tonight|this\s+week|next\s+week|this\s+afternoon|this\s+morning)\b\s*$/i, '')
    .replace(/[\s,;:]+$/, '')
    .trim();
  if (!s) return clause.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The previous sentence, trimmed of the throat-clearing people put in front of
 * a proposal, so it can stand in as the description of what was promised.
 */
export function antecedent(previous: string): string | null {
  const s = previous
    .replace(/\s+/g, ' ')
    .replace(/^(?:i\s+(?:did\s+some\s+research\s+and\s+)?(?:think|believe|reckon|feel)\s+)/i, '')
    .replace(/^(?:i\s+think|it\s+looks\s+like|it\s+seems|my\s+sense\s+is)\s+(?:that\s+)?/i, '')
    .replace(/^(?:so|and|but|also|ok|okay|got\s+it)[,\s]+/i, '')
    .replace(/[\s.]+$/, '')
    .trim();
  if (s.split(/\s+/).length < 4) return null;
  const capped = s.length > 160 ? `${s.slice(0, 157).trimEnd()}…` : s;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Resolve a stated deadline against the day the message was written.
 *
 * Returns null freely. An undated promise is now perfectly chaseable — the
 * ledger starts the clock when it was first heard — so guessing a date to
 * avoid a null is all downside: a wrong date produces a nudge that is either
 * premature or late, and both read as carelessness.
 */
export function parseDue(sentence: string, occurredAt: string): string | null {
  const base = new Date(occurredAt);
  if (Number.isNaN(base.getTime())) return null;
  const s = sentence.toLowerCase();

  if (/\btomorrow\b/.test(s)) return atMidnight(base.getTime() + DAY_MS);
  if (/\b(?:today|tonight|this\s+afternoon|by\s+eod|end\s+of\s+day|by\s+cob)\b/.test(s)) return atMidnight(base.getTime());

  const weekday = /\b(?:by|on|this|next|before)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(s);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1]!);
    const nextWeek = /\bnext\s+(?:week\s+)?\w*$/.test(weekday[0]!.trim()) || /\bnext\s+/.test(weekday[0]!);
    let delta = (target - base.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;              // "on Monday" said on a Monday means the next one
    if (nextWeek) delta += 7;
    return atMidnight(base.getTime() + delta * DAY_MS);
  }

  if (/\bend\s+of\s+(?:the\s+)?(?:this\s+)?week\b|\bthis\s+week\b/.test(s)) return endOfWeek(base, 0);
  if (/\bnext\s+week\b/.test(s)) return endOfWeek(base, 1);
  if (/\bend\s+of\s+(?:the\s+)?month\b/.test(s)) {
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).toISOString();
  }

  const inDays = /\bin\s+(\d{1,2})\s+(day|days|week|weeks)\b/.exec(s);
  if (inDays) {
    const n = Number(inDays[1]);
    const mult = inDays[2]!.startsWith('week') ? 7 : 1;
    return atMidnight(base.getTime() + n * mult * DAY_MS);
  }

  return null;
}

function endOfWeek(base: Date, weeksAhead: number): string {
  // Friday of the target week.
  const delta = (5 - base.getUTCDay() + 7) % 7;
  return atMidnight(base.getTime() + (delta + weeksAhead * 7) * DAY_MS);
}

function atMidnight(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Stable across runs, so the same promise read again on Tuesday reconciles
 * with Monday's record instead of restarting its follow-up clock at zero.
 */
function commitmentId(event: CanonicalEvent, key: string): string {
  const scope = event.threadId ?? event.sourceExternalId ?? event.occurredAt;
  return `cmt:${scope}:${shortHash(key)}`;
}

function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
