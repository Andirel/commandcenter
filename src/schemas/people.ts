/** People, organizations, and the capability graph. */
import { z } from 'zod';
import {
  Confidence, DiscoveryStatus, Importance, InternalExternal, OrganizationType,
  PrimarySecondary, RelationshipStatus, RelationshipType,
} from './core.js';

export const CapabilityEdge = z.object({
  capability: z.string(),
  confidence: Confidence,
  proficiency: Confidence,
  level: PrimarySecondary,
  evidenceCount: z.number().int().min(0).default(0),
  lastEvidenceAt: z.string().datetime().nullable().default(null),
  /** A human asserted this; evidence-driven updates must not silently overwrite it. */
  manuallyConfirmed: z.boolean().default(false),
});
export type CapabilityEdge = z.infer<typeof CapabilityEdge>;

export const Person = z.object({
  id: z.string(),
  slug: z.string().nullable().default(null),
  organizationId: z.string().nullable().default(null),
  name: z.string(),
  email: z.string().nullable().default(null),
  alternateEmails: z.array(z.string()).default([]),
  slackUserId: z.string().nullable().default(null),
  zoomIdentity: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  relationshipType: RelationshipType.default('unknown'),
  internalExternal: InternalExternal.default('unknown'),
  importanceScore: Importance.default(3),
  discoveryStatus: DiscoveryStatus.default('discovered'),
  confidence: Confidence.default(0.5),
  capabilities: z.array(CapabilityEdge).default([]),
  openTaskCount: z.number().int().min(0).default(0),
  overdueTaskCount: z.number().int().min(0).default(0),
  routingEligible: z.boolean().default(true),
  firstSeenAt: z.string().datetime().optional(),
  lastSeenAt: z.string().datetime().optional(),
  notes: z.string().nullable().default(null),
});
export type Person = z.infer<typeof Person>;

export const Organization = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  organizationType: OrganizationType.default('other'),
  domains: z.array(z.string()).default([]),
  importance: Importance.default(3),
  relationshipStatus: RelationshipStatus.default('active'),
  /** Who at 120/Life owns this relationship -- never inferred from last sender. */
  relationshipOwnerPersonId: z.string().nullable().default(null),
  /** Who chases operational follow-up; frequently not the relationship owner. */
  executionTrackerPersonId: z.string().nullable().default(null),
  capabilities: z.array(CapabilityEdge).default([]),
  notes: z.string().nullable().default(null),
});
export type Organization = z.infer<typeof Organization>;

/**
 * A person the system has spotted but not yet resolved. Produced by discovery;
 * never granted operational authority on first sight.
 */
export const PersonCandidate = z.object({
  name: z.string(),
  email: z.string().nullable().default(null),
  organization: z.string().nullable().default(null),
  organizationType: OrganizationType.nullable().default(null),
  likelyRelationshipType: RelationshipType.default('unknown'),
  likelyFunction: z.string().nullable().default(null),
  likelyCapabilities: z.array(z.string()).default([]),
  evidenceCount: z.number().int().min(0).default(1),
  confidence: Confidence,
  reason: z.string(),
});
export type PersonCandidate = z.infer<typeof PersonCandidate>;

export const ResponsibilityEvidence = z.object({
  personId: z.string().nullable().default(null),
  organizationId: z.string().nullable().default(null),
  capability: z.string(),
  sourceEventId: z.string().nullable().default(null),
  evidenceSummary: z.string(),
  evidenceWeight: z.number().min(0).max(3).default(1),
  confidence: Confidence,
});
export type ResponsibilityEvidence = z.infer<typeof ResponsibilityEvidence>;
