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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, REPO_ROOT } from '../src/config/load.js';
import { teamModelFromConfig } from '../src/capabilities/graph.js';
import { CanonicalEvent } from '../src/schemas/events.js';
import { SessionClient, defaultClient } from '../src/ai/client.js';
import type { StageContext, InterpretationRecord } from '../src/ai/stages.js';
import { runSync } from '../src/sync/run.js';
import { StateCommitment, StateMeeting, StateSignal, StateFinance } from '../src/sync/state.js';
import { readPnl, financeSignals, type PnlNode } from '../src/signals/finance.js';
import { parseSalesRows, salesTrend, commerceSignals } from '../src/signals/commerce.js';

const args = process.argv.slice(2);
const pullPath = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outPath = resolve(outIdx >= 0 ? args[outIdx + 1]! : join(REPO_ROOT, 'dist', 'state.json'));

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
  finaloopPnl?: unknown;
  shopifySales?: { columns?: Array<{ name: string }>; rows?: unknown[][] };
};

const config = loadConfig();
const team = teamModelFromConfig(config);

const events = (pull.events ?? []).map((e) => CanonicalEvent.parse(e));
const meetings = (pull.meetings ?? []).map((m) => StateMeeting.parse(m));
const commitments = (pull.commitments ?? []).map((c) => StateCommitment.parse(c));

// Derive financial and commerce signals from the raw payloads, so the same code
// runs here and in the browser rather than two drifting implementations.
const now = new Date();
let signals: StateSignal[] = [];
let finance: StateFinance = null;

if (Array.isArray(pull.finaloopPnl)) {
  const snap = readPnl(pull.finaloopPnl as PnlNode[], now);
  const i = snap.periods.length - 1;
  if (i >= 0) {
    const period = snap.periods[i]!;
    const daysInMonth = new Date(Date.UTC(
      Number(period.label.split('-')[0]), Number(period.label.split('-')[1]), 0)).getUTCDate();
    finance = StateFinance.parse({
      period: period.label,
      periodComplete: period.complete,
      daysElapsed: period.days,
      netSales: snap.netSales[i] ?? 0,
      netProfit: snap.netProfit[i] ?? 0,
      paidAds: snap.paidAds[i] ?? 0,
      priorNetProfit: i > 0 ? snap.netProfit[i - 1] ?? null : null,
      priorNetSales: i > 0 ? snap.netSales[i - 1] ?? null : null,
      priorDailyNetSales: i > 0 ? snap.dailyNetSales[i - 1] ?? null : null,
      dailyNetSales: snap.dailyNetSales[i] ?? null,
      projectedNetProfit: period.complete ? null : (snap.dailyNetProfit[i] ?? 0) * daysInMonth,
      dailySales: [],
      salesChangeRatio: null,
    });
    signals = financeSignals(snap).map((s) => StateSignal.parse(s));
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

const { state, interpretations } = await runSync({
  events, meetings, commitments, signals, finance, config, team,
  ...(ai ? { ai } : {}),
  ...(pull.window ? { window: pull.window } : {}),
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(state, null, 2), 'utf8');

const c = state.counts;
console.log(`✓ ${outPath}`);
console.log(`\n  produced by      ${state.producedBy}`);
console.log(`  mail seen        ${c.mailSeen}`);
console.log(`  mail kept        ${c.mailKept}  (${c.mailSeen ? Math.round((c.mailKept / c.mailSeen) * 100) : 0}% survived triage)`);
console.log(`  meetings         ${c.meetingsSeen}`);
console.log(`  tasks created    ${c.tasksCreated}`);
console.log(`  duplicates       ${c.duplicatesMerged}`);
console.log(`  needs review     ${c.needsReview}`);
console.log(`  commitments      ${state.commitments.length}`);
console.log(`  signals          ${state.signals.length}`);
if (state.finance) {
  const f = state.finance;
  console.log(`  finance          ${f.period}${f.periodComplete ? '' : ` (${f.daysElapsed}d in)`} — net ${Math.round(f.netProfit)}`);
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
