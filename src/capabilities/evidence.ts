/**
 * Evidence accumulation and confidence maintenance for the capability graph.
 *
 * Two rules govern this module:
 *  1. The system stores WHY it believes something. Confidence without evidence
 *     is not allowed.
 *  2. A manually confirmed edge is never silently overwritten by inference.
 */
import type { CapabilityEdge } from '../schemas/people.js';
import type { ResponsibilityEvidence } from '../schemas/people.js';
import type { RoutingRulesConfig } from '../schemas/config.js';

const DAY_MS = 86_400_000;

export interface EvidenceObservation {
  personId?: string | null;
  organizationId?: string | null;
  capability: string;
  /** Short human-readable statement of what was observed. */
  summary: string;
  /** 0-3. Strong signals (owning a deliverable) outweigh weak ones (being cc'd). */
  weight?: number;
  sourceEventId?: string | null;
  observedAt?: Date;
}

export function toResponsibilityEvidence(
  obs: EvidenceObservation,
  confidence: number,
): ResponsibilityEvidence {
  return {
    personId: obs.personId ?? null,
    organizationId: obs.organizationId ?? null,
    capability: obs.capability,
    sourceEventId: obs.sourceEventId ?? null,
    evidenceSummary: obs.summary,
    evidenceWeight: obs.weight ?? 1,
    confidence,
  };
}

/**
 * Fold one observation into a capability edge.
 *
 * Confidence moves toward 1 with diminishing returns, so the tenth observation
 * shifts belief far less than the second. A manually confirmed edge accumulates
 * evidence but keeps its human-set confidence.
 */
export function applyEvidence(
  edge: CapabilityEdge | undefined,
  obs: EvidenceObservation,
  opts: { createThreshold?: number } = {},
): CapabilityEdge {
  const weight = clamp(obs.weight ?? 1, 0, 3);
  const at = (obs.observedAt ?? new Date()).toISOString();

  if (!edge) {
    // A brand-new edge starts deliberately low. One observation is a hint,
    // not a qualification -- see config/routing-rules.yaml evidence_thresholds.
    const seed = clamp(0.25 + 0.1 * weight, 0, 0.6);
    return {
      capability: obs.capability,
      confidence: seed,
      proficiency: seed,
      level: 'occasional',
      evidenceCount: 1,
      lastEvidenceAt: at,
      manuallyConfirmed: false,
    };
  }

  const evidenceCount = edge.evidenceCount + 1;

  if (edge.manuallyConfirmed) {
    // Record the observation; leave the human's assertion intact.
    return { ...edge, evidenceCount, lastEvidenceAt: at };
  }

  // Diminishing-returns update: step size shrinks as evidence accumulates.
  const step = (weight * 0.15) / Math.sqrt(evidenceCount);
  const confidence = clamp(edge.confidence + step * (1 - edge.confidence), 0, 0.97);
  const proficiency = clamp(edge.proficiency + step * 0.6 * (1 - edge.proficiency), 0, 0.95);

  const createThreshold = opts.createThreshold ?? 2;
  const level: CapabilityEdge['level'] =
    evidenceCount >= createThreshold * 3 && confidence >= 0.75 ? 'primary'
    : evidenceCount >= createThreshold ? 'secondary'
    : 'occasional';

  return { ...edge, confidence, proficiency, level, evidenceCount, lastEvidenceAt: at };
}

/**
 * Exponential decay toward a floor.
 *
 * A capability nobody has exercised in a year is probably not current. Decay
 * keeps the model tracking the company as it is now rather than as it was.
 * Manually confirmed edges are exempt when configured that way.
 */
export function decayEdge(
  edge: CapabilityEdge,
  cfg: RoutingRulesConfig['decay'],
  now: Date = new Date(),
): CapabilityEdge {
  if (cfg.exempt_manually_confirmed && edge.manuallyConfirmed) return edge;
  if (!edge.lastEvidenceAt) return edge;

  const ageDays = (now.getTime() - Date.parse(edge.lastEvidenceAt)) / DAY_MS;
  if (ageDays <= 0) return edge;

  const factor = Math.pow(0.5, ageDays / cfg.half_life_days);
  const confidence = Math.max(cfg.floor, edge.confidence * factor);
  const proficiency = Math.max(cfg.floor, edge.proficiency * factor);
  return { ...edge, confidence, proficiency };
}

/**
 * How much evidence is needed before acting on a belief.
 *
 * Re-routing a $40k decision needs more proof than re-routing a document
 * request, so the bar scales with what is at stake.
 */
export function meetsReassignmentBar(
  confidence: number,
  priorityScore: number,
  thresholds: RoutingRulesConfig['evidence_thresholds'],
): boolean {
  const bar = priorityScore > thresholds.high_impact_when_priority_above
    ? thresholds.reassign_high_impact_confidence
    : thresholds.reassign_low_impact_confidence;
  return confidence >= bar;
}

/**
 * Discovery lifecycle progression.
 *
 * A single email never grants operational authority: `confirmed` requires both
 * sustained evidence AND elapsed time, so a burst of messages in one afternoon
 * cannot promote a stranger into an owner.
 */
export function nextDiscoveryStatus(
  current: 'discovered' | 'provisional' | 'confirmed' | 'inactive',
  evidenceCount: number,
  daysSinceFirstSeen: number,
  thresholds: RoutingRulesConfig['evidence_thresholds'],
): 'discovered' | 'provisional' | 'confirmed' | 'inactive' {
  if (current === 'confirmed' || current === 'inactive') return current;

  if (
    evidenceCount >= thresholds.promote_to_confirmed &&
    daysSinceFirstSeen >= thresholds.confirmed_requires_days
  ) {
    return 'confirmed';
  }
  if (evidenceCount >= thresholds.promote_to_provisional) return 'provisional';
  return 'discovered';
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
