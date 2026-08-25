/**
 * Zoom meeting assets -> MeetingRecord + CanonicalEvent.
 *
 * Zoom is a first-class source of operational state at 120/Life: AI Companion
 * summaries are where a great deal of commitment actually gets made.
 *
 * SOURCE SHAPE — verified against live 120/Life data (Aug 2026).
 * The installed Zoom-for-Claude connector does NOT return the raw REST API's
 * structured `summary_details` / `next_steps` arrays. It returns
 * `meeting_summary.summary_markdown`, a markdown document shaped like:
 *
 *     ## Quick recap
 *     <overview paragraph>
 *
 *     ## Next steps
 *     ### Adi
 *     - Ramp up podcast campaigns...[https://tasks.zoom.us?...&stepId=c95678b3-...](...)
 *     ### Michaelhammersley
 *     - Conduct taste testing...[...]
 *     ### Collaboration
 *     - Adi & Michaelhammersley: Monitor the new website design...[...]
 *
 *     ## Summary
 *     ### Return to Profitability Strategy
 *     <narrative>
 *
 * Three properties of this format drive the parser:
 *
 *  1. Action items arrive ALREADY ATTRIBUTED, under `### <Name>` headings. That
 *     attribution is evidence of what the meeting said, not an assignment --
 *     the routing engine re-decides ownership (docs/team-model.md, Test 8).
 *
 *  2. `### Collaboration` is NOT a person. Its bullets carry their own inline
 *     attribution ("Adi & Michaelhammersley:", "Adi & Team:"). Treating that
 *     heading as a name would invent a team member called "Collaboration".
 *
 *  3. Every bullet ends with a Zoom task link carrying a stable `stepId`. That
 *     is a durable per-action-item identity, which makes re-ingesting the same
 *     meeting idempotent without any fuzzy matching.
 *
 * `summary_plain_text` is also available but is strictly worse for parsing: it
 * drops heading levels and concatenates the URL directly onto the sentence.
 */
import type { CanonicalEvent, MeetingRecord, ParticipantRef } from '../schemas/events.js';

/** The connector's `get_meeting_assets` response, narrowed to what we read. */
export interface ZoomMeetingAssets {
  meeting_uuid?: string;
  meeting_number?: number | string;
  original_meeting_number?: number | string;
  topic?: string;
  start_time?: string;
  end_time?: string;
  deep_url?: string;
  meeting_category?: string;
  meeting_summary?: {
    has_summary?: boolean;
    has_permission?: boolean;
    summary_markdown?: string;
    summary_plain_text?: string;
    summary_doc_url?: string;
  };
  my_notes?: {
    has_my_notes?: boolean;
    content_markdown?: string;
    file_link?: string;
    transcript?: { primary_language?: string; transcript_items?: unknown[] };
  };
  participants?: Array<{ user_name?: string; user_email?: string; id?: string }> | null;
}

/** A meeting record from the connector's meeting search, used for attendees. */
export interface ZoomMeetingSearchRecord {
  meeting_uuid?: string;
  meeting_number?: number;
  topic?: string;
  host_name?: string;
  meeting_start_time?: string;
  meeting_end_time?: string;
  attendees?: Array<{ user_name?: string; user_email?: string }>;
  has_summary?: boolean;
  has_external_user?: boolean;
}

/** One action item as the meeting stated it, before any routing decision. */
export interface ZoomActionItem {
  /** The bullet exactly as written, minus the trailing task link. */
  text: string;
  /**
   * Names the meeting attributed this to. Empty for an unattributed bullet.
   * Multiple names come from the Collaboration section.
   */
  attributedNames: string[];
  /** The `### <heading>` this bullet appeared under. */
  section: string;
  /** Stable Zoom identifier; the idempotency key for re-ingestion. */
  stepId: string | null;
  taskUrl: string | null;
}

export interface ParsedZoomSummary {
  quickRecap: string | null;
  actionItems: ZoomActionItem[];
  /** `### <Topic>` sections under `## Summary`, kept for context retrieval. */
  topics: Array<{ title: string; body: string }>;
}

