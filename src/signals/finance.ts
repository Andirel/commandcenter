/**
 * Financial signals derived from a Finaloop P&L.
 *
 * We consume Finaloop's conclusions rather than rebuilding its ingestion, and
 * turn them into `BusinessSignal`s the priority engine already knows how to
 * weight (config/priority-rules.yaml → signal_multipliers, compound_rules).
 *
 * THE PARTIAL-MONTH TRAP
 * The current month is always incomplete. Comparing 25 days of August against
 * 31 days of July shows a 23% "collapse" in sales that is really just six
 * missing days. A brief that reports that once is never trusted again. So every
 * comparison here runs on a DAILY RATE, and anything derived from an incomplete
 * period is labelled as a run-rate, never as an actual.
 */
import type { BusinessSignal } from '../schemas/signals.js';

/** One node of Finaloop's report tree. */
export interface PnlNode {
  name?: string;
  accountName?: string;
  accountRole?: string;
  amount?: number;
  amounts?: number[];
  timeLabels?: string[];
  children?: PnlNode[];
}

export interface PnlPeriod {
  /** e.g. "2026-08" */
  label: string;
  days: number;
  complete: boolean;
}

export interface FinanceSnapshot {
  periods: PnlPeriod[];
  netSales: number[];
  grossProfit: number[];
  netProfit: number[];
  paidAds: number[];
  payroll: number[];
  uncategorizedSpend: number[];
  /** Daily rates, which is the only fair basis for comparing periods. */
  dailyNetSales: number[];
  dailyNetProfit: number[];
  dailyPaidAds: number[];
}

/** Depth-first search for a node by its display name. */
export function findNode(tree: PnlNode[] | PnlNode, name: string): PnlNode | null {
  const nodes = Array.isArray(tree) ? tree : [tree];
  for (const node of nodes) {
    if (node.name === name || node.accountName === name) return node;
    if (node.children?.length) {
      const found = findNode(node.children, name);
      if (found) return found;
    }
  }
  return null;
}

function amountsOf(tree: PnlNode[], name: string, periods: number): number[] {
  const node = findNode(tree, name);
  if (!node?.amounts) return new Array(periods).fill(0);
  return node.amounts.map((n) => (Number.isFinite(n) ? n : 0));
}

/** Days in a period label, capped at `asOf` for the period still running. */
export function periodDays(label: string, asOf: Date): PnlPeriod {
  const [yearStr, monthStr] = label.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return { label, days: 30, complete: true };
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isCurrent = asOf.getUTCFullYear() === year && asOf.getUTCMonth() + 1 === month;
  if (!isCurrent) return { label, days: daysInMonth, complete: true };
  // The current day is itself partial; count elapsed days rather than including
  // a day that is only a few hours old.
  return { label, days: Math.max(1, asOf.getUTCDate() - 1), complete: false };
}

export function readPnl(tree: PnlNode[], asOf: Date): FinanceSnapshot {
  const labels = (findNode(tree, 'Net Profit')?.timeLabels
    ?? findNode(tree, 'Gross Profit')?.timeLabels
    ?? []) as string[];
  const periods = labels.map((l) => periodDays(l, asOf));
  const n = periods.length;

  const netSales = amountsOf(tree, 'Net Sales', n);
  const grossProfit = amountsOf(tree, 'Gross Profit', n);
  const netProfit = amountsOf(tree, 'Net Profit', n);
  const paidAds = amountsOf(tree, 'Paid online ads', n).map(Math.abs);
  const payroll = amountsOf(tree, 'Payroll', n).map(Math.abs);
  const uncategorizedSpend = amountsOf(tree, 'Uncategorized transactions - money spent', n).map(Math.abs);

  const perDay = (xs: number[]) => xs.map((v, i) => (periods[i]?.days ? v / periods[i]!.days : 0));

  return {
    periods, netSales, grossProfit, netProfit, paidAds, payroll, uncategorizedSpend,
    dailyNetSales: perDay(netSales),
    dailyNetProfit: perDay(netProfit),
    dailyPaidAds: perDay(paidAds),
  };
}

const MIN_PRIOR_BASE = 1000;   // ignore percentage swings off a trivial base

/**
 * Turn a snapshot into signals.
 *
 * Only material movements produce a signal. A financial panel that flags every
 * wobble is the same failure as a task list that flags every email.
 */
