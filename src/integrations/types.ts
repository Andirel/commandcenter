/**
 * Integration interfaces.
 *
 * Every external system is reached through one of these. Each ships with a
 * mock, so missing credentials block DEPLOYMENT, never development.
 *
 * Credentials are documented in .env.example and docs/implementation-plan.md §5.
 * We never invent them.
 */
import type { GraphMessage } from '../normalization/outlook.js';
import type { SlackMessage } from '../normalization/slack.js';
import type { ZoomMeetingAssets, ZoomMeetingSearchRecord } from '../normalization/zoom.js';
import type { BusinessSignal } from '../schemas/signals.js';

export interface DraftRef {
  id: string;
  url: string | null;
}

export interface DraftRequest {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Reply into an existing thread rather than starting a new one. */
  replyToMessageId?: string;
}

/**
 * Mail. `createDraft` exists from Phase 6; there is deliberately no `send`
 * method on this interface -- sending is a separate, gated capability so that
 * no code path can reach it by accident.
 */
export interface EmailSource {
  readonly name: string;
  fetchSince(since: Date, opts?: { folder?: 'inbox' | 'sentitems'; limit?: number }): Promise<GraphMessage[]>;
  fetchThread(conversationId: string): Promise<GraphMessage[]>;
  createDraft(draft: DraftRequest): Promise<DraftRef>;
}

export interface MeetingSource {
  readonly name: string;
  listRecent(since: Date, opts?: { limit?: number }): Promise<ZoomMeetingSearchRecord[]>;
  fetchAssets(meetingUuid: string): Promise<ZoomMeetingAssets | null>;
}

export interface ChatSource {
  readonly name: string;
  fetchMessages(channel: string, since: Date, opts?: { limit?: number }): Promise<SlackMessage[]>;
  fetchThread(channel: string, threadTs: string): Promise<SlackMessage[]>;
  postMessage(channel: string, text: string, blocks?: unknown[]): Promise<void>;
}

/** Upstream intelligence services. We consume conclusions, not raw data. */
export interface SignalSource {
  readonly name: string;
  pull(since: Date): Promise<BusinessSignal[]>;
}

export interface DriveDocument {
  id: string;
  name: string;
  url: string | null;
  folderPath: string | null;
  mimeType: string | null;
  modifiedAt: string | null;
  modifiedByEmail: string | null;
}

export interface DocumentSource {
  readonly name: string;
  listChangedSince(since: Date, opts?: { limit?: number }): Promise<DriveDocument[]>;
  fetchText(fileId: string): Promise<string | null>;
}

/** Thrown when an integration is used without credentials configured. */
export class MissingCredentialError extends Error {
  constructor(readonly integration: string, readonly variables: string[]) {
    super(
      `${integration} is not configured. Set ${variables.join(', ')} in .env ` +
      `(see .env.example and docs/implementation-plan.md §5).`,
    );
    this.name = 'MissingCredentialError';
  }
}
