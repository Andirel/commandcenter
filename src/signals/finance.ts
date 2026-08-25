/**
 * Financial signals derived from a Finaloop P&L.
 *
 * We consume Finaloop's conclusions rather than rebuilding its ingestion, and
 * turn them into `BusinessSignal`s the priority engine already knows how to
 * weight (config/priority-rules.yaml → signal_multipliers, compound_rules).
 *
 * TWO SEPARATE TRAPS, both of which produce confident wrong headlines.
 *
 * 1. THE PARTIAL-MONTH TRAP. The current month is always incomplete. Comparing
 *    24 days of August against 31 of July shows a 23% "collapse" in sales that
 *    is really six missing days. So every comparison runs on a DAILY RATE.
 *
 * 2. THE UNCLOSED-BOOKS TRAP, which is worse. 120/Life closes its books monthly
 *    by the 10th of the following month. Until then the EXPENSE side is
 *    incomplete — bills not entered, transactions not categorized — so any
 *    profit figure from an open month is fiction dressed as fact.
 *
 *    On 2026-08-25 the open month read as a $53k loss with ad spend "up 61%".
 *    The closed months showed profit IMPROVING to $34k with spend up 23%.
 *    Nearly the opposite conclusion, from the same report.
 *
 * So: profit and expense conclusions come only from CLOSED periods. Revenue and
 * order-level activity are current and may be shown for the open month, clearly
 * marked as provisional. The policy lives in config/finance-rules.yaml.
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
  /** Elapsed days — the whole month once past, days-so-far while running. */
  days: number;
  /** The calendar month has finished. */
  complete: boolean;
  /**
   * The BOOKS for this month have closed, so its expense side is real.
   * Distinct from `complete`: August ends on the 31st but does not close until
   * September 10th, and between those dates its profit figure is not usable.
   */
  closed: boolean;
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

/**
 * Have the books for this month closed?
 *
 * Month M closes on day `closeDay` of month M+1. The boundary matters: on the
 * 9th the prior month is still open and its profit must not be reported as
 * fact; on the 10th it becomes usable.
 */
export function isPeriodClosed(label: string, asOf: Date, closeDay: number): boolean {
  const [yearStr, monthStr] = label.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return false;
  // Month is 1-based here, so Date.UTC(year, month, closeDay) is the closeDay of
  // the FOLLOWING month.
  return asOf.getTime() >= Date.UTC(year, month, closeDay);
}

/** Days in a period label, capped at `asOf` for the period still running. */
export function periodDays(label: string, asOf: Date, closeDay = 10): PnlPeriod {
  const [yearStr, monthStr] = label.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return { label, days: 30, complete: true, closed: false };
  }
  const closed = isPeriodClosed(label, asOf, closeDay);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isCurrent = asOf.getUTCFullYear() === year && asOf.getUTCMonth() + 1 === month;
  if (!isCurrent) return { label, days: daysInMonth, complete: true, closed };
  // The current day is itself partial; count elapsed days rather than including
  // a day that is only a few hours old.
  return { label, days: Math.max(1, asOf.getUTCDate() - 1), complete: false, closed };
}

/** Index of the most recent period whose books have closed, or -1. */
export function latestClosedIndex(periods: PnlPeriod[]): number {
  for (let i = periods.length - 1; i >= 0; i--) if (periods[i]!.closed) return i;
  return -1;
}

