/**
 * Financial signals, pinned to a real 120/Life P&L shape.
 *
 * The property most worth defending here is the partial-month rule. Comparing
 * 25 days of one month against 31 of the previous produces a fictional crisis,
 * and a brief that cries wolf once is never read carefully again.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  readPnl, financeSignals, findNode, periodDays, isPeriodClosed, latestClosedIndex,
  money, pct, type PnlNode,
} from '../src/signals/finance.js';

const PNL = JSON.parse(
  readFileSync(new URL('./fixtures/finaloop-pnl.json', import.meta.url), 'utf8'),
) as PnlNode[];

// Aug 25: 24 complete days of a 31-day month.
const AS_OF = new Date('2026-08-25T09:00:00Z');

describe('reading the report tree', () => {
  it('finds a deeply nested node', () => {
    expect(findNode(PNL, 'Paid online ads')?.amount).toBeCloseTo(-200389.81);
  });

  it('finds a node by account name', () => {
    expect(findNode(PNL, 'Uncategorized transactions - money spent')).not.toBeNull();
  });

  it('returns null rather than throwing for an absent node', () => {
    expect(findNode(PNL, 'Nonexistent Line')).toBeNull();
  });

  it('extracts the series the engine needs', () => {
    const s = readPnl(PNL, AS_OF);
    expect(s.periods.map((p) => p.label)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(s.netProfit).toEqual([-11109.67, 33648.42, -53194.71]);
    expect(s.paidAds.map(Math.round)).toEqual([51923, 65976, 82490]);
  });
});

describe('the partial-month rule', () => {
  it('counts a completed month in full', () => {
    expect(periodDays('2026-07', AS_OF).days).toBe(31);
    expect(periodDays('2026-06', AS_OF).days).toBe(30);
  });

  it('counts only elapsed days of the running month, and marks it incomplete', () => {
    const p = periodDays('2026-08', AS_OF);
    expect(p.days).toBe(24);
    expect(p.complete).toBe(false);
  });

  it('does not report a sales collapse that is only missing days', () => {
    const s = readPnl(PNL, AS_OF);
    // Raw: 276,514 vs 356,984 looks like a 23% fall.
    expect((s.netSales[2]! - s.netSales[1]!) / s.netSales[1]!).toBeLessThan(-0.2);
    // Per day it is roughly flat, which is the truth.
    expect(Math.abs((s.dailyNetSales[2]! - s.dailyNetSales[1]!) / s.dailyNetSales[1]!)).toBeLessThan(0.06);
  });
});

describe('the unclosed-books rule', () => {
  // Books for month M close on the 10th of month M+1. Until then M's expense
  // side is incomplete, so no profit conclusion may be drawn from it.

  it('treats a month as closed from the closing day onward', () => {
    expect(isPeriodClosed('2026-07', new Date('2026-08-09T23:59:59Z'), 10)).toBe(false);
    expect(isPeriodClosed('2026-07', new Date('2026-08-10T00:00:00Z'), 10)).toBe(true);
    expect(isPeriodClosed('2026-07', AS_OF, 10)).toBe(true);
  });

  it('never treats the running month as closed', () => {
    expect(isPeriodClosed('2026-08', AS_OF, 10)).toBe(false);
    expect(periodDays('2026-08', AS_OF).closed).toBe(false);
  });

  it('handles the year boundary', () => {
    expect(isPeriodClosed('2026-12', new Date('2027-01-09T00:00:00Z'), 10)).toBe(false);
    expect(isPeriodClosed('2026-12', new Date('2027-01-10T00:00:00Z'), 10)).toBe(true);
  });

  it('picks the latest closed month as the basis', () => {
    const s = readPnl(PNL, AS_OF);
    expect(latestClosedIndex(s.periods)).toBe(1);          // 2026-07
    expect(s.periods[1]!.label).toBe('2026-07');
  });

  it('falls back a further month before the close date', () => {
    // On 2026-08-05 July has NOT closed yet, so June is the newest usable month.
    const s = readPnl(PNL, new Date('2026-08-05T09:00:00Z'));
    expect(s.periods[latestClosedIndex(s.periods)]!.label).toBe('2026-06');
  });

  it('draws NO conclusion from the open month', () => {
    // The open month reads as a $53k loss. The closed month made $34k. Reporting
    // the former as fact is the failure this rule exists to prevent.
    const signals = financeSignals(readPnl(PNL, AS_OF));
    expect(signals.some((x) => x.summary.includes('2026-08'))).toBe(false);
    expect(signals.every((x) => x.metadata.closed === true)).toBe(true);
  });

  it('does not flag uncategorized spend in an open month', () => {
    // $10k uncategorized in August is the NORMAL pre-close state. Flagging it
    // would raise a false alarm every single month.
    const signals = financeSignals(readPnl(PNL, AS_OF));
    expect(signals.some((x) => x.signalType === 'expense_anomaly')).toBe(false);
  });

  it('does flag uncategorized spend once the month has closed', () => {
    const clone = JSON.parse(JSON.stringify(PNL)) as PnlNode[];
    findNode(clone, 'Uncategorized transactions - money spent')!.amounts = [0, 12000, 0];
    const signals = financeSignals(readPnl(clone, AS_OF));
    const anomaly = signals.find((x) => x.signalType === 'expense_anomaly')!;
    expect(anomaly).toBeDefined();
    expect(anomaly.summary).toContain('2026-07');
    expect(anomaly.likelyPeople).toEqual(['Brian']);
  });
});

describe('the signals it produces from the real numbers', () => {
  const signals = financeSignals(readPnl(PNL, AS_OF));

  it('reports profit IMPROVING, because that is what the closed months show', () => {
    // June -$11k → July +$34k. The open month's apparent loss is not a signal.
    expect(signals.some((x) => x.signalType === 'margin_issue')).toBe(false);
  });

  it('flags ad spend rising faster than sales between closed months', () => {
    const s = signals.find((x) => x.signalType === 'roas_decline')!;
    expect(s).toBeDefined();
    // Daily ads 1731 → 2128 is +23%, not the +61% the open month suggested.
    expect(s.summary).toMatch(/rose 2\d% per day/);
    expect(s.summary).toContain('2026-06');
    expect(s.summary).toContain('2026-07');
    expect(s.evidence).toContain('Closed months only');
  });

  it('names the months it is talking about, so "now" is never assumed', () => {
    for (const s of signals) expect(s.summary).toMatch(/20\d\d-\d\d/);
  });

  it('produces only material signals', () => {
    expect(signals.length).toBeLessThanOrEqual(3);
  });
});

describe('restraint', () => {
  function withProfit(amounts: number[]): PnlNode[] {
    const clone = JSON.parse(JSON.stringify(PNL)) as PnlNode[];
    findNode(clone, 'Net Profit')!.amounts = amounts;
    return clone;
  }

  it('says nothing when the closed months were profitable', () => {
    const signals = financeSignals(readPnl(withProfit([30000, 32000, -99999]), AS_OF));
    expect(signals.some((s) => s.signalType === 'margin_issue')).toBe(false);
  });

  it('does flag a loss once the month it happened in has closed', () => {
    // July closed negative after a positive June.
    const signals = financeSignals(readPnl(withProfit([30000, -20000, 5000]), AS_OF));
    const margin = signals.find((s) => s.signalType === 'margin_issue')!;
    expect(margin).toBeDefined();
    expect(margin.summary).toContain('2026-07 closed at a loss');
  });

  it('ignores a percentage swing off a trivial base', () => {
    const clone = JSON.parse(JSON.stringify(PNL)) as PnlNode[];
    findNode(clone, 'Paid online ads')!.amounts = [-5, -10, -400];
    const signals = financeSignals(readPnl(clone, AS_OF));
    expect(signals.some((s) => s.signalType === 'roas_decline')).toBe(false);
  });

  it('handles an empty report without throwing', () => {
    expect(financeSignals(readPnl([], AS_OF))).toEqual([]);
  });
});

describe('formatting', () => {
  it('abbreviates money readably and keeps the sign', () => {
    expect(money(-53194.71)).toBe('-$53k');
    expect(money(8505)).toBe('$8.5k');
    expect(money(420)).toBe('$420');
  });
  it('formats percentages as whole numbers', () => {
    expect(pct(0.6234)).toBe('62%');
  });
});

// ---------------------------------------------------------------------------

import { parseSalesRows, salesTrend, commerceSignals } from '../src/signals/commerce.js';

/** Shape observed from `run-analytics-query` on the real store. */
const SALES_RESULT = {
  columns: [{ name: 'day' }, { name: 'total_sales' }, { name: 'orders' }, { name: 'average_order_value' }],
  rows: [
    ['2026-08-11', '9546.74', '132', '70.473'], ['2026-08-12', '8883.33', '134', '63.771'],
    ['2026-08-13', '7075.26', '111', '61.365'], ['2026-08-14', '6278.67', '120', '51.284'],
    ['2026-08-15', '5120.17', '97', '50.488'],  ['2026-08-16', '6059.01', '92', '62.783'],
    ['2026-08-17', '9408.38', '139', '66.027'], ['2026-08-18', '7304.52', '113', '61.763'],
    ['2026-08-19', '6522.40', '106', '58.839'], ['2026-08-20', '6547.66', '112', '57.111'],
    ['2026-08-21', '5581.72', '105', '50.663'], ['2026-08-22', '4855.49', '93', '49.637'],
    ['2026-08-23', '5684.01', '100', '54.527'], ['2026-08-24', '8505.24', '135', '59.506'],
    ['2026-08-25', '3086.20', '44', '67.038'],
  ],
};