/** Headings under "Next steps" that group work rather than name a person. */
const NON_PERSON_SECTIONS = new Set(['collaboration', 'team', 'everyone', 'all', 'group', 'others']);

/** Trailing `[url](url)` or bare url appended to a bullet by Zoom. */
const TRAILING_LINK = /\[?(https:\/\/tasks\.zoom\.us[^\]\s)]*)\]?(\(([^)]*)\))?\s*$/;
const STEP_ID = /[?&]stepId=([0-9a-fA-F-]+)/;

/**
 * Parse the connector's summary markdown.
 *
 * Written defensively: a summary with no "Next steps" section, or bullets with
 * no task link, must degrade to fewer action items rather than throw. A meeting
 * that fails to parse is worse than one that parses partially.
 */
export function parseZoomSummaryMarkdown(markdown: string): ParsedZoomSummary {
  const result: ParsedZoomSummary = { quickRecap: null, actionItems: [], topics: [] };
  if (!markdown?.trim()) return result;

  const lines = markdown.split(/\r?\n/);
  let h2: string | null = null;
  let h3: string | null = null;
  let buffer: string[] = [];

  const flushRecap = () => {
    if (h2 === 'quick recap' && buffer.length) {
      const text = buffer.join('\n').trim();
      if (text) result.quickRecap = result.quickRecap ? `${result.quickRecap}\n\n${text}` : text;
    }
  };
  const flushTopic = () => {
    if (h2 === 'summary' && h3 && buffer.length) {
      const body = buffer.join('\n').trim();
      if (body) result.topics.push({ title: h3, body });
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const m2 = /^##\s+(.+?)\s*$/.exec(line);
    if (m2 && !line.startsWith('###')) {
      flushRecap(); flushTopic();
      buffer = [];
      h2 = m2[1]!.trim().toLowerCase();
      h3 = null;
      continue;
    }

    const m3 = /^###\s+(.+?)\s*$/.exec(line);
    if (m3) {
      flushRecap(); flushTopic();
      buffer = [];
      h3 = m3[1]!.trim();
      continue;
    }

    if (h2 === 'next steps') {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet && bullet[1]?.trim()) {
        result.actionItems.push(parseActionItem(bullet[1].trim(), h3 ?? 'Unattributed'));
      }
      continue;
    }

    buffer.push(line);
  }

  flushRecap();
  flushTopic();
  return result;
}

