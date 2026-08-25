/**
 * Business signals -> CanonicalEvent.
 *
 * Finaloop, Klaviyo and Gusto already have working Claude connectors. This
 * module normalizes their CONCLUSIONS into the same pipeline everything else
 * flows through. We do not rebuild those systems (brief §43).
 */
import type { CanonicalEvent } from '../schemas/events.js';
import { BusinessSignal } from '../schemas/signals.js';

export function normalizeSignal(signal: BusinessSignal): CanonicalEvent {
  const parsed = BusinessSignal.parse(signal);

  return {
    eventType: `signal:${parsed.signalType}`,
    occurredAt: parsed.occurredAt,
    sourceSystem: parsed.sourceSystem,
    sourceExternalId: signalIdentity(parsed),
    actor: null,
    participants: [],
    subject: parsed.summary,
    body: parsed.evidence,
    summary: parsed.summary,
    threadId: null,
    rawReference: null,
    rawPayloadReference: null,
    organizationId: null,
    processingStatus: 'pending',
    metadata: {
      signalType: parsed.signalType,
      businessArea: parsed.businessArea,
      severity: parsed.severity,
      recommendedAction: parsed.recommendedAction,
      // Advisory only. The routing engine decides ownership; a signal naming
      // three people is a hint, not an assignment.
      likelyPeople: parsed.likelyPeople,
      valueAtStake: parsed.valueAtStake,
      observationCount: parsed.observationCount,
      windowStart: parsed.windowStart,
      windowEnd: parsed.windowEnd,
      ...parsed.metadata,
    },
  };
}

/**
 * A stable identity for a signal.
 *
 * Upstream connectors rarely supply an id, and a recurring signal ("cash is
 * low") re-fires daily. Keying on type + area + window keeps a persistent
 * condition as ONE record that updates, rather than thirty duplicates.
 */
function signalIdentity(signal: BusinessSignal): string {
  const window = signal.windowStart ?? signal.occurredAt.slice(0, 10);
  return [signal.sourceSystem, signal.signalType, signal.businessArea ?? 'general', window].join(':');
}

/**
 * Whether a signal is worth surfacing at all.
 *
 * Severity alone is not enough: a low-severity signal that has persisted for
 * weeks matters more than a one-off blip, and a pattern built from many
 * observations is stronger evidence than a single reading.
 */
export function isMaterialSignal(signal: BusinessSignal, floor = 4): boolean {
  if (signal.severity >= floor) return true;
  if ((signal.observationCount ?? 0) >= 5) return true;
  if (signal.valueAtStake !== null && signal.valueAtStake >= 10_000) return true;
  return false;
}
