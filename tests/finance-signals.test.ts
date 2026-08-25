/**
 * Financial signals, pinned to a real 120/Life P&L shape.
 *
 * The property most worth defending here is the partial-month rule. Comparing
 * 25 days of one month against 31 of the previous produces a fictional crisis,
 * and a brief that cries wolf once is never read carefully again.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPnl, financeSignals, findNode, periodDays, money, pct, type PnlNode } from '../src/signals/finance.js';

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
    expect(periodDays('2026-07', AS_OF)).toEqual({ label: '2026-07', days: 31, complete: true });
    expect(periodDays('2026-06', AS_OF)).toEqual({ label: '2026-06', days: 30, complete: true });
  });

  it('counts only elapsed days of the running month, and marks it incomplete', () => {
    expect(periodDays('2026-08', AS_OF)).toEqual({ label: '2026-08', days: 24, complete: false });
  });

  it('does not report a sales collapse that is only missing days', () => {
    const s = readPnl(PNL, AS_OF);
    // Raw: 276,514 vs 356,984 looks like a 23% fall.
    const raw = (s.netSales[2]! - s.netSales[1]!) / s.netSales[1]!;
    expect(raw).toBeLessThan(-0.2);

    // Per day it is roughly flat, which is the truth.
    const perDay = (s.dailyNetSales[2]! - s.dailyNetSales[1]!) / s.dailyNetSales[1]!;
    expect(Math.abs(perDay)).toBeLessThan(0.06);

    // And no signal claims a sales problem.
    const signals = financeSignals(s);
    expect(signals.some((x) => /sales.*(down|collapse|fall)/i.test(x.summary))).toBe(false);
  });

  it('labels anything projected from an incomplete period as a run-rate', () => {
    const signals = financeSignals(readPnl(PNL, AS_OF));
    const margin = signals.find((s) => s.signalType === 'margin_issue')!;
    expect(margin.evidence).toContain('run-rate');
    expect(margin.metadata.complete).toBe(false);
  });
});

describe('the signals it produces from the real numbers', () => {
  const signals = financeSignals(readPnl(PNL, AS_OF));

  it('flags the swing from profit to loss', () => {
    const s = signals.find((x) => x.signalType === 'margin_issue')!;
    expect(s).toBeDefined();
    expect(s.severity).toBeGreaterThanOrEqual(7);
    expect(s.summary).toContain('swung to a loss');
    expect(s.likelyPeople).toContain('Adi');
  });

  it('flags ad spend rising faster than sales, compared per day', () => {
    const s = signals.find((x) => x.signalType === 'roas_decline')!;
    expect(s).toBeDefined();
    expect(s.evidence).toContain('per day');
    // Daily ads 2128 → 3437 is about +62%.
    expect(s.summary).toMatch(/up 6\d%/);
  });

  it('routes uncategorized spend to bookkeeping, never to accounts payable', () => {
    const s = signals.find((x) => x.signalType === 'expense_anomaly')!;
    expect(s).toBeDefined();
    expect(s.likelyPeople).toEqual(['Brian']);
    expect(s.likelyPeople).not.toContain('Peter');
  });

  it('produces only material signals, not one per line item', () => {
    expect(signals.length).toBeLessThanOrEqual(4);
  });
});

describe('restraint', () => {
  function withProfit(amounts: number[]): PnlNode[] {
    const clone = JSON.parse(JSON.stringify(PNL)) as PnlNode[];
    findNode(clone, 'Net Profit')!.amounts = amounts;
    return clone;
  }

  it('says nothing when the business is profitable and steady', () => {
    const tree = withProfit([30000, 32000, 26000]);
    const signals = financeSignals(readPnl(tree, AS_OF));
    expect(signals.some((s) => s.signalType === 'margin_issue')).toBe(false);
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
