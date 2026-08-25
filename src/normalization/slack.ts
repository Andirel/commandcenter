/**
 * Slack message -> CanonicalEvent.
 *
 * Slack carries a lot of 120/Life's internal state, including the single most
 * useful signal the other sources lack: confirmation that something is DONE
 * ("the production run is confirmed for Sept 14"). Completion detection leans
 * heavily on this source.
 *
 * Ingestion starts narrow -- selected channels, mentions, and a tracking
 * reaction -- rather than the whole workspace.
 */
import type { CanonicalEvent, ParticipantRef } from '../schemas/events.js';

/** The Slack `message` event shape, narrowed to what we read. */
export interface SlackMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
  /** Present on messages that were edited. */
  edited?: { user?: string; ts?: string };
  reactions?: Array<{ name?: string; users?: string[]; count?: number }>;
  files?: Array<{ id?: string; name?: string; permalink?: string }>;
}

export interface SlackNormalizeOptions {
  /** Channel name for readability; the id alone is unhelpful in a brief. */
  channelName?: string;
  /** Workspace domain, used to build permalinks. */
  teamDomain?: string;
  /** Reaction that explicitly flags a message for tracking. */
  trackingReaction?: string;
}

export function normalizeSlackMessage(
  msg: SlackMessage,
  opts: SlackNormalizeOptions = {},
): CanonicalEvent {
  const mentioned = extractMentions(msg.text ?? '');

  const participants: ParticipantRef[] = mentioned.map((id) => ({
    name: null, email: null, slackUserId: id, zoomIdentity: null,
    role: 'mentioned' as const, personId: null,
  }));

  const channel = msg.channel ?? 'unknown';
  const ts = msg.ts ?? '';

  return {
    eventType: msg.channel_type === 'im' ? 'slack_dm' : 'slack_message',
    occurredAt: slackTsToIso(ts),
    sourceSystem: 'slack',
    // channel + ts is Slack's own uniqueness pair; ts alone repeats across channels.
    sourceExternalId: `${channel}:${ts}`,
    actor: msg.user
      ? { name: null, email: null, slackUserId: msg.user, zoomIdentity: null, role: 'from', personId: null }
      : null,
    participants,
    subject: opts.channelName ? `#${opts.channelName}` : null,
    body: msg.text ?? null,
    summary: null,
    // A Slack thread is the conversation unit; a reply belongs with its parent.
    threadId: msg.thread_ts ?? ts,
    rawReference: permalink(opts.teamDomain, channel, ts),
    rawPayloadReference: `slack:${channel}:${ts}`,
    organizationId: null,
    processingStatus: 'pending',
    metadata: {
      channel,
      channelName: opts.channelName ?? null,
      channelType: msg.channel_type ?? null,
      isThreadReply: Boolean(msg.thread_ts && msg.thread_ts !== ts),
      isBot: Boolean(msg.bot_id),
      subtype: msg.subtype ?? null,
      hasFiles: Boolean(msg.files?.length),
      explicitlyTracked: hasTrackingReaction(msg, opts.trackingReaction),
      mentionedUserIds: mentioned,
    },
  };
}

/** `<@U123>` and `<@U123|display>` mention forms. */
export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  const re = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (m[1]) out.add(m[1]);
  return [...out];
}

function hasTrackingReaction(msg: SlackMessage, reaction: string | undefined): boolean {
  if (!reaction) return false;
  return (msg.reactions ?? []).some((r) => r.name === reaction);
}

/** Slack timestamps are "1699999999.000200" seconds-with-microseconds. */
export function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

function permalink(teamDomain: string | undefined, channel: string, ts: string): string | null {
  if (!teamDomain || !ts) return null;
  return `https://${teamDomain}.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
}

/**
 * Messages that are not business state.
 *
 * Runs before any model call. Bot chatter and join/leave noise make up a large
 * share of channel volume and none of it is a commitment.
 */
export function isSlackNoise(event: CanonicalEvent): boolean {
  const meta = event.metadata as Record<string, unknown>;
  if (meta.isBot === true) return true;

  const subtype = meta.subtype as string | null;
  if (subtype && [
    'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
    'channel_name', 'channel_archive', 'channel_unarchive',
    'bot_message', 'message_deleted', 'thread_broadcast_join',
  ].includes(subtype)) return true;

  const text = (event.body ?? '').trim();
  if (!text) return true;
  // Bare emoji or a couple of words is acknowledgement, not information.
  if (text.length < 4) return true;
  if (/^(:[a-z0-9_+-]+:\s*)+$/i.test(text)) return true;
  if (/^(ok|okay|thanks|thank you|ty|got it|sounds good|will do|yes|no|yep|nope|\+1|👍)[.!]?$/i.test(text)) return true;

  return false;
}
