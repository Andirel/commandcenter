/**
 * Traffic and conversion signals from Shopify sessions.
 *
 * This is the diagnostic that separates two very different problems:
 *   - spend rose but SESSIONS did not  → the money is not buying traffic
 *   - sessions held but CONVERSION fell → the site or the offer is the problem
 *
 * SAMPLING NOISE IS THE TRAP HERE. 120/Life converts roughly 2% of ~4,800
 * weekly sessions, so a week carries under 100 conversions. At that size a
 * swing from 1.5% to 2.6% can be pure chance. Flagging it as a trend produces a
 * crisis a week, so every comparison below is tested against its own standard
 * error rather than eyeballed.
 */
import type { BusinessSignal } from '../schemas/signals.js';

export interface WeeklyTraffic {
  week: string;
  sessions: number;
  checkouts: number;
  conversionRate: number;
}

export interface TrafficTrend {
  weeks: WeeklyTraffic[];
  /** Excludes the final week, which is partial. */
  complete: WeeklyTraffic[];
  recent: { sessions: number; checkouts: number; rate: number; weeks: number };
  prior: { sessions: number; checkouts: number; rate: number; weeks: number };
  sessionChangeRatio: number;
  conversionChangeRatio: number;
  /** Standard errors apart. Below ~3 the difference is not distinguishable from chance. */
  conversionSigma: number;
}

export function parseTrafficRows(result: {
  columns?: Array<{ name: string }>;
  rows?: unknown[][];
}): WeeklyTraffic[] {
  const cols = (result.columns ?? []).map((c) => c.name);
  const i = (n: string) => cols.indexOf(n);
  const iWeek = i('week'), iSess = i('sessions');
  const iCheck = i('sessions_that_completed_checkout'), iRate = i('conversion_rate');
  if (iWeek < 0) return [];

  return (result.rows ?? []).map((r) => ({
    week: String(r[iWeek] ?? ''),
    sessions: Math.round(num(r[iSess])),
    checkouts: Math.round(num(r[iCheck])),
    conversionRate: num(r[iRate]),
  })).filter((r) => r.week);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compare the last N complete weeks against the N before them.
 *
 * Blocks rather than single weeks: four weeks of sessions is a large enough
 * sample that the conversion rate stops jumping around, which is the only way
 * to tell a real move from a run of quiet Tuesdays.
 */
export function trafficTrend(weeks: WeeklyTraffic[], blockWeeks = 4): TrafficTrend {
  const sorted = [...weeks].sort((a, b) => a.week.localeCompare(b.week));
  // The last row is the week in progress.
  const complete = sorted.slice(0, -1);

  const recentRows = complete.slice(-blockWeeks);
  const priorRows = complete.slice(-blockWeeks * 2, -blockWeeks);

  const block = (rows: WeeklyTraffic[]) => {
    const sessions = rows.reduce((s, r) => s + r.sessions, 0);
    const checkouts = rows.reduce((s, r) => s + r.checkouts, 0);
    return { sessions, checkouts, rate: sessions > 0 ? checkouts / sessions : 0, weeks: rows.length };
  };

  const recent = block(recentRows);
  const prior = block(priorRows);

  // Two-proportion standard error on the conversion rates.
  const se = (p: number, n: number) => (n > 0 ? Math.sqrt((p * (1 - p)) / n) : 0);
  const combinedSe = Math.sqrt(se(recent.rate, recent.sessions) ** 2 + se(prior.rate, prior.sessions) ** 2);
  const conversionSigma = combinedSe > 0 ? Math.abs(recent.rate - prior.rate) / combinedSe : 0;

  return {
    weeks: sorted, complete, recent, prior,
    sessionChangeRatio: prior.sessions > 0
      ? (recent.sessions / Math.max(1, recent.weeks) - prior.sessions / Math.max(1, prior.weeks))
        / (prior.sessions / Math.max(1, prior.weeks))
      : 0,
    conversionChangeRatio: prior.rate > 0 ? (recent.rate - prior.rate) / prior.rate : 0,
    conversionSigma,
  };
}

/** Standard errors below which a conversion move is treated as chance. */
export const SIGMA_FLOOR = 3;

export interface TrafficSignalOptions {
  occurredAt?: string;
  /** Daily paid ad spend change over the same window, if known. */
  adSpendChangeRatio?: number | null;
}

export function trafficSignals(trend: TrafficTrend, opts: TrafficSignalOptions = {}): BusinessSignal[] {
  const out: BusinessSignal[] = [];
  const at = opts.occurredAt ?? new Date().toISOString();
  if (trend.recent.weeks < 2 || trend.prior.weeks < 2) return out;

  const pct = (r: number) => `${Math.round(Math.abs(r) * 100)}%`;
  const rate = (r: number) => `${(r * 100).toFixed(2)}%`;

  // --- Spend rising without traffic ----------------------------------------
  // The sharpest question available: if the money is not buying sessions, the
  // problem is upstream of the site entirely.
  const adDelta = opts.adSpendChangeRatio ?? null;
  if (adDelta !== null && adDelta >= 0.2 && Math.abs(trend.sessionChangeRatio) < 0.1) {
    out.push({
      signalType: 'roas_decline',
      businessArea: 'marketing',
      sourceSystem: 'quartile',
      severity: 7,
      summary: `Paid spend is up ${pct(adDelta)} but site sessions are flat.`,
      evidence: `Sessions averaged ${Math.round(trend.recent.sessions / trend.recent.weeks)} a week against ${Math.round(trend.prior.sessions / trend.prior.weeks)} before. Note that Amazon advertising drives Amazon sales, not site sessions, so ask for the channel split before drawing a conclusion.`,
      recommendedAction: 'Ask the agency how the increase split across channels, and what it bought.',
      likelyPeople: ['Adi'],
      windowStart: null, windowEnd: null, observationCount: trend.complete.length,
      valueAtStake: null, occurredAt: at, metadata: { sessionChangeRatio: trend.sessionChangeRatio },
    });
  }

  // --- Conversion moved, beyond noise --------------------------------------
  if (trend.conversionSigma >= SIGMA_FLOOR && Math.abs(trend.conversionChangeRatio) >= 0.1) {
    const worse = trend.conversionChangeRatio < 0;
    out.push({
      signalType: 'customer_experience',
      businessArea: 'technology',
      sourceSystem: 'quartile',
      severity: worse ? 7 : 4,
      summary: `Site conversion ${worse ? 'fell' : 'rose'} to ${rate(trend.recent.rate)} from ${rate(trend.prior.rate)}.`,
      evidence: `${trend.recent.weeks} weeks against the ${trend.prior.weeks} before, ${trend.recent.sessions.toLocaleString()} sessions. The difference is ${trend.conversionSigma.toFixed(1)} standard errors, so it is unlikely to be chance.`,
      recommendedAction: worse
        ? 'Traffic is arriving and not buying — check the site and the offer before spending more.'
        : 'Worth understanding what changed so it can be repeated.',
      likelyPeople: worse ? ['Mike', 'Adi'] : ['Adi'],
      windowStart: null, windowEnd: null, observationCount: trend.complete.length,
      valueAtStake: null, occurredAt: at,
      metadata: { sigma: trend.conversionSigma, rate: trend.recent.rate },
    });
  }

  return out;
}
