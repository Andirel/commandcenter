/**
 * The canonical event shape. Every source -- Outlook, Zoom, Slack, Drive,
 * financial signals -- normalizes into this before anything else touches it.
 *
 * Source-specific quirks are handled in src/normalization/ and NOWHERE else.
 */
import { z } from 'zod';
import { Confidence, ProcessingStatus, SourceSystem } from './core.js';

export const ParticipantRef = z.object({
  name: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  slackUserId: z.string().nullable().default(null),
  zoomIdentity: z.string().nullable().default(null),
  role: z.enum(['from', 'to', 'cc', 'bcc', 'mentioned', 'attendee', 'host', 'participant'])
    .default('participant'),
  /** Filled in by src/people/resolve.ts; null means unresolved, not invalid. */
  personId: z.string().nullable().default(null),
});
export type ParticipantRef = z.infer<typeof ParticipantRef>;

export const CanonicalEvent = z.object({
  id: z.string().optional(),
  eventType: z.string(),
  occurredAt: z.string().datetime(),
  sourceSystem: SourceSystem,
  /** Provider id. With sourceSystem this is the uniqueness key against reprocessing. */
  sourceExternalId: z.string().nullable().default(null),

  actor: ParticipantRef.nullable().default(null),
  participants: z.array(ParticipantRef).default([]),

  subject: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),

  /** Thread/conversation key, used for context retrieval and dedup. */
  threadId: z.string().nullable().default(null),

  /** Prefer references over copies -- see docs/security.md. */
  rawReference: z.string().nullable().default(null),
  rawPayloadReference: z.string().nullable().default(null),

  organizationId: z.string().nullable().default(null),
  processingStatus: ProcessingStatus.default('pending'),
  metadata: z.record(z.unknown()).default({}),
});
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;

/** A meeting, preserving the original Zoom output verbatim alongside our normalization. */
export const MeetingRecord = z.object({
  id: z.string().optional(),
  zoomMeetingId: z.string().nullable().default(null),
  zoomMeetingUuid: z.string().nullable().default(null),
  calendarEventId: z.string().nullable().default(null),
  topic: z.string().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  endedAt: z.string().datetime().nullable().default(null),

  /** Never overwritten. We must always be able to show what the meeting said. */
  summaryOriginal: z.string().nullable().default(null),
  originalNextSteps: z.array(z.string()).default([]),
  summaryNormalized: z.string().nullable().default(null),

  attendees: z.array(ParticipantRef).default([]),
  relatedInitiativeId: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
});
export type MeetingRecord = z.infer<typeof MeetingRecord>;

export const DecisionRecord = z.object({
  decision: z.string(),
  reasoning: z.string().nullable().default(null),
  madeByPersonId: z.string().nullable().default(null),
  decisionDate: z.string().datetime(),
  initiativeId: z.string().nullable().default(null),
  meetingId: z.string().nullable().default(null),
  sourceEventId: z.string().nullable().default(null),
  confidence: Confidence.default(0.7),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