export function readPnl(tree: PnlNode[], asOf: Date, closeDay = 10): FinanceSnapshot {
  const labels = (findNode(tree, 'Net Profit')?.timeLabels
    ?? findNode(tree, 'Gross Profit')?.timeLabels
    ?? []) as string[];
  const periods = labels.map((l) => periodDays(l, asOf, closeDay));
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

export interface FinanceSignalOptions {
  occurredAt?: string;
  /** Day of the following month on which books close. */
  closeDay?: number;
  /** Minimum uncategorized spend worth flagging in a CLOSED month. */
  uncategorizedFloor?: number;
}

/**
 * Turn a snapshot into signals.
 *
 * Profit and expense conclusions are drawn ONLY from closed periods, and
 * compared against the previous closed period. An open month contributes
 * nothing here — its expense side is incomplete by definition, and a signal
 * built on it would be confidently wrong.
 *
 * Only material movements produce a signal. A financial panel that flags every
 * wobble fails the same way a task list that flags every email does.
 */
export function financeSignals(
  snapshot: FinanceSnapshot,
  opts: FinanceSignalOptions = {},
): BusinessSignal[] {
  const out: BusinessSignal[] = [];
  const at = opts.occurredAt ?? new Date().toISOString();
  const floor = opts.uncategorizedFloor ?? 1000;

  // The newest month whose expenses are real.
  const i = latestClosedIndex(snapshot.periods);
  if (i < 0) return out;

  const current = snapshot.periods[i]!;
  const prior = snapshot.periods[i - 1];
  const priorClosed = prior?.closed ? prior : undefined;

  // Say which month the conclusion is about. Without this the reader assumes
  // it describes now, which is the whole failure being avoided.
  const basis = `${current.label}, the latest closed month`;

  // --- Profitability -------------------------------------------------------
  const netProfit = snapshot.netProfit[i] ?? 0;
  const priorNetProfit = priorClosed ? snapshot.netProfit[i - 1] ?? 0 : null;

  if (netProfit < 0 && priorNetProfit !== null && priorNetProfit > 0) {
    out.push({
      signalType: 'margin_issue', businessArea: 'finance', sourceSystem: 'finaloop',
      severity: 8,
      summary: `${current.label} closed at a loss of ${money(netProfit)} after ${prior!.label} made ${money(priorNetProfit)}.`,
      evidence: `Net profit ${money(netProfit)} (${basis}).`,
      recommendedAction: 'Identify what moved — spend, sales rate, or one-off costs.',
      likelyPeople: ['Adi', 'Brian'],
      windowStart: null, windowEnd: null, observationCount: null,
      valueAtStake: Math.abs(netProfit), occurredAt: at,
      metadata: { period: current.label, closed: true },
    });
  } else if (netProfit < 0 && priorNetProfit !== null && priorNetProfit < 0) {
    out.push({
      signalType: 'margin_issue', businessArea: 'finance', sourceSystem: 'finaloop',
      severity: 6,
      summary: `${current.label} closed at a loss of ${money(netProfit)}, a second consecutive loss-making month.`,
      evidence: `Net profit ${money(netProfit)} (${basis}).`,
      recommendedAction: 'Consecutive losses; review the cost base rather than treating it as a one-off.',
      likelyPeople: ['Adi', 'Brian'],
      windowStart: null, windowEnd: null, observationCount: null,
      valueAtStake: Math.abs(netProfit), occurredAt: at,
      metadata: { period: current.label, closed: true },
    });
  }

  // --- Advertising efficiency ----------------------------------------------
  // Closed month against closed month, on a daily rate.
  if (priorClosed) {
    const adsNow = snapshot.dailyPaidAds[i] ?? 0;
    const adsPrior = snapshot.dailyPaidAds[i - 1] ?? 0;
    const salesNow = snapshot.dailyNetSales[i] ?? 0;
    const salesPrior = snapshot.dailyNetSales[i - 1] ?? 0;

    if (adsPrior * daysInPeriod(current) > MIN_PRIOR_BASE) {
      const adDelta = (adsNow - adsPrior) / adsPrior;
      const salesDelta = salesPrior > 0 ? (salesNow - salesPrior) / salesPrior : 0;

      if (adDelta >= 0.2 && salesDelta < adDelta - 0.15) {
        out.push({
          signalType: 'roas_decline', businessArea: 'marketing', sourceSystem: 'finaloop',
          severity: adDelta >= 0.5 ? 7 : 5,
          summary: `Paid ad spend rose ${pct(adDelta)} per day from ${prior!.label} to ${current.label} while sales were ${describeDelta(salesDelta)}.`,
          evidence: `Daily ad spend ${money(adsPrior)} → ${money(adsNow)}; daily net sales ${money(salesPrior)} → ${money(salesNow)}. Closed months only; compared per day.`,
          recommendedAction: 'Ask the agency what changed.',
          likelyPeople: ['Adi'],
          windowStart: null, windowEnd: null, observationCount: null,
          valueAtStake: (adsNow - adsPrior) * daysInPeriod(current), occurredAt: at,
          metadata: { period: current.label, adDelta, salesDelta, closed: true },
        });
      }
    }
  }

  // --- Bookkeeping hygiene --------------------------------------------------
  // Only in a CLOSED month. Uncategorized transactions are the normal state of
  // an open month; flagging them there raises a false alarm every month, which
  // teaches the reader to ignore the section.
  const uncategorized = snapshot.uncategorizedSpend[i] ?? 0;
  if (uncategorized >= floor) {
    out.push({
      signalType: 'expense_anomaly', businessArea: 'finance', sourceSystem: 'finaloop',
      severity: uncategorized >= 10000 ? 6 : 4,
      summary: `${money(uncategorized)} of spending in ${current.label} is uncategorized even though the month is closed.`,
      evidence: 'Uncategorized transactions in a closed month distort every figure derived from them.',
      recommendedAction: 'Categorize and restate.',
      likelyPeople: ['Brian'],
      windowStart: null, windowEnd: null, observationCount: null,
      valueAtStake: uncategorized, occurredAt: at,
      metadata: { period: current.label, closed: true },
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
