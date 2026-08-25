/**
 * Email signals from Klaviyo flow reports.
 *
 * The metric that matters is REVENUE PER RECIPIENT, not open rate. Open rate
 * measures whether a subject line worked; revenue per recipient measures
 * whether the flow is worth sending at all — and the two routinely disagree.
 *
 * 120/Life's own data makes the point: one flow opens at 51% and clicks at 13%
 * while returning $0.16 a recipient, and another returns $6.57. Judged on
 * engagement the first looks healthy. Judged on money it is the problem.
 */
import type { BusinessSignal } from '../schemas/signals.js';

export interface FlowPerformance {
  flowId: string;
  name: string;
  recipients: number;
  conversions: number;
  revenue: number;
  openRate: number;
  clickRate: number;
  revenuePerRecipient: number;
}

export interface EmailSummary {
  flows: FlowPerformance[];
  totalRevenue: number;
  totalRecipients: number;
  averageRevenuePerRecipient: number;
  best: FlowPerformance | null;
  worst: FlowPerformance | null;
  /** The flow carrying the most sends — where volume is actually going. */
  highestVolume: FlowPerformance | null;
  /** High engagement, no money — the flows most worth fixing. */
  engagedButUnconverting: FlowPerformance[];
}

/** Parse the connector's `flow_aggregation` block. */
export function parseFlowReport(payload: unknown): FlowPerformance[] {
  const root = payload as {
    data?: { attributes?: { flow_aggregation?: unknown[] } };
    attributes?: { flow_aggregation?: unknown[] };
  } | null;
  const agg = (root?.data?.attributes?.flow_aggregation ?? root?.attributes?.flow_aggregation ?? []) as Array<{
    flow_id?: string;
    flow_details?: { attributes?: { name?: string; status?: string } };
    statistics?: Record<string, number>;
  }>;

  return agg.map((row) => {
    const s = row.statistics ?? {};
    const recipients = Math.round(s.recipients ?? 0);
    const revenue = s.conversion_value ?? 0;
    return {
      flowId: row.flow_id ?? '',
      name: row.flow_details?.attributes?.name ?? 'Unnamed flow',
      recipients,
      conversions: Math.round(s.conversions ?? 0),
      revenue,
      openRate: s.open_rate ?? 0,
      clickRate: s.click_rate ?? 0,
      revenuePerRecipient: recipients > 0 ? revenue / recipients : 0,
    };
  }).filter((f) => f.recipients > 0);
}

/** Ignore flows too small for their rate to mean anything. */
const MIN_RECIPIENTS = 50;

export function summarizeEmail(flows: FlowPerformance[]): EmailSummary {
  const material = flows.filter((f) => f.recipients >= MIN_RECIPIENTS);
  const totalRevenue = flows.reduce((s, f) => s + f.revenue, 0);
  const totalRecipients = flows.reduce((s, f) => s + f.recipients, 0);

  const ranked = [...material].sort((a, b) => b.revenuePerRecipient - a.revenuePerRecipient);

  return {
    flows: [...flows].sort((a, b) => b.revenue - a.revenue),
    totalRevenue,
    totalRecipients,
    averageRevenuePerRecipient: totalRecipients > 0 ? totalRevenue / totalRecipients : 0,
    best: ranked[0] ?? null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1]! : null,
    highestVolume: [...material].sort((a, b) => b.recipients - a.recipients)[0] ?? null,
    // People are reading and clicking, and still not buying. That is a flow
    // whose content works and whose offer or landing does not.
    engagedButUnconverting: material.filter(
      (f) => f.openRate >= 0.35 && f.clickRate >= 0.05 && f.revenuePerRecipient < 0.25,
    ).sort((a, b) => b.recipients - a.recipients),
  };
}

export interface EmailSignalOptions {
  occurredAt?: string;
  /** Total revenue over the same window, to express email as a share. */
  totalBusinessRevenue?: number | null;
}

