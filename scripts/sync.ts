#!/usr/bin/env tsx
/**
 * Run a sync and emit the Command Center state document.
 *
 *   npx tsx scripts/sync.ts <pull-file.json> [--out dist/state.json]
 *
 * The pull file is produced by whatever holds the connectors — today a Claude
 * session, which reads Outlook and Zoom, normalizes the events, and supplies
 * its own interpretations. Shape:
 *
 *   {
 *     "window": { "from": "...", "to": "..." },
 *     "events": [ CanonicalEvent, ... ],
 *     "meetings": [ StateMeeting, ... ],
 *     "commitments": [ StateCommitment, ... ],
 *     "interpretations": { "<task>:<eventId>": { ...EventInterpretation } }
 *   }
 *
 * With ANTHROPIC_API_KEY set the interpretations block can be omitted and the
 * API performs them instead. With neither, the run is metadata-only and every
 * task is marked `interpreted: false` so the UI can say so plainly.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, REPO_ROOT } from '../src/config/load.js';
import { teamModelFromConfig } from '../src/capabilities/graph.js';
import { CanonicalEvent } from '../src/schemas/events.js';
import { SessionClient, defaultClient } from '../src/ai/client.js';
import type { StageContext, InterpretationRecord } from '../src/ai/stages.js';
import { runSync } from '../src/sync/run.js';
import { Ledger } from '../src/ledger/types.js';
import { applyViewerAnswers } from '../src/ledger/reconcile.js';
import { StateCommitment, StateMeeting, StateSignal, StateFinance, StateProposal } from '../src/sync/state.js';
import { readPnl, financeSignals, latestClosedIndex, type PnlNode } from '../src/signals/finance.js';
import { parseSalesRows, salesTrend, commerceSignals } from '../src/signals/commerce.js';
import { parseTrafficRows, trafficTrend, trafficSignals } from '../src/signals/traffic.js';
import { parseFlowReport, summarizeEmail, emailSignals } from '../src/signals/email.js';

const args = process.argv.slice(2);
/** Flags that take a value, so the positional pull path is not confused for one. */
const VALUED = new Set(['--out', '--ledger', '--now']);
const pullPath = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1] ?? ''));
const outIdx = args.indexOf('--out');
const outPath = resolve(outIdx >= 0 ? args[outIdx + 1]! : join(REPO_ROOT, 'dist', 'state.json'));
const ledgerIdx = args.indexOf('--ledger');
const ledgerPath = resolve(ledgerIdx >= 0 ? args[ledgerIdx + 1]! : join(REPO_ROOT, 'dist', 'ledger.json'));
/** Start over deliberately, rather than by forgetting where the file was. */
const fresh = args.includes('--fresh');

if (!pullPath) {
  console.error('usage: npx tsx scripts/sync.ts <pull-file.json> [--out <path>]');
  process.exit(1);
}

const pull = JSON.parse(readFileSync(resolve(pullPath), 'utf8')) as {
  window?: { from: string; to: string };
  events?: unknown[];
  meetings?: unknown[];
  commitments?: unknown[];
  interpretations?: Record<string, unknown>;
  /** Raw connector payloads; signals are derived here rather than hand-written. */
  proposals?: unknown[];
  finaloopPnl?: unknown;
  shopifySales?: { columns?: Array<{ name: string }>; rows?: unknown[][] };
  shopifySessions?: { columns?: Array<{ name: string }>; rows?: unknown[][] };
  klaviyoFlows?: unknown;
};

const config = loadConfig();
const team = teamModelFromConfig(config);

const events = (pull.events ?? []).map((e) => CanonicalEvent.parse(e));
const meetings = (pull.meetings ?? []).map((m) => StateMeeting.parse(m));
const commitments = (pull.commitments ?? []).map((c) => StateCommitment.parse(c));
const proposals = (pull.proposals ?? []).map((p) => StateProposal.parse(p));

// Derive financial and commerce signals from the raw payloads, so the same code
// runs here and in the browser rather than two drifting implementations.
// `--now` exists for rehearsing a sequence of days against real data; without
// it the run is anchored to the actual clock.
const nowIdx = args.indexOf('--now');
const now = nowIdx >= 0 ? new Date(args[nowIdx + 1]!) : new Date();
let signals: StateSignal[] = [];
let finance: StateFinance = null;
// Kept from the raw signal rather than read back off the parsed state shape,
// which deliberately carries no metadata.
let adSpendDelta: number | null = null;