describe('commerce signals', () => {
  it('parses the connector’s tabular result', () => {
    const rows = parseSalesRows(SALES_RESULT);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toEqual({ day: '2026-08-11', totalSales: 9546.74, orders: 132, averageOrderValue: 70.473 });
  });

  it('excludes today, which is always partial', () => {
    // 2026-08-25 shows $3,086 at 9am. Including it would report a crash every
    // single morning.
    const trend = salesTrend(parseSalesRows(SALES_RESULT));
    expect(trend.days).toHaveLength(15);
    expect(trend.complete).toHaveLength(14);
    expect(trend.complete.at(-1)!.day).toBe('2026-08-24');
  });

  it('compares like-for-like weeks', () => {
    const trend = salesTrend(parseSalesRows(SALES_RESULT));
    expect(trend.last7Avg).toBeGreaterThan(5000);
    expect(trend.prior7Avg).toBeGreaterThan(5000);
    // A modest real dip, not a fictional crash.
    expect(Math.abs(trend.changeRatio)).toBeLessThan(0.25);
  });

  it('stays quiet on ordinary weekly variation', () => {
    const trend = salesTrend(parseSalesRows(SALES_RESULT));
    const signals = commerceSignals(trend);
    expect(signals.every((s) => s.severity <= 5)).toBe(true);
  });

  it('says nothing when there is too little history to compare', () => {
    const short = { ...SALES_RESULT, rows: SALES_RESULT.rows.slice(0, 5) };
    expect(commerceSignals(salesTrend(parseSalesRows(short)))).toEqual([]);
  });

  it('flags a genuine sustained fall', () => {
    const rows = SALES_RESULT.rows.map((r, i) =>
      i >= 7 ? [r[0], String(Number(r[1]) * 0.6), r[2], r[3]] : r);
    const signals = commerceSignals(salesTrend(parseSalesRows({ ...SALES_RESULT, rows })));
    expect(signals.some((s) => /sales are down/.test(s.summary))).toBe(true);
  });
});
