/**
 * Commerce signals from Shopify analytics.
 *
 * Finaloop answers "did we make money?" on booked accounting figures. Shopify
 * answers "what is happening right now?" at order level. Those are two
 * different bases and are deliberately not mixed — see the connector's own
 * guidance on order-level GMV versus booked P&L.
 */
import type { BusinessSignal } from '../schemas/signals.js';

/** A row from `FROM sales SHOW total_sales, orders, average_order_value TIMESERIES day`. */
export interface DailySales {
  day: string;
  totalSales: number;
  orders: number;
  averageOrderValue: number;
}

export interface SalesTrend {
  days: DailySales[];
  /** Excludes today, which is always partial and would read as a crash. */
  complete: DailySales[];
  last7Avg: number;
  prior7Avg: number;
  changeRatio: number;
  aovLast7: number;
  aovPrior7: number;
  aovChangeRatio: number;
}

/** Parse the connector's tabular result into typed rows. */
export function parseSalesRows(result: {
  columns?: Array<{ name: string }>;
  rows?: unknown[][];
}): DailySales[] {
  const cols = (result.columns ?? []).map((c) => c.name);
  const idx = (name: string) => cols.indexOf(name);
  const iDay = idx('day'), iSales = idx('total_sales'), iOrders = idx('orders'), iAov = idx('average_order_value');
  if (iDay < 0) return [];

  return (result.rows ?? []).map((r) => ({
    day: String(r[iDay] ?? ''),
    totalSales: num(r[iSales]),
    orders: Math.round(num(r[iOrders])),
    averageOrderValue: num(r[iAov]),
  })).filter((r) => r.day);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the trend, dropping the final day.
 *
 * Today is always partial — a morning read shows a fraction of the day and
 * would otherwise register as a collapse every single morning.
 */
export function salesTrend(days: DailySales[]): SalesTrend {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const complete = sorted.slice(0, -1);

  const last7 = complete.slice(-7);
  const prior7 = complete.slice(-14, -7);
  const avg = (xs: DailySales[], pick: (d: DailySales) => number) =>
    xs.length ? xs.reduce((s, d) => s + pick(d), 0) / xs.length : 0;

  const last7Avg = avg(last7, (d) => d.totalSales);
  const prior7Avg = avg(prior7, (d) => d.totalSales);
  const aovLast7 = avg(last7, (d) => d.averageOrderValue);
  const aovPrior7 = avg(prior7, (d) => d.averageOrderValue);

  return {
    days: sorted, complete, last7Avg, prior7Avg,
    changeRatio: prior7Avg > 0 ? (last7Avg - prior7Avg) / prior7Avg : 0,
    aovLast7, aovPrior7,
    aovChangeRatio: aovPrior7 > 0 ? (aovLast7 - aovPrior7) / aovPrior7 : 0,
  };
}

/** Only movements large enough to act on. Daily noise is not a signal. */
export function commerceSignals(trend: SalesTrend, opts: { occurredAt?: string } = {}): BusinessSignal[] {
  const out: BusinessSignal[] = [];
  const at = opts.occurredAt ?? new Date().toISOString();
  if (trend.complete.length < 10) return out;   // too little history to compare

  if (trend.changeRatio <= -0.15) {
    out.push({
      signalType: 'revenue_opportunity',
      businessArea: 'marketing',
      sourceSystem: 'quartile',
      severity: trend.changeRatio <= -0.25 ? 7 : 5,
      summary: `Daily sales are down ${Math.round(Math.abs(trend.changeRatio) * 100)}% on the previous week.`,
      evidence: `Last 7 complete days averaged $${Math.round(trend.last7Avg)} against $${Math.round(trend.prior7Avg)} the week before. Today is excluded as incomplete.`,
      recommendedAction: 'Check whether this tracks a spend change or a conversion problem.',
      likelyPeople: ['Adi'],
      windowStart: null, windowEnd: null, observationCount: trend.complete.length,
      valueAtStake: Math.round((trend.prior7Avg - trend.last7Avg) * 30),
      occurredAt: at, metadata: {},
    });
  }

  // AOV drifting down while orders hold means discounting or mix change, which
  // is a different problem from a traffic fall and has a different owner.
  if (trend.aovChangeRatio <= -0.08 && trend.changeRatio > -0.15) {
    out.push({
      signalType: 'customer_experience',
      businessArea: 'marketing',
      sourceSystem: 'quartile',
      severity: 4,
      summary: `Average order value is down ${Math.round(Math.abs(trend.aovChangeRatio) * 100)}% while order volume holds.`,
      evidence: `AOV $${trend.aovLast7.toFixed(0)} against $${trend.aovPrior7.toFixed(0)} the prior week.`,
      recommendedAction: 'Usually discounting or product mix rather than demand.',
      likelyPeople: ['Adi'],
      windowStart: null, windowEnd: null, observationCount: trend.complete.length,
      valueAtStake: null, occurredAt: at, metadata: {},
    });
  }

  return out;
}