if (Array.isArray(pull.finaloopPnl)) {
  const closeDay = config.financeRules.books.close_day_of_month;
  const snap = readPnl(pull.finaloopPnl as PnlNode[], now, closeDay);
  const ci = latestClosedIndex(snap.periods);
  const oi = snap.periods.length - 1;

  const closed = ci >= 0 ? {
    period: snap.periods[ci]!.label,
    netSales: snap.netSales[ci] ?? 0,
    netProfit: snap.netProfit[ci] ?? 0,
    paidAds: snap.paidAds[ci] ?? 0,
    priorPeriod: ci > 0 ? snap.periods[ci - 1]!.label : null,
    priorNetProfit: ci > 0 ? snap.netProfit[ci - 1] ?? null : null,
    dailyNetSales: snap.dailyNetSales[ci] ?? null,
    priorDailyNetSales: ci > 0 ? snap.dailyNetSales[ci - 1] ?? null : null,
  } : null;

  // The open month contributes REVENUE only; its expenses are incomplete.
  const openPeriod = oi >= 0 && !snap.periods[oi]!.closed ? snap.periods[oi]! : null;
  const open = openPeriod ? {
    period: openPeriod.label,
    daysElapsed: openPeriod.days,
    netSales: snap.netSales[oi] ?? 0,
    closesOn: closesOn(openPeriod.label, closeDay),
  } : null;

  finance = StateFinance.parse({ closed, open, dailySales: [], salesChangeRatio: null });

  const rawFinance = financeSignals(snap, {
    closeDay,
    uncategorizedFloor: config.financeRules.thresholds.uncategorized_floor,
  });
  // Captured from the RAW signal: the state shape deliberately carries no
  // metadata, so reading it back after parsing loses the figure.
  adSpendDelta = (rawFinance.find((x) => x.signalType === 'roas_decline')?.metadata as
    { adDelta?: number } | undefined)?.adDelta ?? null;
  signals = rawFinance.map((x) => StateSignal.parse(x));
}

/** Date on which the given month's books close, ISO date. */
function closesOn(label: string, closeDay: number): string {
  const [y, m] = label.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, closeDay)).toISOString().slice(0, 10);
}

// Funnel: the diagnostic separating a traffic problem from a site problem.
if (pull.shopifySessions?.rows?.length && finance) {
  const tt = trafficTrend(parseTrafficRows(pull.shopifySessions), 4);
  finance.traffic = {
    recentSessions: tt.recent.sessions, priorSessions: tt.prior.sessions,
    recentRate: tt.recent.rate, priorRate: tt.prior.rate,
    weeks: tt.recent.weeks, sigma: tt.conversionSigma,
    weekly: tt.complete.map((w) => ({ week: w.week, sessions: w.sessions, rate: w.conversionRate })),
  };
  signals = signals.concat(
    trafficSignals(tt, { adSpendChangeRatio: adSpendDelta }).map((s) => StateSignal.parse(s)));
}

// Email, judged on revenue per recipient rather than open rate.
if (pull.klaviyoFlows && finance) {
  const summary = summarizeEmail(parseFlowReport(pull.klaviyoFlows));
  if (summary.flows.length) {
    finance.email = {
      totalRevenue: summary.totalRevenue,
      totalRecipients: summary.totalRecipients,
      windowDays: 30,
      flows: summary.flows.map((f) => ({
        name: f.name, recipients: f.recipients, revenue: f.revenue,
        revenuePerRecipient: f.revenuePerRecipient, openRate: f.openRate, clickRate: f.clickRate,
      })),
    };
    signals = signals.concat(emailSignals(summary, {
      totalBusinessRevenue: finance.open?.netSales ?? null,
    }).map((s) => StateSignal.parse(s)));
  }
}

if (pull.shopifySales?.rows?.length) {
  const trend = salesTrend(parseSalesRows(pull.shopifySales));
  if (finance) {
    finance.dailySales = trend.complete.map((d) => ({ day: d.day, value: d.totalSales }));
    finance.salesChangeRatio = trend.changeRatio;
  }
  signals = signals.concat(commerceSignals(trend).map((s) => StateSignal.parse(s)));
}

// Client selection, most capable first.
const log: InterpretationRecord[] = [];
let ai: StageContext | undefined;

if (pull.interpretations && Object.keys(pull.interpretations).length) {
  ai = { client: new SessionClient(pull.interpretations), config, log };
} else {
  const api = defaultClient();
  if (api) ai = { client: api, config, log };
}

/*
 * Memory. Absent on the first run, which is the honest case: everything is
 * new, nothing can have been completed, and the page says "first sync" rather
 * than presenting fourteen items as fourteen changes.
 */
let priorLedger: Ledger | undefined;
if (!fresh && existsSync(ledgerPath)) {
  try {
    priorLedger = Ledger.parse(JSON.parse(readFileSync(ledgerPath, 'utf8')));
  } catch (err) {
    // A corrupt ledger must not take the morning down, but losing memory is
    // not a silent event either.
    console.error(`! ledger at ${ledgerPath} unreadable (${(err as Error).message}); starting fresh`);
  }
}

