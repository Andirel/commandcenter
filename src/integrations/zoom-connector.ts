/**
 * Zoom via the installed Zoom-for-Claude connector.
 *
 * 120/Life already has this connector configured, so this is the PREFERRED
 * path -- it needs no separate Zoom app registration, no S2S OAuth credentials,
 * and no webhook endpoint.
 *
 * How it is wired: the connector's tools are MCP tools available to a Claude
 * session, not an HTTP API this process can call directly. So the n8n workflow
 * invokes Claude with the connector attached, and Claude returns the connector
 * payloads; this adapter is handed those payloads verbatim. The shapes are
 * exactly what `search_meetings` and `get_meeting_assets` return, and were
 * verified against real 120/Life data.
 *
 * The alternative -- a direct Zoom Server-to-Server OAuth app -- is documented
 * in docs/workflows.md and remains available if the connector path is ever
 * unavailable. It returns a DIFFERENT shape (structured next_steps arrays
 * rather than attributed markdown), which is why the normalizer is written
 * against the connector format.
 */
import type { MeetingSource } from './types.js';
import type { ZoomMeetingAssets, ZoomMeetingSearchRecord } from '../normalization/zoom.js';

/** Supplies connector payloads. Implemented by the n8n bridge in production. */
export interface ZoomConnectorBridge {
  searchMeetings(params: { from: string; to: string; pageSize?: number }): Promise<{
    meetings?: ZoomMeetingSearchRecord[];
    next_page_token?: string;
    has_more?: boolean;
  }>;
  getMeetingAssets(meetingId: string): Promise<ZoomMeetingAssets | null>;
}

export class ZoomConnectorSource implements MeetingSource {
  readonly name = 'zoom-connector';

  constructor(private readonly bridge: ZoomConnectorBridge) {}

  async listRecent(since: Date, opts: { limit?: number } = {}): Promise<ZoomMeetingSearchRecord[]> {
    const response = await this.bridge.searchMeetings({
      from: since.toISOString(),
      to: new Date().toISOString(),
      pageSize: Math.min(opts.limit ?? 50, 300),
    });

    // Only meetings that actually have an AI Companion summary are worth
    // fetching assets for; the rest cost a call and return nothing usable.
    return (response.meetings ?? []).filter((m) => m.has_summary !== false);
  }

  async fetchAssets(meetingUuid: string): Promise<ZoomMeetingAssets | null> {
    return this.bridge.getMeetingAssets(meetingUuid);
  }
}

/**
 * Zoom meeting UUIDs must be double-encoded before use as a path segment.
 *
 * A UUID may contain `/` and `+` (they are base64-ish), and a single encoding
 * is decoded by the gateway before routing, so the raw character reappears in
 * the path and breaks it. This is a documented Zoom API requirement, and the
 * connector inherits it.
 */
export function encodeMeetingId(uuid: string): string {
  if (!/[/+]/.test(uuid)) return uuid;
  return encodeURIComponent(encodeURIComponent(uuid));
}
