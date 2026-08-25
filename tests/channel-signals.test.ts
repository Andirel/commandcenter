/**
 * Traffic, conversion and email signals — pinned to real 120/Life shapes.
 *
 * Both modules exist to avoid the same failure in different clothes: reporting
 * a movement that is really sampling noise (conversion) or really an engagement
 * metric wearing a revenue costume (email).
 */
import { describe, expect, it } from 'vitest';
import { parseTrafficRows, trafficTrend, trafficSignals, SIGMA_FLOOR } from '../src/signals/traffic.js';
import { parseFlowReport, summarizeEmail, emailSignals } from '../src/signals/email.js';

/** Observed from `FROM sessions SHOW ... TIMESERIES week` on the real store. */
const TRAFFIC = {
  columns: [{ name: 'week' }, { name: 'sessions' },
            { name: 'sessions_that_completed_checkout' }, { name: 'conversion_rate' }],
  rows: [
    ['2026-06-22', '3987', '81', '0.0203'], ['2026-06-29', '5169', '77', '0.0149'],
    ['2026-07-06', '4829', '72', '0.0149'], ['2026-07-13', '4947', '91', '0.0184'],
    ['2026-07-20', '3735', '80', '0.0214'], ['2026-07-27', '4574', '118', '0.0258'],
    ['2026-08-03', '3997', '54', '0.0135'], ['2026-08-10', '5025', '134', '0.0267'],
    ['2026-08-17', '4800', '74', '0.0154'], ['2026-08-24', '710', '8', '0.0113'],
  ],
};

describe('traffic parsing and windows', () => {
  it('parses the tabular result', () => {
    const rows = parseTrafficRows(TRAFFIC);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ week: '2026-06-22', sessions: 3987, checkouts: 81 });
  });

  it('drops the week in progress', () => {
    // 710 sessions is a day and a half, not a bad week.
    const trend = trafficTrend(parseTrafficRows(TRAFFIC));
    expect(trend.complete).toHaveLength(9);
    expect(trend.complete.at(-1)!.week).toBe('2026-08-17');
  });

  it('compares blocks of weeks, not single weeks', () => {
    const trend = trafficTrend(parseTrafficRows(TRAFFIC), 4);
    expect(trend.recent.weeks).toBe(4);
    expect(trend.prior.weeks).toBe(4);
    expect(trend.recent.sessions).toBeGreaterThan(15000);
  });
});

describe('conversion noise', () => {
  it('does not call a real weekly swing a trend', () => {
    // Weekly rates run 1.35% to 2.67%. Judged weekly that is a crisis and a
    // recovery every fortnight; judged over four-week blocks it is flat.
    const trend = trafficTrend(parseTrafficRows(TRAFFIC), 4);
    expect(trend.conversionSigma).toBeLessThan(SIGMA_FLOOR);
    const signals = trafficSignals(trend);
    expect(signals.some((s) => /conversion/i.test(s.summary))).toBe(false);
  });

  it('does flag a move large enough to be real', () => {
    // Halve checkouts across the recent block: far beyond sampling error.
    const rows = TRAFFIC.rows.map((r, i) =>
      i >= 5 && i < 9 ? [r[0], r[1], String(Math.round(Number(r[2]) * 0.45)), r[3]] : r);
    const trend = trafficTrend(parseTrafficRows({ ...TRAFFIC, rows }), 4);
    expect(trend.conversionSigma).toBeGreaterThan(SIGMA_FLOOR);
    const signal = trafficSignals(trend).find((s) => /conversion fell/i.test(s.summary))!;
    expect(signal).toBeDefined();
    expect(signal.evidence).toContain('standard errors');
    expect(signal.likelyPeople).toContain('Mike');
  });

  it('says nothing without enough history', () => {
    const short = { ...TRAFFIC, rows: TRAFFIC.rows.slice(0, 3) };
    expect(trafficSignals(trafficTrend(parseTrafficRows(short), 4))).toEqual([]);
  });
});

