#!/usr/bin/env tsx
/**
 * Validate config/*.yaml.
 *
 * Run in CI and before deploying. Config errors must surface here, not as
 * strange routing behaviour three weeks later.
 */
import { loadConfig, ConfigError } from '../src/config/load.js';
import { teamModelFromConfig } from '../src/capabilities/graph.js';

function main(): number {
  let config;
  try {
    config = loadConfig(undefined, { force: true });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const team = teamModelFromConfig(config);
  const people = team.allPeople();
  const orgs = team.allOrganizations();
  const capabilities = team.allCapabilities();

  console.log('✓ config valid\n');
  console.log(`  people        ${people.length}`);
  console.log(`  organizations ${orgs.length}`);
  console.log(`  capabilities  ${capabilities.length}`);
  console.log(`  routing hints ${config.routingRules.hints.length}`);

  // Warnings, not errors: these are worth knowing about but do not make the
  // configuration invalid.
  const warnings: string[] = [];

  const uncovered = capabilities.filter(
    (cap) => !people.some((p) => p.capabilities.some((e) => e.capability === cap.name)),
  );
  if (uncovered.length) {
    warnings.push(
      `${uncovered.length} capabilities have no person: ${uncovered.map((c) => c.name).join(', ')}. ` +
      'Work requiring these cannot be routed to anyone internal.',
    );
  }

  const noAliases = people.filter((p) => p.internalExternal === 'internal' && p.aliases.length === 0);
  if (noAliases.length) {
    warnings.push(
      `${noAliases.length} internal people have no aliases (${noAliases.map((p) => p.slug).join(', ')}). ` +
      'Their canonical name still resolves, but any other display name they appear under in Zoom or ' +
      'Slack will not — add aliases once their real display names are observed.',
    );
  }

  const noEmail = people.filter((p) => !p.email);
  if (noEmail.length) {
    warnings.push(
      `${noEmail.length} people have no email address. Mail-based identity resolution will fall back ` +
      'to alias matching until directory sync runs.',
    );
  }

  const orgsWithoutDomains = orgs.filter(
    (o) => o.organizationType !== 'internal' && o.domains.length === 0,
  );
  if (orgsWithoutDomains.length) {
    warnings.push(
      `${orgsWithoutDomains.length} external organizations have no email domains ` +
      `(${orgsWithoutDomains.map((o) => o.slug).join(', ')}). Correspondence from them will not ` +
      'be attributed to the organization automatically.',
    );
  }

  if (warnings.length) {
    console.log('\n⚠ warnings\n');
    for (const w of warnings) console.log(`  • ${w}`);
  }

  console.log();
  return 0;
}

process.exit(main());