/*
 * Answers given in the page, folded in before the run.
 *
 * Corrections made by hand are the only channel through which the system
 * learns it was wrong. Rebuilding without reading them would ask the same
 * question every morning and quietly discard every answer.
 */
const viewerPath = join(REPO_ROOT, 'dist', 'viewer-state.json');
if (priorLedger && existsSync(viewerPath)) {
  try {
    const viewer = JSON.parse(readFileSync(viewerPath, 'utf8')) as {
      completed?: Record<string, { at?: string; by?: string }>;
      stillOpen?: Record<string, string>;
    };
    const applied = applyViewerAnswers(priorLedger, viewer, now.toISOString());
    priorLedger = applied.ledger;
    if (applied.confirmed || applied.reopened) {
      console.log(`  answers folded in  ${applied.confirmed} confirmed, ${applied.reopened} said still live`);
    }
  } catch (err) {
    console.error(`! viewer state unreadable (${(err as Error).message}); answers not applied`);
  }
}

const { state, interpretations, ledger } = await runSync({
  events, meetings, commitments, signals, finance, proposals, config, team, now,
  ...(ai ? { ai } : {}),
  ...(pull.window ? { window: pull.window } : {}),
  ...(priorLedger ? { ledger: priorLedger } : {}),
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(state, null, 2), 'utf8');
mkdirSync(dirname(ledgerPath), { recursive: true });
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');

const c = state.counts;
console.log(`✓ ${outPath}`);
console.log(`\n  produced by      ${state.producedBy}`);
console.log(`  mail seen        ${c.mailSeen}`);
console.log(`  mail kept        ${c.mailKept}  (${c.mailSeen ? Math.round((c.mailKept / c.mailSeen) * 100) : 0}% survived triage)`);
console.log(`  meetings         ${c.meetingsSeen}`);
console.log(`  tasks created    ${c.tasksCreated}`);
console.log(`  duplicates       ${c.duplicatesMerged}`);
console.log(`  needs review     ${c.needsReview}`);
console.log(`  carried forward  ${c.carriedForward}`);
console.log(`  completed        ${c.completedThisRun}`);
console.log(`  commitments      ${state.commitments.length}`);
console.log(`  signals          ${state.signals.length}`);
console.log(`  proposals        ${state.proposals.length}`);
if (state.finance?.closed) {
  const c = state.finance.closed;
  console.log(`  books closed     ${c.period} — net ${Math.round(c.netProfit)}`);
}
if (state.finance?.open) {
  console.log(`  open month       ${state.finance.open.period} (${state.finance.open.daysElapsed}d in, closes ${state.finance.open.closesOn}) — revenue only`);
}
if (state.delta) {
  const d = state.delta;
  console.log(`\n  since ${d.since ?? 'the first sync'} (sync #${d.syncCount + 1}):`);
  console.log(`    new              ${d.added.length}`);
  console.log(`    completed        ${d.completed.length}`);
  console.log(`    awaiting confirm ${d.awaitingConfirmation.length}`);
  console.log(`    moved            ${d.moved.length}`);
  console.log(`    gone quiet       ${d.quiet.length}`);
  for (const x of d.completed) console.log(`      \u2713 ${x.title.slice(0, 58)}  \u2014 ${x.label}`);
  for (const x of d.awaitingConfirmation) console.log(`      ? ${x.title.slice(0, 58)}  \u2014 ${x.reason}`);
} else {
  console.log(`\n  first sync \u2014 no delta to report`);
}
if (state.followUps.length) {
  console.log(`\n  follow-ups due:`);
  for (const f of state.followUps) {
    console.log(`    ${String(f.businessDaysOverdue).padStart(3)}d  #${f.attempt}  ${(f.followUpOwner ?? '\u2014').padEnd(10)} ${f.description.slice(0, 54)}`);
  }
}
if (interpretations.length) {
  const bad = interpretations.filter((r) => !r.validationOk).length;
  console.log(`  ai calls         ${interpretations.length}${bad ? `  (${bad} failed validation)` : ''}`);
}
if (state.problems.length) {
  console.log('\n  problems:');
  for (const p of state.problems.slice(0, 5)) console.log(`    ${p.stage}: ${p.detail.slice(0, 120)}`);
}
console.log(`\n  top of queue:`);
for (const t of state.tasks.slice(0, 6)) {
  const mode = t.ceoActionMode ?? (t.leverageClass ?? '').replace('PAUL_CAN_', '');
  console.log(`    #${String(t.rank).padStart(2)}  ${String(t.score).padStart(6)}  ${(mode || '—').padEnd(10)} ${(t.primaryOwner ?? t.externalParty ?? '—').padEnd(10)} ${t.title.slice(0, 62)}`);
}
console.log();
