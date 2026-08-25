/**
 * Microsoft Graph message -> CanonicalEvent.
 *
 * All Graph-specific shape handling lives here. Nothing downstream should ever
 * know what a `bodyPreview` or an `internetMessageId` is.
 *
 * Verified against the Microsoft Graph v1.0 `message` resource; fields are read
 * defensively because Graph omits rather than nulls absent values.
 */
import type { CanonicalEvent, ParticipantRef } from '../schemas/events.js';

/** The subset of the Graph message resource this system reads. */
export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  sender?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  webLink?: string;
  isDraft?: boolean;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

export interface OutlookNormalizeOptions {
  /** 'outlook' for received mail, 'outlook_sent' for commitment detection. */
  direction: 'received' | 'sent';
  /** Store body text inline. Off by default -- prefer a reference. */
  includeBody?: boolean;
}

export function normalizeOutlookMessage(
  msg: GraphMessage,
  opts: OutlookNormalizeOptions,
): CanonicalEvent {
  const sourceSystem = opts.direction === 'sent' ? 'outlook_sent' : 'outlook';
  const from = msg.from?.emailAddress ?? msg.sender?.emailAddress;

  const participants: ParticipantRef[] = [];
  for (const r of msg.toRecipients ?? []) participants.push(recipient(r, 'to'));
  for (const r of msg.ccRecipients ?? []) participants.push(recipient(r, 'cc'));

  const occurredAt =
    (opts.direction === 'sent' ? msg.sentDateTime : msg.receivedDateTime) ??
    msg.sentDateTime ?? msg.receivedDateTime ?? new Date().toISOString();

  return {
    eventType: opts.direction === 'sent' ? 'email_sent' : 'email_received',
    occurredAt: new Date(occurredAt).toISOString(),
    sourceSystem,
    // internetMessageId is stable across mailboxes; Graph's `id` is not.
    sourceExternalId: msg.internetMessageId ?? msg.id,
    actor: {
      name: from?.name ?? null,
      email: from?.address ?? null,
      slackUserId: null,
      zoomIdentity: null,
      role: 'from',
      personId: null,
    },
    participants,
    subject: msg.subject ?? null,
    body: opts.includeBody ? bodyText(msg) : null,
    summary: msg.bodyPreview ?? null,
    threadId: msg.conversationId ?? null,
    rawReference: msg.webLink ?? null,
    rawPayloadReference: `graph:message:${msg.id}`,
    organizationId: null,
    processingStatus: 'pending',
    metadata: {
      graphId: msg.id,
      isDraft: msg.isDraft ?? false,
      headers: relevantHeaders(msg),
    },
  };
}

function recipient(
  r: { emailAddress?: { name?: string; address?: string } },
  role: 'to' | 'cc',
): ParticipantRef {
  return {
    name: r.emailAddress?.name ?? null,
    email: r.emailAddress?.address ?? null,
    slackUserId: null,
    zoomIdentity: null,
    role,
    personId: null,
  };
}

function bodyText(msg: GraphMessage): string | null {
  const content = msg.body?.content;
  if (!content) return msg.bodyPreview ?? null;
  if (msg.body?.contentType?.toLowerCase() === 'html') return stripHtml(content);
  return content;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Headers that identify bulk mail. These drive the pre-AI short circuit. */
function relevantHeaders(msg: GraphMessage): Record<string, string> {
  const wanted = ['list-unsubscribe', 'precedence', 'auto-submitted', 'x-auto-response-suppress'];
  const out: Record<string, string> = {};
  for (const h of msg.internetMessageHeaders ?? []) {
    const name = h.name.toLowerCase();
    if (wanted.includes(name)) out[name] = h.value;
  }
  return out;
}

/**
 * Bulk / automated mail detection.
 *
 * Runs BEFORE any model call. Newsletters and receipts are the bulk of an
 * inbox and none of them are business state.
 */
export function isBulkMail(event: CanonicalEvent): boolean {
  const headers = (event.metadata.headers ?? {}) as Record<string, string>;
  if (headers['list-unsubscribe']) return true;
  if (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') return true;
  const precedence = headers['precedence']?.toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;

  const subject = (event.subject ?? '').toLowerCase();
  return /^(out of office|automatic reply|undeliverable|delivery status notification)/.test(subject);
}
