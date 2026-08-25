#!/usr/bin/env tsx
/**
 * Explain a routing decision from the command line.
 *
 * The fastest way to check whether the system understands how 120/Life works:
 * describe a piece of work and see who it goes to, and why.
 *
 *   npm run routing:explain -- "Retailer sent their vendor onboarding packet"
 *   npm run routing:explain -- "Invoice needs payment" --area finance
 *   npm run routing:explain -- "Podcast placement" --value 40000 --decision
 */
import { loadConfig } from '../src/config/load.js';
import { teamModelFromConfig } from '../src/capabilities/graph.js';
import { routeOwnership } from '../src/routing/owner-selection.js';
import { RoutingRequest } from '../src/schemas/routing.js';

const argv = process.argv.slice(2);

/** Options that consume the following argument as their value. */
const VALUED = new Set(['area', 'value', 'description']);

// Skip both the flag AND its value, or "--area operations" leaks "operations"
// into the task title and changes what is being routed.
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg.startsWith('--')) {
    if (VALUED.has(arg.slice(2))) i++;
    continue;
  }
  positional.push(arg);
}
const title = positional.join(' ').trim();

if (!title) {
  console.error('usage: npm run routing:explain -- "<task description>" [--area <area>] [--value <n>] [--decision] [--admin]');
  process.exit(1);
}

function flag(name: string): boolean { return argv.includes(`--${name}`); }
function option(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? null : null;
}

const config = loadConfig();
const team = teamModelFromConfig(config);
const valueRaw = option('value');

const request = RoutingRequest.parse({
  title,
  description: option('description'),
  businessArea: option('area'),
  valueAtStake: valueRaw ? Number(valueRaw) : null,
  isDecision: flag('decision'),
  isApproval: flag('approval'),
  isAdministrative: flag('admin'),
  isInformationGathering: flag('research'),
  isContractOrLegal: flag('legal'),
});

const decision = routeOwnership(request, { team, config });
const name = (id: string | null) => (id ? team.getPerson(id)?.name ?? id : '—');
const orgName = (id: string | null) => (id ? team.getOrganization(id)?.name ?? id : '—');

console.log(`\n"${title}"\n`);
console.log(`  Primary owner    ${name(decision.primaryOwnerPersonId)}`);
console.log(`  Project manager  ${name(decision.projectManagerPersonId)}`);
console.log(`  Decision maker   ${name(decision.decisionMakerPersonId)}`);
console.log(`  Approver         ${name(decision.approverPersonId)}`);
console.log(`  External party   ${orgName(decision.externalCounterpartyOrganizationId)}`);
console.log(`  Collaborators    ${decision.collaborators.map((c) => `${name(c.personId)} (${c.role})`).join(', ') || '—'}`);
console.log();
console.log(`  CEO required     ${decision.ceoRequired ? `yes — ${decision.ceoActionMode}` : 'no'}`);
console.log(`  CEO dependency   ${decision.ceoDependencyScore}/5`);
console.log(`  Leverage         ${decision.leverage.classification}`);
console.log(`  Approval class   ${decision.approvalClass}`);
console.log(`  Confidence       ${decision.confidence.toFixed(2)}${decision.needsReview ? '  (NEEDS REVIEW)' : ''}`);
console.log();
console.log(`  Reason: ${decision.reason}\n`);

if (flag('verbose')) {
  console.log('  Candidates:');
  for (const c of decision.candidates.slice(0, 6)) {
    const marker = c.disqualified ? '✗' : ' ';
    const detail = c.disqualified
      ? c.disqualificationReason
      : Object.entries(c.components).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${marker} ${(c.name ?? '').padEnd(10)} ${String(c.total).padStart(7)}  ${detail}`);
  }
  console.log();
}
