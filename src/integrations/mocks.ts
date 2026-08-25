/**
 * In-memory mocks for every integration.
 *
 * These make the whole pipeline runnable end-to-end with no credentials, which
 * is what lets Phase 1 be built and tested before any external system is
 * connected. They are also what the workflow tests run against.
 */
import type {
  ChatSource, DocumentSource, DraftRef, DraftRequest, DriveDocument,
  EmailSource, MeetingSource, SignalSource,
} from './types.js';
import type { GraphMessage } from '../normalization/outlook.js';
import type { SlackMessage } from '../normalization/slack.js';
import type { ZoomMeetingAssets, ZoomMeetingSearchRecord } from '../normalization/zoom.js';
import type { BusinessSignal } from '../schemas/signals.js';

export class MockEmailSource implements EmailSource {
  readonly name = 'mock-outlook';
  readonly drafts: Array<DraftRequest & { id: string }> = [];

  constructor(
    private readonly inbox: GraphMessage[] = [],
    private readonly sent: GraphMessage[] = [],
  ) {}

  async fetchSince(since: Date, opts: { folder?: 'inbox' | 'sentitems'; limit?: number } = {}) {
    const source = opts.folder === 'sentitems' ? this.sent : this.inbox;
    const cutoff = since.getTime();
    return source
      .filter((m) => {
        const t = Date.parse(m.receivedDateTime ?? m.sentDateTime ?? '');
        return Number.isNaN(t) ? true : t >= cutoff;
      })
      .slice(0, opts.limit ?? 100);
  }

  async fetchThread(conversationId: string) {
    return [...this.inbox, ...this.sent].filter((m) => m.conversationId === conversationId);
  }

  async createDraft(draft: DraftRequest): Promise<DraftRef> {
    const id = `mock-draft-${this.drafts.length + 1}`;
    this.drafts.push({ ...draft, id });
    return { id, url: null };
  }
}

export class MockMeetingSource implements MeetingSource {
  readonly name = 'mock-zoom';

  constructor(
    private readonly meetings: ZoomMeetingSearchRecord[] = [],
    private readonly assets: Map<string, ZoomMeetingAssets> = new Map(),
  ) {}

  async listRecent(since: Date, opts: { limit?: number } = {}) {
    const cutoff = since.getTime();
    return this.meetings
      .filter((m) => {
        const t = Date.parse(m.meeting_start_time ?? '');
        return Number.isNaN(t) ? true : t >= cutoff;
      })
      .slice(0, opts.limit ?? 50);
  }

  async fetchAssets(meetingUuid: string) {
    return this.assets.get(meetingUuid) ?? null;
  }
}

export class MockChatSource implements ChatSource {
  readonly name = 'mock-slack';
  readonly posted: Array<{ channel: string; text: string }> = [];

  constructor(private readonly messages: Map<string, SlackMessage[]> = new Map()) {}

  async fetchMessages(channel: string, since: Date, opts: { limit?: number } = {}) {
    const cutoff = since.getTime() / 1000;
    return (this.messages.get(channel) ?? [])
      .filter((m) => Number.parseFloat(m.ts ?? '0') >= cutoff)
      .slice(0, opts.limit ?? 200);
  }

  async fetchThread(channel: string, threadTs: string) {
    return (this.messages.get(channel) ?? []).filter((m) => (m.thread_ts ?? m.ts) === threadTs);
  }

  async postMessage(channel: string, text: string) {
    this.posted.push({ channel, text });
  }
}

export class MockSignalSource implements SignalSource {
  constructor(readonly name: string, private readonly signals: BusinessSignal[] = []) {}

  async pull(since: Date) {
    const cutoff = since.getTime();
    return this.signals.filter((s) => Date.parse(s.occurredAt) >= cutoff);
  }
}

export class MockDocumentSource implements DocumentSource {
  readonly name = 'mock-drive';

  constructor(
    private readonly documents: DriveDocument[] = [],
    private readonly contents: Map<string, string> = new Map(),
  ) {}

  async listChangedSince(since: Date, opts: { limit?: number } = {}) {
    const cutoff = since.getTime();
    return this.documents
      .filter((d) => !d.modifiedAt || Date.parse(d.modifiedAt) >= cutoff)
      .slice(0, opts.limit ?? 200);
  }

  async fetchText(fileId: string) {
    return this.contents.get(fileId) ?? null;
  }
}
