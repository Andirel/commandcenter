/**
 * Tests for the Agent Architect.
 *
 * These assert CONCLUSIONS, not plumbing. It is easy to write a pattern
 * detector that runs; the whole risk in this subsystem is that it runs and is
 * confidently wrong — proposing an agent to duplicate an agency, splitting one
 * job into three, or building the architecture around the worst month the
 * company ever had. Each block below is one of those failures, expressed as
 * the shape that causes it and the verdict that must come back.
 *
 * The synthetic history in `fixtures/synthetic-history.ts` is the answer key.
 * The real ledger has four days in it, which is enough to prove the pipeline
 * executes and not enough to prove it concludes correctly — so the coverage
 * tests use the real thing and the judgment tests use the fixture.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runArchitect, AGENT_THRESHOLD, FOLD_SIMILARITY } from '../src/agents/architect.js';
import {
  assessCoverage, isRecurring, MIN_INSTANCES_PER_PATTERN, EXPECTED_SOURCES,
} from '../src/agents/coverage.js';
import { toWorkInstances, clusterWork } from '../src/agents/patterns.js';
import { analyzeAttention } from '../src/agents/attention.js';
import { analyzeBottlenecks } from '../src/agents/bottlenecks.js';
import {
  Agent, AgentProposal, FORBIDDEN_PERMISSIONS, PermissionError, RecursionError,
  assertPermitted, sanitizePermissions, assertCanDelegate, canTransition, transition,
} from '../src/agents/registry.js';
import { emptyLedger, Ledger } from '../src/ledger/types.js';
import { REPO_ROOT } from '../src/config/load.js';
import { syntheticLedger, syntheticNow, entry, recurring, at } from './fixtures/synthetic-history.js';

const ledger = syntheticLedger();
const now = syntheticNow();
const report = runArchitect({ ledger, now });

const forPattern = (patternId: string) =>
  [...report.proposals, ...report.notAgents].find((p) => p.patternIds.includes(patternId));

// ---------------------------------------------------------------------------
// Coverage — the gate everything else runs behind
// ---------------------------------------------------------------------------

describe('coverage gate', () => {
  it('refuses to call four days of history sufficient', () => {
    const thin = Ledger.parse({
      ...emptyLedger(),
      syncCount: 2,
      entries: ledger.entries.slice(0, 8).map((e) => ({
        ...e, firstSeenAt: at(295), lastActivityAt: at(298),
      })),
    });

    const coverage = assessCoverage({ ledger: thin });
    expect(coverage.verdict).toBe('insufficient');
    expect(coverage.statement).toMatch(/must not.*be read as a recommendation/i);
  });

  it('takes the worst dimension rather than averaging them', () => {
    // A long window containing almost nothing is not two-thirds of an answer.
    const longButEmpty = Ledger.parse({
      ...emptyLedger(),
      syncCount: 300,
      entries: [
        entry({ title: 'a', startDay: 0 }),
        entry({ title: 'b', startDay: 280 }),
      ],
    });
    expect(assessCoverage({ ledger: longButEmpty }).verdict).toBe('insufficient');
  });

  it('caps proposal confidence at what the evidence supports', () => {
    // Nothing may claim more than the coverage ceiling, however well it scored.
    expect(report.coverage.verdict).toBe('provisional');
    for (const p of [...report.proposals, ...report.notAgents]) {
      expect(p.confidence).toBeLessThanOrEqual(0.55);
    }
  });

  it('names the sources it is blind to rather than only what it found', () => {
    const coverage = assessCoverage({ ledger });
    for (const source of EXPECTED_SOURCES) {
      expect(coverage.gaps.some((g) => g.startsWith(`${source}:`))).toBe(true);
    }
    expect(coverage.gaps.some((g) => /sent mail is not captured/i.test(g))).toBe(true);
  });

  it('reports the reading guidance appropriate to the verdict', () => {
    expect(report.readingGuidance).toMatch(/hypothesis/i);
  });
});

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

describe('agent clustering', () => {
  it('groups work by what it is, not by what it was called', () => {
    const instances = toWorkInstances(ledger, now);
    const patterns = clusterWork(instances);

    // Twelve differently-numbered titles, one pattern.
    const retail = patterns.find((p) => p.id === 'cap:follow_up+retail');
    expect(retail).toBeDefined();
    expect(retail!.frequency).toBe(12 + 1); // twelve recurring plus the open packet
    expect(new Set(retail!.instances.map((i) => i.title)).size).toBeGreaterThan(1);
  });

  it('refuses to call a single occurrence a pattern', () => {
    expect(isRecurring(MIN_INSTANCES_PER_PATTERN - 1)).toBe(false);
    const oneOff = forPattern('cap:legal_coordination');
    expect(oneOff!.verdict).toBe('not_worth_it');
    expect(oneOff!.rationaleAgainst).toMatch(/anecdote/i);
  });

  it('proposes agents for genuinely recurring, attention-consuming work', () => {
    expect(report.proposals.length).toBeGreaterThan(0);
    for (const p of report.proposals) {
      expect(p.verdict).toBe('agent');
      expect(p.leverageNormalized).toBeGreaterThanOrEqual(AGENT_THRESHOLD);
      expect(p.evidence.length).toBeGreaterThan(0);
    }
  });

  it('does not turn everything into an agent', () => {
    // Three of the four verdicts mean nothing gets built. A report where they
    // never appear has skipped the only judgment that matters.
    expect(report.notAgents.length).toBeGreaterThan(report.proposals.length);
    const verdicts = new Set(report.notAgents.map((p) => p.verdict));
    expect(verdicts).toContain('capability');
    expect(verdicts).toContain('deterministic_workflow');
    expect(verdicts).toContain('not_worth_it');
  });

  it('prefers a script where there is no judgment to exercise', () => {
    const reconciliation = forPattern('cap:fulfillment');
    expect(reconciliation!.verdict).toBe('deterministic_workflow');
    expect(reconciliation!.rationaleAgainst).toMatch(/cannot be confidently wrong/i);
  });
});

// ---------------------------------------------------------------------------
// Fragmentation
// ---------------------------------------------------------------------------

describe('avoiding fragmentation', () => {
  it('folds a near-duplicate candidate into its strongest sibling', () => {
    const promo = forPattern('cap:coordination+follow_up+retail');
    const buyer = forPattern('cap:follow_up+retail');

    expect(buyer!.verdict).toBe('agent');
    expect(promo!.verdict).toBe('capability');
    expect(promo!.foldsInto).toBe(buyer!.slug);
    expect(promo!.rationaleAgainst).toMatch(/capability overlap/);
  });

  it('records the merge on the survivor too, so it is visible from both ends', () => {
    const buyer = forPattern('cap:follow_up+retail');
    const promo = forPattern('cap:coordination+follow_up+retail');
    expect(buyer!.overlapsWith).toContain(promo!.slug);
  });

  it('does not merge unrelated work that happens to share a business area', () => {
    // `operations` covers both a production run and order reconciliation.
    // Merging those would be worse than fragmenting them.
    const production = forPattern('cap:manufacturing+supply_chain');
    const reconciliation = forPattern('cap:fulfillment');
    expect(production!.foldsInto).toBeNull();
    expect(reconciliation!.foldsInto).toBeNull();
    expect(production!.overlapsWith).not.toContain(reconciliation!.slug);
  });

  it('keeps the fold threshold high enough to require real capability overlap', () => {
    expect(FOLD_SIMILARITY).toBeGreaterThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
// CEO burden and where it can move
// ---------------------------------------------------------------------------

describe('CEO burden', () => {
  const attention = analyzeAttention(clusterWork(toWorkInstances(ledger, now)));

  it('separates what the CEO must decide from what merely reaches him', () => {
    // The distinction the whole system is built on: needing the CEO is not the
    // same as being the CEO's job.
    expect(attention.ceoIrreducibleCount).toBeGreaterThan(0);
    expect(attention.ceoMoveableCount).toBeGreaterThan(0);

    const investor = attention.ceoSinks.find((s) => s.patternId === 'cap:strategy');
    expect(investor!.moveable).toBe(0);
    expect(investor!.irreducible).toBe(investor!.touches);
  });

  it('never proposes an agent for work that is entirely his judgment', () => {
    const investor = forPattern('cap:strategy');
    expect(investor!.verdict).not.toBe('agent');
    expect(investor!.rationaleAgainst).toMatch(/relocating accountability/i);
  });

  it('ranks the biggest coordination drain first', () => {
    expect(attention.ceoSinks[0]!.patternId).toBe('cap:follow_up+retail');
    expect(attention.ceoSinks[0]!.moveable).toBeGreaterThan(attention.ceoSinks[0]!.irreducible);
  });

  it('states how many CEO touches a proposal would actually remove', () => {
    const buyer = forPattern('cap:follow_up+retail');
    expect(buyer!.estimatedCeoTouchesRemoved).toBeGreaterThan(0);
  });

  it('declines to estimate hours saved, which nothing in the record supports', () => {
    for (const p of report.proposals) {
      expect(p.estimatedHoursSavedPerMonth).toBeNull();
    }
  });
});

describe('leverage to the coordinator', () => {
  it('names Paul as the counterpart for coordination-shaped CEO work', () => {
    const buyer = forPattern('cap:follow_up+retail');
    expect(buyer!.humanCounterpart).toBe('Paul');
  });

  it('explains that he is already on the work rather than being handed it', () => {
    const attention = analyzeAttention(clusterWork(toWorkInstances(ledger, now)));
    const opportunity = attention.leverageOpportunities.find(
      (l) => l.patternId === 'cap:follow_up+retail',
    );
    expect(opportunity!.currentParticipants).toContain('Paul');
    expect(opportunity!.reason).toMatch(/already on/i);
  });

  it('surfaces him as a continuity risk where he is the sole route through', () => {
    const attention = analyzeAttention(clusterWork(toWorkInstances(ledger, now)));
    const paul = attention.loadByPerson.find((l) => l.person === 'Paul');
    expect(paul!.soleOwnerPatterns).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Specialists
// ---------------------------------------------------------------------------

describe('specialist routing', () => {
  it('routes operational work to Mike, not to the coordinator', () => {
    const production = forPattern('cap:manufacturing+supply_chain');
    expect(production!.verdict).toBe('agent');
    expect(production!.humanCounterpart).toBe('Mike');
  });

  it('keeps a specialist agent scoped to its own capabilities', () => {
    const production = forPattern('cap:manufacturing+supply_chain');
    const buyer = forPattern('cap:follow_up+retail');
    expect(production!.slug).not.toBe(buyer!.slug);
    expect(production!.patternIds).not.toEqual(buyer!.patternIds);
  });

  it('flags a single point of failure once per person, not once per pattern', () => {
    const patterns = clusterWork(toWorkInstances(ledger, now));
    const bottlenecks = analyzeBottlenecks(ledger, patterns, { now });
    const singles = bottlenecks.bottlenecks.filter((b) => b.kind === 'single_point');
    const subjects = singles.map((b) => b.subject);

    expect(new Set(subjects).size).toBe(subjects.length);
    expect(subjects).toContain('Susan');
    expect(subjects).toContain('Mike');
  });
});

// ---------------------------------------------------------------------------
// External partners
// ---------------------------------------------------------------------------

describe('external partner modeling', () => {
  it('leaves RadioActive Media as a supplier rather than rebuilding it', () => {
    const podcast = forPattern('cap:podcast_advertising');
    expect(podcast!.verdict).toBe('not_worth_it');
    expect(podcast!.rationaleAgainst).toMatch(/RadioActive Media already performs/);
    expect(podcast!.rationaleAgainst).toMatch(/supplier relationship/i);
  });

  it('leaves Quartile external even when the pattern scores above the agent bar', () => {
    // The trap: an agency doing its job well produces exactly the
    // high-frequency, low-friction shape that scores well.
    const paid = report.scores.find((s) => s.patternId === 'cap:paid_media');
    const proposal = forPattern('cap:paid_media');
    expect(paid!.normalized).toBeGreaterThan(0.4);
    expect(proposal!.verdict).toBe('not_worth_it');
    expect(proposal!.rationaleAgainst).toMatch(/Quartile already performs/);
  });

  it('does not mistake a counterparty we chase for a supplier who works for us', () => {
    // Sprouts and Wegmans are external too, but the CEO is on every instance.
    const buyer = forPattern('cap:follow_up+retail');
    expect(buyer!.verdict).toBe('agent');
    expect(buyer!.externalCounterparts).toEqual(
      expect.arrayContaining(['Sprouts', 'Wegmans']),
    );
  });

  it('never lists an external organisation as an agent', () => {
    const externals = ['RadioActive Media', 'Quartile', 'Sprouts', 'Wegmans'];
    for (const p of report.proposals) {
      expect(externals).not.toContain(p.name);
      expect(p.humanCounterpart === null || !externals.includes(p.humanCounterpart)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Historical bias
// ---------------------------------------------------------------------------

describe('historical bias', () => {
  it('refuses to let one unusual fortnight define the architecture', () => {
    const copacker = forPattern('cap:manufacturing+production+vendor_coordination');
    expect(copacker!.verdict).toBe('not_worth_it');
    expect(copacker!.rationaleAgainst).toMatch(/episode/i);
  });

  it('rejects the episode even though it outranks patterns that are accepted', () => {
    // The whole point: frequency alone would have promoted it.
    const episode = report.scores.find(
      (s) => s.patternId === 'cap:manufacturing+production+vendor_coordination',
    )!;
    const accepted = report.scores.find((s) => s.patternId === 'cap:manufacturing+supply_chain')!;
    expect(episode.normalized).toBeGreaterThan(accepted.normalized);
    expect(forPattern(accepted.patternId)!.verdict).toBe('agent');
  });

  it('does not apply the episode rule when the window is too short to judge', () => {
    // On a two-week record everything is a burst; demoting for concentration
    // would reject the entire report.
    const short = Ledger.parse({
      ...emptyLedger(),
      syncCount: 12,
      entries: recurring(
        { title: 'Daily standup follow-ups', capabilities: ['coordination'], primaryOwner: 'Paul', durationDays: 1 },
        { firstDay: 0, everyDays: 1, times: 10 },
      ),
    });
    const shortReport = runArchitect({ ledger: short, now: new Date(at(12)) });
    for (const p of [...shortReport.proposals, ...shortReport.notAgents]) {
      expect(p.rationaleAgainst ?? '').not.toMatch(/episode/i);
    }
  });

  it('warns when the record itself is bursty', () => {
    expect(report.coverage.biases.some((b) => /bursty/i.test(b))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Safety: permissions
// ---------------------------------------------------------------------------

describe('agent permissions', () => {
  const agent = Agent.parse({
    id: 'agent-1',
    slug: 'retail_followthrough',
    name: 'Retail Follow-Through',
    mission: 'Keep retail buyer conversations moving.',
    objective: 'Reduce CEO coordination touches.',
    successDefinition: 'Median cycle time falls without follow-ups being missed.',
    permissions: ['READ_LEDGER', 'READ_OUTLOOK', 'CREATE_OUTLOOK_DRAFT', 'CREATE_TASK'],
    createdAt: at(0),
    updatedAt: at(0),
  });

  it('allows only what was granted', () => {
    expect(() => assertPermitted(agent, 'READ_LEDGER')).not.toThrow();
    expect(() => assertPermitted(agent, 'READ_ZOOM')).toThrow(PermissionError);
  });

  it('refuses a forbidden permission twice over: at the schema and at the call', () => {
    for (const forbidden of FORBIDDEN_PERMISSIONS) {
      // The enum has no such member, so an agent cannot be built holding one...
      expect(() => Agent.parse({ ...agent, permissions: [forbidden] })).toThrow();
      // ...and the guard refuses it anyway, without consulting the grant list.
      expect(() => assertPermitted(agent, forbidden)).toThrow(PermissionError);
    }
  });

  it('strips forbidden permissions before an agent can ever be built', () => {
    const { granted, refused } = sanitizePermissions([
      'READ_LEDGER', 'SEND_OUTLOOK_EMAIL', 'SPEND_MONEY', 'CREATE_TASK', 'INVENTED_PERMISSION',
    ]);
    expect(granted).toEqual(['READ_LEDGER', 'CREATE_TASK']);
    expect(refused).toEqual(['SEND_OUTLOOK_EMAIL', 'SPEND_MONEY', 'INVENTED_PERMISSION']);
  });

  it('grants no proposal the ability to send, spend or change production', () => {
    for (const p of [...report.proposals, ...report.notAgents]) {
      for (const forbidden of FORBIDDEN_PERMISSIONS) {
        expect(p.permissions as string[]).not.toContain(forbidden);
      }
      expect(p.disallowedActions.join(' ')).toMatch(/external communication/i);
    }
  });

  it('carries the most restrictive class any instance had, not the average', () => {
    // One RED instance makes the pattern RED. Averaging would let a stream of
    // routine work licence an agent to touch the one item that mattered.
    const investor = forPattern('cap:strategy');
    expect(investor!.approvalClass).toBe('RED');
  });

  it('does not let a proposal start running by being written down', () => {
    for (const p of [...report.proposals, ...report.notAgents]) {
      expect(p.status).toBe('proposed');
    }
    expect(canTransition('proposed', 'active')).toBe(false);
    expect(canTransition('proposed', 'approved')).toBe(true);
    expect(canTransition('retired', 'active')).toBe(false);
  });

  it('records who approved a proposal and when', () => {
    const proposal = report.proposals[0]!;
    const approved = transition(proposal, 'approved', 'Adi', 'Start with one.', at(300));
    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe('Adi');
    expect(() => transition(proposal, 'active', 'Adi', null, at(300))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Safety: recursion
// ---------------------------------------------------------------------------

describe('agent-to-agent recursion', () => {
  const base = {
    id: 'agent-a',
    slug: 'a',
    name: 'A',
    mission: 'm',
    objective: 'o',
    successDefinition: 's',
    createdAt: at(0),
    updatedAt: at(0),
  };

  const agentWith = (limits: Record<string, unknown>) =>
    Agent.parse({ ...base, limits: { maxSubjobs: 3, maxDepth: 2, allowedTargetAgents: ['b', 'c'], ...limits } });

  it('will not delegate deeper than its depth budget', () => {
    expect(() => assertCanDelegate(agentWith({}), 'b', 2, 0)).toThrow(RecursionError);
    expect(() => assertCanDelegate(agentWith({}), 'b', 1, 0)).not.toThrow();
  });

  it('will not fan out beyond its subjob budget', () => {
    expect(() => assertCanDelegate(agentWith({}), 'b', 0, 3)).toThrow(RecursionError);
  });

  it('will not delegate to an agent it was not allowed to reach', () => {
    expect(() => assertCanDelegate(agentWith({}), 'z', 0, 0)).toThrow(RecursionError);
  });

  it('will not close a cycle even inside the depth budget', () => {
    // A → B → A is the failure that burns money silently rather than loudly.
    expect(() => assertCanDelegate(agentWith({}), 'b', 0, 0, ['b', 'a'])).toThrow(/cycle/i);
  });

  it('defaults every proposal to no delegation at all', () => {
    for (const p of [...report.proposals, ...report.notAgents]) {
      expect(p.limits.allowedTargetAgents).toEqual([]);
      expect(p.limits.maxDepth).toBeLessThanOrEqual(2);
      expect(p.limits.budgetCents).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence discipline
// ---------------------------------------------------------------------------

describe('evidence discipline', () => {
  it('cannot produce a proposal that does not point at what it came from', () => {
    expect(() => AgentProposal.parse({
      id: 'x', slug: 'x', name: 'X', verdict: 'agent', mission: 'm', whyItExists: 'w',
      patternIds: [], evidence: [], leverageScore: 1, leverageNormalized: 0.9,
      proposedAt: at(0),
    })).toThrow();
  });

  it('says which dimensions it could not score rather than estimating them', () => {
    const scored = report.scores.find((s) => s.uncomputed.length > 0);
    expect(scored).toBeDefined();
    for (const name of scored!.uncomputed) {
      const dim = scored!.dimensions.find((d) => d.name === name)!;
      expect(dim.raw).toBe(0);
      expect(dim.computed).toBe(false);
      expect(dim.basis.length).toBeGreaterThan(0);
    }
  });

  it('gives every dimension a basis a human can check', () => {
    for (const s of report.scores) {
      for (const d of s.dimensions) expect(d.basis).toMatch(/\S/);
    }
  });

  it('runs on an empty ledger without inventing anything', () => {
    const empty = runArchitect({ ledger: emptyLedger(), now });
    expect(empty.coverage.verdict).toBe('insufficient');
    expect(empty.proposals).toEqual([]);
    expect(empty.readingGuidance).toMatch(/backfill/i);
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('the agent migration', () => {
  const sql = readFileSync(
    join(REPO_ROOT, 'database/migrations/0007_agents.sql'),
    'utf8',
  );

  it('is purely additive — it alters no existing table', () => {
    // The brief extends Command Center rather than replacing it. A migration
    // that reshapes `tasks` to suit a new subsystem is how a working system
    // acquires a second, incompatible model of the same thing.
    expect(sql).not.toMatch(/\balter\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+(table|column|type)\b/i);
  });

  it('is idempotent, like every migration before it', () => {
    const creates = sql.match(/create\s+(table|index)\b/gi) ?? [];
    const guarded = sql.match(/create\s+(table|index)\s+if\s+not\s+exists\b/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(creates.length);
  });

  it('refuses forbidden permissions at the database, not only in code', () => {
    for (const forbidden of FORBIDDEN_PERMISSIONS) {
      expect(sql).toContain(forbidden);
    }
    expect(sql).toMatch(/constraint\s+agents_no_forbidden_permissions/i);
    expect(sql).toMatch(/constraint\s+agent_proposals_no_forbidden_permissions/i);
  });

  it('will not let a proposal describe itself as running', () => {
    expect(sql).toMatch(/constraint\s+agent_proposals_not_running/i);
  });

  it('will not let an agent exist without a named human approver', () => {
    expect(sql).toMatch(/approved_by_person_id\s+uuid\s+not\s+null/i);
  });

  it('bounds recursion in the data, not only in the running process', () => {
    expect(sql).toMatch(/constraint\s+agents_depth_bounded/i);
    expect(sql).toMatch(/constraint\s+agent_jobs_depth_bounded/i);
    expect(sql).toMatch(/constraint\s+agent_jobs_not_own_parent/i);
  });

  it('keeps the basis of every impact figure alongside the figure', () => {
    expect(sql).toMatch(/impact_basis\s+impact_basis\s+not\s+null/i);
    expect(sql).toMatch(/baseline_cycle_days/i);
  });
});
