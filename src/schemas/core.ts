/**
 * Core enumerations and primitives shared across the system.
 *
 * These mirror the Postgres enums in database/migrations/0001. When one changes,
 * both must change together -- `tests/schema-parity.test.ts` enforces that.
 */
import { z } from 'zod';

/** 0-1 confidence. Everything the system infers carries one. */
export const Confidence = z.number().min(0).max(1);
export type Confidence = z.infer<typeof Confidence>;

/** 0-5 scoring dimension used throughout the priority engine. */
export const Score05 = z.number().int().min(0).max(5);

/** 1-5 importance. */
export const Importance = z.number().int().min(1).max(5);

export const OrganizationType = z.enum([
  'internal', 'agency', 'vendor', 'retailer', 'manufacturer',
  'media_partner', 'research_partner', 'professional_services',
  'financial', 'logistics', 'customer', 'other',
]);
export type OrganizationType = z.infer<typeof OrganizationType>;

export const RelationshipStatus = z.enum(['active', 'prospective', 'dormant', 'ended']);
export type RelationshipStatus = z.infer<typeof RelationshipStatus>;

/**
 * Discovery lifecycle. Authority is earned, never granted by a single email.
 * Only `confirmed` people are eligible to own work; `provisional` may
 * collaborate or act as a counterparty.
 */
export const DiscoveryStatus = z.enum(['discovered', 'provisional', 'confirmed', 'inactive']);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatus>;

export const InternalExternal = z.enum(['internal', 'external', 'unknown']);
export type InternalExternal = z.infer<typeof InternalExternal>;

export const RelationshipType = z.enum([
  'employee', 'contractor', 'agency_contact', 'vendor_contact',
  'retailer_contact', 'manufacturer_contact', 'media_contact',
  'professional_services_contact', 'customer', 'other', 'unknown',
]);
export type RelationshipType = z.infer<typeof RelationshipType>;

export const PrimarySecondary = z.enum(['primary', 'secondary', 'occasional']);
export type PrimarySecondary = z.infer<typeof PrimarySecondary>;

export const InitiativeStatus = z.enum([
  'proposed', 'active', 'paused', 'blocked', 'completed', 'abandoned',
]);
export type InitiativeStatus = z.infer<typeof InitiativeStatus>;

export const TaskStatus = z.enum([
  'proposed', 'open', 'in_progress', 'waiting_internal', 'waiting_external',
  'blocked', 'needs_review', 'completed', 'cancelled', 'superseded',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskCollaboratorRole = z.enum([
  'contributor', 'reviewer', 'approver', 'watcher', 'external_counterparty', 'informed',
]);
export type TaskCollaboratorRole = z.infer<typeof TaskCollaboratorRole>;

/**
 * How the CEO must engage. Central to the product: what Adi must DO costs
 * hours; what Adi must APPROVE costs minutes. Both "need Adi".
 */
export const ActionMode = z.enum([
  'DO', 'DECIDE', 'APPROVE', 'DELEGATE', 'FOLLOW_UP', 'REVIEW', 'AWARE',
]);
export type ActionMode = z.infer<typeof ActionMode>;

export const CommitmentStatus = z.enum([
  'open', 'fulfilled', 'overdue', 'waived', 'cancelled', 'needs_review',
]);
export type CommitmentStatus = z.infer<typeof CommitmentStatus>;

export const CommitmentDirection = z.enum(['we_owe', 'they_owe', 'internal']);
export type CommitmentDirection = z.infer<typeof CommitmentDirection>;

export const SourceSystem = z.enum([
  'outlook', 'outlook_sent', 'zoom', 'slack', 'google_drive', 'calendar',
  'finaloop', 'klaviyo', 'gusto', 'quartile', 'customer_service',
  'manual', 'system',
]);
export type SourceSystem = z.infer<typeof SourceSystem>;

export const ProcessingStatus = z.enum([
  'pending', 'processing', 'processed', 'ignored', 'failed', 'needs_review',
]);
export type ProcessingStatus = z.infer<typeof ProcessingStatus>;

/**
 * Deduplication outcome. A wrong MERGE destroys information; a duplicate is
 * merely annoying -- so ambiguity resolves to NEEDS_REVIEW, never a guess.
 */
export const MatchDecision = z.enum([
  'CREATE', 'UPDATE_EXISTING', 'MERGE', 'IGNORE', 'NEEDS_REVIEW',
]);
export type MatchDecision = z.infer<typeof MatchDecision>;

export const ApprovalClass = z.enum(['GREEN', 'YELLOW', 'RED']);
export type ApprovalClass = z.infer<typeof ApprovalClass>;

/** Paul leverage engine output (docs/team-model.md §10). */
export const LeverageClass = z.enum([
  'PAUL_CAN_OWN',
  'PAUL_CAN_PROJECT_MANAGE',
  'PAUL_CAN_PREPARE_FOR_ADI',
  'PAUL_CAN_FOLLOW_UP',
  'PAUL_CAN_RESEARCH',
  'SPECIALIST_REQUIRED',
  'ADI_REQUIRED',
]);
export type LeverageClass = z.infer<typeof LeverageClass>;

export const CorrectionType = z.enum([
  'wrong_owner', 'reassign_paul', 'reassign_mike', 'self_assign',
  'not_important', 'duplicate', 'wrong_deadline', 'defer',
  'stop_tracking', 'wrong_interpretation', 'wrong_priority', 'other',
]);
export type CorrectionType = z.infer<typeof CorrectionType>;

export const AttendanceType = z.enum(['host', 'attendee', 'invited_absent', 'unknown']);
export type AttendanceType = z.infer<typeof AttendanceType>;

export const WorkflowRunStatus = z.enum(['running', 'succeeded', 'failed', 'partial']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;
