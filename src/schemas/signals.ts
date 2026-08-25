/**
 * The standardized interface for upstream intelligence services.
 *
 * Finaloop, Klaviyo and Gusto already have working Claude connectors. We
 * consume their CONCLUSIONS; we do not rebuild their ingestion. Quartile data
 * and aggregated customer-service patterns enter the same way.
 */
import { z } from 'zod';
import { SourceSystem } from './core.js';

export const BusinessSignal = z.object({
  signalType: z.string(),
  businessArea: z.string().nullable().default(null),
  sourceSystem: SourceSystem,

  severity: z.number().int().min(1).max(10),
  summary: z.string(),
  evidence: z.string().nullable().default(null),
  recommendedAction: z.string().nullable().default(null),

  /**
   * Advisory only. The routing engine decides actual ownership -- a signal
   * naming "Peter, Mike, Adi" is a hint, not an assignment.
   */
  likelyPeople: z.array(z.string()).default([]),

  /** Present when the signal represents a PATTERN rather than a single event. */
  windowStart: z.string().datetime().nullable().default(null),
  windowEnd: z.string().datetime().nullable().default(null),
  observationCount: z.number().int().min(1).nullable().default(null),

  valueAtStake: z.number().nullable().default(null),
  occurredAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
});
export type BusinessSignal = z.infer<typeof BusinessSignal>;

/** Signal types the priority engine knows how to weight (config/priority-rules.yaml). */
export const KNOWN_SIGNAL_TYPES = [
  'cash_risk',
  'inventory_risk',
  'production_risk',
  'supply_disruption',
  'compliance_risk',
  'revenue_opportunity',
  'roas_decline',
  'customer_experience',
  'expense_anomaly',
  'margin_issue',
  'working_capital',
  'payroll_administrative',
  'email_performance',
] as const;
export type KnownSignalType = (typeof KNOWN_SIGNAL_TYPES)[number];