export function emailSignals(summary: EmailSummary, opts: EmailSignalOptions = {}): BusinessSignal[] {
  const out: BusinessSignal[] = [];
  const at = opts.occurredAt ?? new Date().toISOString();
  if (!summary.flows.length) return out;

  const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
  const rpr = (n: number) => `$${n.toFixed(2)}`;

  // --- Volume pointed at the wrong flows ------------------------------------
  // Compared against the HIGHEST-VOLUME flow rather than the lowest-returning
  // one. The question is where the sends are going, and a tiny flow returning
  // nothing is not costing anything. Dividing by its return would also fail
  // outright at zero, which is precisely the worst case.
  const bulk = summary.highestVolume;
  if (summary.best && bulk && bulk.flowId !== summary.best.flowId) {
    const spread = bulk.revenuePerRecipient > 0
      ? summary.best.revenuePerRecipient / bulk.revenuePerRecipient
      : Infinity;
    if (spread >= 5 && bulk.recipients >= summary.best.recipients) {
      out.push({
        signalType: 'revenue_opportunity',
        businessArea: 'marketing',
        sourceSystem: 'klaviyo',
        severity: 5,
        summary: `Email volume is going where the return is lowest: "${bulk.name}" gets ${bulk.recipients.toLocaleString()} sends at ${rpr(bulk.revenuePerRecipient)} each, while "${summary.best.name}" returns ${rpr(summary.best.revenuePerRecipient)} on ${summary.best.recipients.toLocaleString()}.`,
        evidence: Number.isFinite(spread)
          ? `A ${Math.round(spread)}× difference in revenue per recipient, with the larger audience on the weaker flow.`
          : 'The largest audience is on a flow returning nothing at all.',
        recommendedAction: 'Rebalance sends toward the flow that converts, or fix the one that does not.',
        likelyPeople: ['Adi'],
        windowStart: null, windowEnd: null, observationCount: summary.flows.length,
        valueAtStake: Math.round((summary.best.revenuePerRecipient - bulk.revenuePerRecipient) * bulk.recipients),
        occurredAt: at, metadata: { spread },
      });
    }
  }

  // --- Engagement without revenue -------------------------------------------
  const stuck = summary.engagedButUnconverting[0];
  if (stuck) {
    out.push({
      signalType: 'revenue_opportunity',
      businessArea: 'marketing',
      sourceSystem: 'klaviyo',
      severity: 4,
      summary: `"${stuck.name}" is read but does not sell — ${Math.round(stuck.openRate * 100)}% open, ${Math.round(stuck.clickRate * 100)}% click, ${rpr(stuck.revenuePerRecipient)} a recipient.`,
      evidence: `${stuck.recipients.toLocaleString()} recipients produced ${money(stuck.revenue)}. The content is working; the offer or the landing page is not.`,
      recommendedAction: 'The fix is downstream of the email, not in the email.',
      likelyPeople: ['Adi'],
      windowStart: null, windowEnd: null, observationCount: summary.flows.length,
      valueAtStake: null, occurredAt: at, metadata: { flowId: stuck.flowId },
    });
  }

  // --- Share of business ----------------------------------------------------
  // Context, not alarm: it tells the CEO how much attention the channel is
  // worth at all.
  const total = opts.totalBusinessRevenue ?? null;
  if (total && total > 0) {
    const share = summary.totalRevenue / total;
    if (share < 0.05) {
      out.push({
        signalType: 'email_performance',
        businessArea: 'marketing',
        sourceSystem: 'klaviyo',
        severity: 3,
        summary: `Email flows returned ${money(summary.totalRevenue)}, about ${(share * 100).toFixed(1)}% of revenue.`,
        evidence: `${summary.totalRecipients.toLocaleString()} sends at ${rpr(summary.averageRevenuePerRecipient)} a recipient across ${summary.flows.length} flows.`,
        recommendedAction: 'Small enough that it is a delegation, not a CEO project.',
        likelyPeople: [],
        windowStart: null, windowEnd: null, observationCount: summary.flows.length,
        valueAtStake: summary.totalRevenue, occurredAt: at, metadata: { share },
      });
    }
  }

  return out;
}
