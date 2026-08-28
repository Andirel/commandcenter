/**
 * Generate the agent architecture review.
 *
 *   npx tsx scripts/agent-architecture-review.ts              # the real ledger
 *   npx tsx scripts/agent-architecture-review.ts --fixture    # the synthetic year
 *   npx tsx scripts/agent-architecture-review.ts --json out.json
 *
 * The default is the real ledger, and on today's data it will tell you that it
 * cannot support an architecture. That is the intended output, not a failure:
 * the alternative is a report that reads identically whether it was built on
 * four days or four hundred, which is the specific thing the coverage gate
 * exists to prevent. `--fixture` runs the same pipeline against a constructed
 * history so the reasoning can be inspected at a size where it does something.
 *
 * Nothing here writes to the ledger, instantiates an agent, or takes an
 * external action. It reads and it prints.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ledger, emptyLedger } from '../src/ledger/types.js';
import { runArchitect, type ArchitectReport } from '../src/agents/architect.js';
import type { AgentProposal } from '../src/agents/registry.js';
import { syntheticLedger, syntheticNow } from '../tests/fixtures/synthetic-history.js';

const LEDGER_PATH = resolve(process.cwd(), 'dist/ledger.json');

function main(): void {
  const args = process.argv.slice(2);
  const useFixture = args.includes('--fixture');
  const jsonAt = args.indexOf('--json');

  const { ledger, now, sourceLabel } = useFixture
    ? { ledger: syntheticLedger(), now: syntheticNow(), sourceLabel: 'synthetic fixture history' }
    : loadRealLedger();

  const report = runArchitect({ ledger, now });
  process.stdout.write(render(report, sourceLabel));

  if (jsonAt >= 0) {
    const path = args[jsonAt + 1] ?? 'agent-architecture-review.json';
    writeFileSync(path, JSON.stringify(report, null, 2));
    process.stdout.write(`\nWrote ${path}\n`);
  }
}

function loadRealLedger(): { ledger: Ledger; now: Date; sourceLabel: string } {
  if (!existsSync(LEDGER_PATH)) {
    // Not an error. A first run has no memory yet, and the coverage gate will
    // say so more precisely than a thrown exception would.
    return { ledger: emptyLedger(), now: new Date(), sourceLabel: 'no ledger found' };
  }
  const ledger = Ledger.parse(JSON.parse(readFileSync(LEDGER_PATH, 'utf8')));
  return { ledger, now: new Date(), sourceLabel: `dist/ledger.json (${ledger.syncCount} syncs)` };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(r: ArchitectReport, sourceLabel: string): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);

  line();
  line(rule('='));
  line('AGENT ARCHITECTURE REVIEW');
  line(`Generated ${r.generatedAt} from ${sourceLabel}`);
  line(rule('='));

  // --- coverage first, because it governs how the rest should be read -------
  line();
  line(head('1. COVERAGE'));
  line(wrap(r.coverage.statement));
  line();
  line(`  Window        ${r.coverage.windowStart?.slice(0, 10) ?? '—'} → ${r.coverage.windowEnd?.slice(0, 10) ?? '—'} ` +
    `(${r.coverage.spanDays} days, active on ${r.coverage.activeDays})`);
  line(`  Volume        ${r.coverage.workItems} work items, ${r.coverage.commitments} commitments, ` +
    `${r.coverage.syncCount} syncs`);

  if (r.coverage.gaps.length) {
    line();
    line('  What is missing:');
    for (const g of r.coverage.gaps) line(wrap(g, '    - '));
  }
  if (r.coverage.biases.length) {
    line();
    line('  How this data could mislead:');
    for (const b of r.coverage.biases) line(wrap(b, '    - '));
  }
  line();
  line(wrap(r.readingGuidance, '  → '));

  // --- attention -----------------------------------------------------------
  line();
  line(head('2. WHERE CEO ATTENTION GOES'));
  line(`  ${r.attention.ceoIrreducibleCount} touches were his to make; ` +
    `${r.attention.ceoMoveableCount} were coordination he happened to be holding.`);
  line();
  for (const s of r.attention.ceoSinks.slice(0, 6)) {
    line(`  ${s.label}`);
    line(`    ${s.touches} touch${s.touches === 1 ? '' : 'es'} — ${s.irreducible} irreducible, ${s.moveable} moveable ` +
      `(drain ${s.drainScore}, median ${s.medianCycleDays}d)` +
      (s.couldMoveTo.length ? `, alongside ${s.couldMoveTo.join(', ')}` : ''));
  }

  // --- bottlenecks ---------------------------------------------------------
  line();
  line(head('3. WHERE WORK STOPS MOVING'));
  if (!r.bottlenecks.bottlenecks.length) {
    line('  Nothing recorded. On thin data that means unmeasured, not healthy.');
  }
  for (const b of r.bottlenecks.bottlenecks.slice(0, 8)) {
    line(`  [${b.severity}/10] ${b.kind.replace(/_/g, ' ')} — ${b.subject}`);
    line(wrap(b.summary, '    '));
    for (const e of b.evidence.slice(0, 2)) line(wrap(e, '      · '));
  }

  // --- proposals -----------------------------------------------------------
  line();
  line(head(`4. PROPOSED AGENTS (${r.proposals.length})`));
  if (!r.proposals.length) {
    line('  None. Nothing in this record clears the bar, which is the honest answer');
    line('  rather than an empty one.');
  }
  for (const p of r.proposals) line(proposal(p));

  // --- the deliberate non-agents -------------------------------------------
  line();
  line(head(`5. CONSIDERED AND NOT PROPOSED (${r.notAgents.length})`));
  line('  Three of the four verdicts mean nothing gets built. They are listed');
  line('  because a rejected candidate with a reason is worth more than a');
  line('  silence a reader has to reconstruct.');
  line();
  for (const group of ['capability', 'deterministic_workflow', 'not_worth_it'] as const) {
    const rows = r.notAgents.filter((p) => p.verdict === group);
    if (!rows.length) continue;
    line(`  ${group.replace(/_/g, ' ').toUpperCase()} (${rows.length})`);
    for (const p of rows) {
      line(`    ${p.name}${p.foldsInto ? `  → folds into ${p.foldsInto}` : ''}`);
      line(wrap(p.rationaleAgainst ?? '', '      '));
    }
    line();
  }

  // --- what happens next ---------------------------------------------------
  line(head('6. WHAT THIS DOES NOT DO'));
  line('  Nothing above is running. Every proposal is `proposed`, holds no');
  line('  permission to send, spend or change a production system, and cannot');
  line('  delegate to another agent. Instantiation requires an explicit human');
  line('  approval per agent, which is a separate step by design.');
  line();
  line(rule('='));
  line();

  return out.join('\n');
}

function proposal(p: AgentProposal): string {
  const out: string[] = [];
  out.push('');
  out.push(`  ${p.name}   [${p.approvalClass}]  leverage ${p.leverageNormalized}  confidence ${p.confidence}`);
  out.push(wrap(p.mission, '    '));
  out.push('');
  out.push(`    Human counterpart   ${p.humanCounterpart ?? '(none identified)'}`);
  out.push(`    Decisions stay with ${p.decisionMaker ?? '(unassigned)'}`);
  if (p.externalCounterparts.length) {
    out.push(`    External parties    ${p.externalCounterparts.join(', ')}`);
  }
  if (p.overlapsWith.length) {
    out.push(`    Absorbs             ${p.overlapsWith.join(', ')}`);
  }
  out.push(`    Permissions         ${p.permissions.join(', ')}`);
  out.push('');
  out.push('    Evidence:');
  for (const e of p.evidence) out.push(wrap(e, '      · '));
  out.push('');
  out.push('    Measured by:');
  for (const m of p.metrics) out.push(`      · ${m}`);
  if (p.estimatedCeoTouchesRemoved !== null) {
    out.push('');
    out.push(`    Would remove ${p.estimatedCeoTouchesRemoved} CEO coordination touches over the observed window.`);
  }
  return out.join('\n');
}

const WIDTH = 78;

function rule(c: string): string {
  return c.repeat(WIDTH);
}

function head(s: string): string {
  return `${s}\n${'-'.repeat(Math.min(WIDTH, s.length))}`;
}

/** Hard-wrap so the report is readable in a terminal and in a paste. */
function wrap(text: string, prefix = '  '): string {
  const indent = ' '.repeat(prefix.length);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    if (current && (prefix.length + current.length + 1 + w.length) > WIDTH) {
      lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);

  return lines.map((l, i) => (i === 0 ? prefix : indent) + l).join('\n');
}

main();