function parseActionItem(bullet: string, section: string): ZoomActionItem {
  let text = bullet;
  let taskUrl: string | null = null;
  let stepId: string | null = null;

  const link = TRAILING_LINK.exec(text);
  if (link) {
    taskUrl = link[3] || link[1] || null;
    text = text.slice(0, link.index).trim();
    const step = STEP_ID.exec(link[1] ?? link[3] ?? '');
    stepId = step?.[1] ?? null;
  }

  // A Collaboration bullet carries its own attribution inline; a bullet under a
  // person's heading inherits the heading.
  let attributedNames: string[] = [];
  const sectionIsPerson = !NON_PERSON_SECTIONS.has(section.trim().toLowerCase());

  const inline = /^([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*(?:\s*&\s*[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*)+)\s*:\s*(.+)$/.exec(text);
  if (inline) {
    attributedNames = inline[1]!.split(/\s*&\s*/).map((n) => n.trim()).filter(Boolean);
    text = inline[2]!.trim();
  } else if (sectionIsPerson) {
    attributedNames = [section.trim()];
  }

  // "Team", "Everyone" and friends are groups, not people to route to.
  attributedNames = attributedNames.filter((n) => !NON_PERSON_SECTIONS.has(n.toLowerCase()));

  return { text, attributedNames, section, stepId, taskUrl };
}

/**
 * Normalize connector assets into a meeting record and its event.
 *
 * The original summary is preserved verbatim on the record. Normalization is
 * additive: when the routing engine later disagrees with Zoom's attribution, we
 * must still be able to show exactly what the meeting said.
 */
export function normalizeZoomAssets(
  assets: ZoomMeetingAssets,
  search?: ZoomMeetingSearchRecord,
): { meeting: MeetingRecord; event: CanonicalEvent; parsed: ParsedZoomSummary } {
  const markdown = assets.meeting_summary?.summary_markdown ?? '';
  const parsed = parseZoomSummaryMarkdown(markdown);

  const startedAt = isoOrNull(assets.start_time ?? search?.meeting_start_time);
  const endedAt = isoOrNull(assets.end_time ?? search?.meeting_end_time);
  const topic = assets.topic ?? search?.topic ?? null;
  const uuid = assets.meeting_uuid ?? search?.meeting_uuid ?? null;

  // The connector's asset payload carries no participant list on the meetings
  // observed; attendees come from the search record instead.
  const attendees: ParticipantRef[] = [];
  for (const p of assets.participants ?? []) {
    attendees.push(participant(p.user_name ?? null, p.user_email ?? null, p.id ?? null, 'attendee'));
  }
  if (!attendees.length) {
    for (const a of search?.attendees ?? []) {
      attendees.push(participant(a.user_name ?? null, a.user_email ?? null, null, 'attendee'));
    }
  }
  if (search?.host_name && !attendees.some((a) => a.name === search.host_name)) {
    attendees.unshift(participant(search.host_name, null, null, 'host'));
  }

  const meeting: MeetingRecord = {
    zoomMeetingId: idOrNull(assets.meeting_number ?? assets.original_meeting_number ?? search?.meeting_number),
    zoomMeetingUuid: uuid,
    calendarEventId: null,
    topic,
    startedAt,
    endedAt,
    summaryOriginal: markdown || null,
    originalNextSteps: parsed.actionItems.map(formatOriginalStep),
    summaryNormalized: null,
    attendees,
    relatedInitiativeId: null,
    sourceUrl: assets.meeting_summary?.summary_doc_url ?? assets.deep_url ?? null,
  };

  const event: CanonicalEvent = {
    eventType: 'meeting_summary',
    occurredAt: endedAt ?? startedAt ?? new Date().toISOString(),
    sourceSystem: 'zoom',
    // The UUID identifies a specific OCCURRENCE. meeting_number is shared by
    // every instance of a recurring meeting and would collapse them into one --
    // 120/Life's biweekly meeting reuses a single number across years.
    sourceExternalId: uuid,
    actor: search?.host_name ? participant(search.host_name, null, null, 'host') : null,
    participants: attendees,
    subject: topic,
    body: markdown || null,
    summary: parsed.quickRecap,
    threadId: uuid,
    rawReference: assets.meeting_summary?.summary_doc_url ?? assets.deep_url ?? null,
    rawPayloadReference: uuid ? `zoom:assets:${uuid}` : null,
    organizationId: null,
    processingStatus: 'pending',
    metadata: {
      actionItemCount: parsed.actionItems.length,
      topicCount: parsed.topics.length,
      attendeeCount: attendees.length,
      hasSummary: assets.meeting_summary?.has_summary ?? false,
      hasMyNotes: assets.my_notes?.has_my_notes ?? false,
      // stepIds make re-ingestion idempotent without fuzzy matching.
      stepIds: parsed.actionItems.map((a) => a.stepId).filter(Boolean),
    },
  };

  return { meeting, event, parsed };
}

function formatOriginalStep(item: ZoomActionItem): string {
  return item.attributedNames.length ? `${item.attributedNames.join(' & ')}: ${item.text}` : item.text;
}

function participant(
  name: string | null,
  email: string | null,
  zoomIdentity: string | null,
  role: ParticipantRef['role'],
): ParticipantRef {
  return { name, email, slackUserId: null, zoomIdentity, role, personId: null };
}

function idOrNull(v: number | string | undefined): string | null {
  return v === undefined || v === null ? null : String(v);
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