describe('spend that does not buy traffic', () => {
  it('flags spend rising while sessions stay flat', () => {
    const trend = trafficTrend(parseTrafficRows(TRAFFIC), 4);
    const signal = trafficSignals(trend, { adSpendChangeRatio: 0.23 })
      .find((s) => /sessions are flat/i.test(s.summary))!;
    expect(signal).toBeDefined();
    // Must not overclaim: Amazon spend legitimately produces no site sessions.
    expect(signal.evidence).toContain('Amazon');
  });

  it('stays quiet when spend did not move', () => {
    const trend = trafficTrend(parseTrafficRows(TRAFFIC), 4);
    expect(trafficSignals(trend, { adSpendChangeRatio: 0.02 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/** Shape observed from the real `get_flow_report` response. */
const FLOWS = {
  data: { attributes: { flow_aggregation: [
    { flow_id: 'YsM9P9', flow_details: { attributes: { name: 'Subscriber Campaign Series' } },
      statistics: { recipients: 434, conversions: 41, conversion_value: 2836.68, open_rate: 0.4907, click_rate: 0.0602 } },
    { flow_id: 'WtZFtB', flow_details: { attributes: { name: 'Post Purchase (trialer)' } },
      statistics: { recipients: 2325, conversions: 25, conversion_value: 1785.65, open_rate: 0.3506, click_rate: 0.0248 } },
    { flow_id: 'TqXWqq', flow_details: { attributes: { name: 'Lapsed Trialers' } },
      statistics: { recipients: 2714, conversions: 11, conversion_value: 502.30, open_rate: 0.3311, click_rate: 0.0019 } },
    { flow_id: 'WHdhdM', flow_details: { attributes: { name: 'Recharge Rewards' } },
      statistics: { recipients: 458, conversions: 2, conversion_value: 72, open_rate: 0.5098, click_rate: 0.1335 } },
    { flow_id: 'RGMG8Y', flow_details: { attributes: { name: 'eBook Welcome Series' } },
      statistics: { recipients: 98, conversions: 0, conversion_value: 0, open_rate: 0.5918, click_rate: 0.1122 } },
  ] } },
};

describe('email judged on money, not engagement', () => {
  const summary = summarizeEmail(parseFlowReport(FLOWS));

  it('parses the aggregation block', () => {
    expect(summary.flows).toHaveLength(5);
    expect(Math.round(summary.totalRevenue)).toBe(5197);
  });

  it('ranks on revenue per recipient', () => {
    expect(summary.best!.name).toBe('Subscriber Campaign Series');
    expect(summary.best!.revenuePerRecipient).toBeGreaterThan(6);
    expect(summary.worst!.revenuePerRecipient).toBeLessThan(0.25);
  });

  it('catches the flow that is read and does not sell', () => {
    // 51% open, 13% click, $0.16 a recipient. On engagement it looks like the
    // best flow in the account.
    const names = summary.engagedButUnconverting.map((f) => f.name);
    expect(names).toContain('Recharge Rewards');
    expect(names).toContain('eBook Welcome Series');
    expect(names).not.toContain('Subscriber Campaign Series');
  });

  it('flags volume pointed at the weakest flow', () => {
    // The comparison is against the flow carrying the most SENDS, not the
    // lowest-returning one — a tiny dead flow costs nothing, and dividing by
    // its zero return would fail outright.
    const signal = emailSignals(summary).find((s) => /volume is going where/i.test(s.summary))!;
    expect(signal).toBeDefined();
    expect(signal.summary).toContain('Lapsed Trialers');
    expect(signal.summary).toContain('Subscriber Campaign Series');
    expect(signal.valueAtStake).toBeGreaterThan(10000);
  });

  it('survives a highest-volume flow that returns literally nothing', () => {
    const dead = { data: { attributes: { flow_aggregation: [
      { flow_id: 'a', flow_details: { attributes: { name: 'Good' } },
        statistics: { recipients: 200, conversions: 10, conversion_value: 1000, open_rate: 0.4, click_rate: 0.05 } },
      { flow_id: 'b', flow_details: { attributes: { name: 'Dead' } },
        statistics: { recipients: 5000, conversions: 0, conversion_value: 0, open_rate: 0.3, click_rate: 0.01 } },
    ] } } };
    const s2 = summarizeEmail(parseFlowReport(dead));
    const signal = emailSignals(s2).find((x) => /volume is going where/i.test(x.summary))!;
    expect(signal).toBeDefined();
    expect(signal.evidence).toContain('returning nothing at all');
  });

  it('reports the channel as small rather than urgent', () => {
    const signal = emailSignals(summary, { totalBusinessRevenue: 277000 })
      .find((s) => s.signalType === 'email_performance')!;
    expect(signal.severity).toBeLessThanOrEqual(3);
    expect(signal.recommendedAction).toContain('delegation');
  });

  it('ignores flows too small to judge', () => {
    const tiny = { data: { attributes: { flow_aggregation: [
      { flow_id: 'x', flow_details: { attributes: { name: 'Tiny' } },
        statistics: { recipients: 4, conversions: 1, conversion_value: 400, open_rate: 1, click_rate: 1 } },
    ] } } };
    // One order from four sends is $100 a recipient, and means nothing.
    expect(summarizeEmail(parseFlowReport(tiny)).best).toBeNull();
  });

  it('handles an empty report', () => {
    expect(emailSignals(summarizeEmail(parseFlowReport({})))).toEqual([]);
  });
});