export function financeSignals(
  snapshot: FinanceSnapshot,
  opts: { occurredAt?: string } = {},
): BusinessSignal[] {
  const out: BusinessSignal[] = [];
  const at = opts.occurredAt ?? new Date().toISOString();
  const i = snapshot.periods.length - 1;
  if (i < 0) return out;

  const current = snapshot.periods[i]!;
  const prior = snapshot.periods[i - 1];
  const basis = current.complete ? 'so far this period' : `first ${current.days} days, run-rate basis`;

  // --- Profitability -------------------------------------------------------
  const netProfit = snapshot.netProfit[i] ?? 0;
  const priorNetProfit = snapshot.netProfit[i - 1] ?? 0;
  const projectedNetProfit = snapshot.dailyNetProfit[i]! * daysInPeriod(current);

  if (netProfit < 0 && priorNetProfit > 0) {
    out.push({
      signalType: 'margin_issue',
      businessArea: 'finance',
      sourceSystem: 'finaloop',
      severity: 8,
      summary: `${current.label} has swung to a loss of ${money(netProfit)} after ${prior?.label ?? 'the prior period'} made ${money(priorNetProfit)}.`,
      evidence: `Net profit ${money(netProfit)} (${basis}); on the current daily rate the full period lands near ${money(projectedNetProfit)}.`,
      recommendedAction: 'Identify what moved — spend, sales rate, or one-off costs — before the period closes.',
      likelyPeople: ['Adi', 'Brian'],
      windowStart: null, windowEnd: null, observationCount: null,
      valueAtStake: Math.abs(projectedNetProfit),
      occurredAt: at,
      metadata: { period: current.label, complete: current.complete },
    });
  } else if (netProfit < 0 && priorNetProfit < 0) {
    out.push({
      signalType: 'margin_issue',
      businessArea: 'finance',
      sourceSystem: 'finaloop',
      severity: 6,
      summary: `${current.label} is running at a loss of ${money(netProfit)}, a second consecutive loss-making period.`,
      evidence: `Net profit ${money(netProfit)} (${basis}).`,
      recommendedAction: 'Consecutive losses; review the cost base rather than treating it as a one-off.',
      likelyPeople: ['Adi', 'Brian'],
      windowStart: null, windowEnd: null, observationCount: null,
      valueAtStake: Math.abs(projectedNetProfit),
      occurredAt: at,
      metadata: { period: current.label, complete: current.complete },
    });
  }

  // --- Advertising efficiency ----------------------------------------------
  // Compared on a DAILY RATE. Raw month-over-month on a partial month is the
  // single easiest way to report a crisis that is not happening.
  const adsNow = snapshot.dailyPaidAds[i] ?? 0;
  const adsPrior = snapshot.dailyPaidAds[i - 1] ?? 0;
  const salesNow = snapshot.dailyNetSales[i] ?? 0;
  const salesPrior = snapshot.dailyNetSales[i - 1] ?? 0;

  if (adsPrior * daysInPeriod(current) > MIN_PRIOR_BASE) {
    const adDelta = (adsNow - adsPrior) / adsPrior;
    const salesDelta = salesPrior > 0 ? (salesNow - salesPrior) / salesPrior : 0;

    if (adDelta >= 0.25 && salesDelta < adDelta - 0.15) {
      out.push({
        signalType: 'roas_decline',
        businessArea: 'marketing',
        sourceSystem: 'finaloop',
        severity: adDelta >= 0.5 ? 8 : 6,
        summary: `Paid ad spend is up ${pct(adDelta)} per day on ${prior?.label ?? 'the prior period'} while sales are ${describeDelta(salesDelta)}.`,
        evidence: `Daily ad spend ${money(adsPrior)} → ${money(adsNow)}; daily net sales ${money(salesPrior)} → ${money(salesNow)}. Compared per day, not per period, because ${current.label} is incomplete.`,
        recommendedAction: 'Ask the agency what changed before spend compounds further.',
        likelyPeople: ['Adi'],
        windowStart: null, windowEnd: null, observationCount: null,
        valueAtStake: (adsNow - adsPrior) * daysInPeriod(current),
        occurredAt: at,
        metadata: { period: current.label, adDelta, salesDelta },
      });
    }
  }

  // --- Bookkeeping hygiene --------------------------------------------------
  // Uncategorized spend is a bookkeeping gap, NOT a payment problem: it routes
  // to the bookkeeper, never to accounts payable.
  const uncategorized = snapshot.uncategorizedSpend[i] ?? 0;
  if (uncategorized >= 1000) {
    out.push({
      signalType: 'expense_anomaly',
      businessArea: 'finance',
      sourceSystem: 'finaloop',
      severity: uncategorized >= 10000 ? 6 : 4,
      summary: `${money(uncategorized)} of spending in ${current.label} is still uncategorized.`,
      evidence: 'Uncategorized transactions distort every figure derived from them until they are classified.',
      recommendedAction: 'Categorize before the period closes so the reported result is real.',
      likelyPeople: ['Brian'],
      windowStart: null, windowEnd: null, observationCount: null,
      valueAtStake: uncategorized,
      occurredAt: at,
      metadata: { period: current.label },
    });
  }

  return out;
}

/** Plain language for a change, so a flat series does not read as "up only 0%". */
function describeDelta(ratio: number): string {
  const magnitude = Math.abs(ratio);
  if (magnitude < 0.02) return 'flat';
  if (ratio < 0) return `down ${pct(magnitude)}`;
  return `up only ${pct(magnitude)}`;
}

function daysInPeriod(p: PnlPeriod): number {
  const [y, m] = p.label.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return 30;
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

export function money(n: number): string {
  const abs = Math.abs(Math.round(n));
  const s = abs >= 1000 ? `$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k` : `$${abs}`;
  return n < 0 ? `-${s}` : s;
}

export function pct(n: number): string {
  return `${Math.round(Math.abs(n) * 100)}%`;
}
