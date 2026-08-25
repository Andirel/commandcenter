/**
 * Configuration integrity.
 *
 * These tests protect the properties that make the system safe to change: that
 * config is validated at boot, that the enums match the database, and that the
 * team model can grow without a code change.
 */
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig, checkReferentialIntegrity, ConfigError, CONFIG_DIR, REPO_ROOT } from '../src/config/load.js';
import { teamModelFromConfig } from '../src/capabilities/graph.js';
import { config, team } from './helpers.js';
import * as core from '../src/schemas/core.js';

describe('loading and validation', () => {
  it('loads the shipped configuration', () => {
    expect(Object.keys(config.people.people).length).toBeGreaterThan(0);
    expect(checkReferentialIntegrity(config)).toEqual([]);
  });

  it('rejects a person claiming a capability that does not exist', () => {
    const broken = structuredClone(config);
    broken.people.people.adi!.capabilities.nonexistent_capability = {
      confidence: 0.9, proficiency: 0.9, level: 'primary', confirmed: true,
    };
    const errors = checkReferentialIntegrity(broken);
    expect(errors.some((e) => e.includes('nonexistent_capability'))).toBe(true);
  });

  it('rejects a rule naming a person who does not exist', () => {
    const broken = structuredClone(config);
    broken.routingRules.leverage.person = 'ghost';
    expect(checkReferentialIntegrity(broken).some((e) => e.includes('ghost'))).toBe(true);
  });

  it('rejects an organization owned by an unknown person', () => {
    const broken = structuredClone(config);
    broken.organizations.organizations.quartile!.relationship_owner = 'nobody';
    expect(checkReferentialIntegrity(broken).some((e) => e.includes('nobody'))).toBe(true);
  });

  it('fails loudly on malformed YAML rather than starting up degraded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    cpSync(CONFIG_DIR, dir, { recursive: true });
    writeFileSync(join(dir, 'people.yaml'), 'people:\n  adi:\n    - this is not a mapping\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });
});

describe('enum parity with the database', () => {
  // The Zod enums in src/schemas/core.ts mirror the Postgres enums in
  // migration 0001. When one changes without the other, routing writes values
  // the database rejects at 3am rather than in CI.
  const migration = readFileSync(join(REPO_ROOT, 'database/migrations/0001_extensions_and_enums.sql'), 'utf8');

  function sqlEnumValues(typeName: string): string[] {
    const re = new RegExp(`create type ${typeName} as enum \\(([^)]*)\\)`, 'i');
    const m = re.exec(migration);
    if (!m) throw new Error(`enum ${typeName} not found in migration 0001`);
    return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  }

  const pairs: Array<[string, readonly string[]]> = [
    ['organization_type', core.OrganizationType.options],
    ['discovery_status', core.DiscoveryStatus.options],
    ['relationship_type', core.RelationshipType.options],
    ['task_status', core.TaskStatus.options],
    ['action_mode', core.ActionMode.options],
    ['commitment_status', core.CommitmentStatus.options],
    ['commitment_direction', core.CommitmentDirection.options],
    ['source_system', core.SourceSystem.options],
    ['processing_status', core.ProcessingStatus.options],
    ['match_decision', core.MatchDecision.options],
    ['approval_class', core.ApprovalClass.options],
    ['leverage_class', core.LeverageClass.options],
    ['correction_type', core.CorrectionType.options],
    ['primary_secondary', core.PrimarySecondary.options],
    ['initiative_status', core.InitiativeStatus.options],
    ['attendance_type', core.AttendanceType.options],
  ];

  for (const [sqlType, tsValues] of pairs) {
    it(`${sqlType} matches its TypeScript enum`, () => {
      expect([...tsValues].sort()).toEqual(sqlEnumValues(sqlType).sort());
    });
  }
});

describe('the team model grows without code changes', () => {
  it('routes to a person added purely through configuration', () => {
    const extended = structuredClone(config);
    extended.people.people.dana = {
      name: 'Dana',
      role: 'Amazon Creative Contractor',
      internal: false,
      relationship_type: 'contractor',
      discovery_status: 'confirmed',
      importance: 3,
      broad_generalist: false,
      eligible_for_all_areas: false,
      leverage_candidate: false,
      aliases: ['Dana R.'],
      capabilities: {
        graphic_design: { confidence: 0.95, proficiency: 0.95, level: 'primary', confirmed: true },
      },
      collaborates_with: [],
      notes: [],
    };

    expect(checkReferentialIntegrity(extended)).toEqual([]);

    const extendedTeam = teamModelFromConfig(extended);
    const candidates = extendedTeam.candidatesFor(['graphic_design'], { includeExternal: true });
    // Stronger than the incumbent designer on this capability, so she leads.
    expect(candidates[0]!.person.slug).toBe('dana');
    expect(extendedTeam.getPersonByAlias('Dana R.')?.slug).toBe('dana');
  });
});

describe('the shipped configuration says what it must', () => {
  it('keeps accounts payable and bookkeeping as distinct capabilities', () => {
    // The single most consequential role distinction at 120/Life.
    const peter = team.getPersonBySlug('peter')!;
    const brian = team.getPersonBySlug('brian')!;
    expect(team.match(peter.id, 'invoice_payments')).toBeDefined();
    expect(team.match(peter.id, 'bookkeeping')).toBeUndefined();
    expect(team.match(brian.id, 'bookkeeping')).toBeDefined();
    expect(team.match(brian.id, 'invoice_payments')).toBeUndefined();
  });

  it('leaves the CEO eligible to own work across every business area', () => {
    const adi = team.getPersonBySlug('adi')!;
    const areas = new Set(
      adi.capabilities
        .map((c) => team.getCapability(c.capability)?.businessArea)
        .filter(Boolean),
    );
    // Breadth is the point: a hands-on CEO is not confined to strategy.
    expect(areas.size).toBeGreaterThanOrEqual(8);
  });

  it('marks specialist capabilities the coordinator must not own', () => {
    const never = config.routingRules.leverage.never_owner_of_capabilities;
    for (const cap of ['manufacturing', 'bookkeeping', 'invoice_payments', 'website', 'paid_media']) {
      expect(never).toContain(cap);
    }
  });

  it('ships with external sending disabled', () => {
    expect(config.approvalRules.global.external_sending_enabled).toBe(false);
    expect(config.approvalRules.global.draft_creation_enabled).toBe(false);
  });

  it('marks RED as never automatable', () => {
    expect(config.approvalRules.classes.RED!.never_automate).toBe(true);
  });

  it('has a migration file for every numbered step, in order', () => {
    const files = readdirSync(join(REPO_ROOT, 'database/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(6);
    files.forEach((file, i) => {
      expect(file.startsWith(String(i + 1).padStart(4, '0'))).toBe(true);
    });
  });
});
