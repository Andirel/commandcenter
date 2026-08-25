/**
 * Configuration loader.
 *
 * Config is read once, validated against Zod, and cross-checked for
 * referential integrity (every capability a person claims must exist; every
 * person a rule names must exist). Invalid config fails loudly at boot.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  AiRoutingConfig, ApprovalRulesConfig, BusinessAreasConfig, CapabilitiesConfig,
  FollowupRulesConfig, OrganizationsConfig, PeopleConfig, PriorityRulesConfig,
  RoutingRulesConfig, SystemConfig,
} from '../schemas/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const CONFIG_DIR = join(REPO_ROOT, 'config');

export class ConfigError extends Error {
  constructor(readonly file: string, message: string) {
    super(`[config:${file}] ${message}`);
    this.name = 'ConfigError';
  }
}

// Generic over the schema itself so the inferred type is Zod's OUTPUT type
// (defaults applied), not its input type.
function loadYaml<S extends z.ZodTypeAny>(dir: string, file: string, schema: S): z.output<S> {
  const path = join(dir, file);
  if (!existsSync(path)) throw new ConfigError(file, `missing at ${path}`);

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(file, `YAML parse failed: ${(err as Error).message}`);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(file, `validation failed:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Cross-file referential integrity. Zod validates each file in isolation;
 * this catches the errors that only appear when the files are read together --
 * a typo'd capability name, a rule naming a person who does not exist.
 */
export function checkReferentialIntegrity(cfg: SystemConfig): string[] {
  const errors: string[] = [];
  const capabilityNames = new Set(Object.keys(cfg.capabilities.capabilities));
  const personSlugs = new Set(Object.keys(cfg.people.people));
  const orgSlugs = new Set(Object.keys(cfg.organizations.organizations));
  const areaNames = new Set(Object.keys(cfg.businessAreas.business_areas));

  for (const [slug, person] of Object.entries(cfg.people.people)) {
    for (const cap of Object.keys(person.capabilities)) {
      if (!capabilityNames.has(cap)) {
        errors.push(`people.${slug}: unknown capability "${cap}"`);
      }
    }
    for (const peer of person.collaborates_with) {
      if (!personSlugs.has(peer)) errors.push(`people.${slug}: unknown collaborator "${peer}"`);
    }
  }

  for (const [slug, org] of Object.entries(cfg.organizations.organizations)) {
    if (org.relationship_owner && !personSlugs.has(org.relationship_owner)) {
      errors.push(`organizations.${slug}: unknown relationship_owner "${org.relationship_owner}"`);
    }
    if (org.execution_tracker && !personSlugs.has(org.execution_tracker)) {
      errors.push(`organizations.${slug}: unknown execution_tracker "${org.execution_tracker}"`);
    }
  }

  for (const [name, area] of Object.entries(cfg.businessAreas.business_areas)) {
    for (const cap of area.default_capabilities) {
      if (!capabilityNames.has(cap)) {
        errors.push(`business_areas.${name}: unknown capability "${cap}"`);
      }
    }
    if (area.typical_decision_maker && !personSlugs.has(area.typical_decision_maker)) {
      errors.push(`business_areas.${name}: unknown decision maker "${area.typical_decision_maker}"`);
    }
  }

  const { ceo, leverage, hints } = cfg.routingRules;
  if (!personSlugs.has(ceo.person)) errors.push(`routing_rules.ceo.person: unknown person "${ceo.person}"`);
  if (!personSlugs.has(leverage.person)) {
    errors.push(`routing_rules.leverage.person: unknown person "${leverage.person}"`);
  }
  for (const cap of [...leverage.can_own_capabilities, ...leverage.never_owner_of_capabilities]) {
    if (!capabilityNames.has(cap)) errors.push(`routing_rules.leverage: unknown capability "${cap}"`);
  }
  for (const d of leverage.do_not_duplicate) {
    if (!capabilityNames.has(d.capability)) {
      errors.push(`routing_rules.leverage.do_not_duplicate: unknown capability "${d.capability}"`);
    }
  }
  for (const hint of hints) {
    for (const cap of hint.required_capabilities) {
      if (!capabilityNames.has(cap)) {
        errors.push(`routing_rules.hints.${hint.name}: unknown capability "${cap}"`);
      }
    }
  }

  // Organization capabilities may name capabilities that only agencies have
  // (e.g. google_ads); those are allowed, but a typo of a KNOWN capability is
  // worth catching, so we only warn on near-misses via the areas check above.
  for (const approver of Object.values(cfg.approvalRules.approvers.by_business_area)) {
    if (!personSlugs.has(approver)) errors.push(`approval_rules.approvers: unknown person "${approver}"`);
  }
  if (!personSlugs.has(cfg.approvalRules.approvers.default)) {
    errors.push(`approval_rules.approvers.default: unknown person "${cfg.approvalRules.approvers.default}"`);
  }

  for (const [taskName, task] of Object.entries(cfg.aiRouting.tasks)) {
    if (!(task.model in cfg.aiRouting.models)) {
      errors.push(`ai_routing.tasks.${taskName}: unknown model tier "${task.model}"`);
    }
  }

  // A business area referenced by a capability must exist.
  for (const [cap, def] of Object.entries(cfg.capabilities.capabilities)) {
    if (def.business_area && !areaNames.has(def.business_area)) {
      errors.push(`capabilities.${cap}: unknown business_area "${def.business_area}"`);
    }
  }

  if (!orgSlugs.size) errors.push('organizations: at least one organization is required');

  return errors;
}

let cached: SystemConfig | null = null;

export function loadConfig(dir: string = CONFIG_DIR, opts: { force?: boolean } = {}): SystemConfig {
  if (cached && !opts.force && dir === CONFIG_DIR) return cached;

  const cfg: SystemConfig = {
    capabilities: loadYaml(dir, 'capabilities.yaml', CapabilitiesConfig),
    people: loadYaml(dir, 'people.yaml', PeopleConfig),
    organizations: loadYaml(dir, 'organizations.yaml', OrganizationsConfig),
    businessAreas: loadYaml(dir, 'business-areas.yaml', BusinessAreasConfig),
    priorityRules: loadYaml(dir, 'priority-rules.yaml', PriorityRulesConfig),
    routingRules: loadYaml(dir, 'routing-rules.yaml', RoutingRulesConfig),
    approvalRules: loadYaml(dir, 'approval-rules.yaml', ApprovalRulesConfig),
    followupRules: loadYaml(dir, 'followup-rules.yaml', FollowupRulesConfig),
    aiRouting: loadYaml(dir, 'ai-routing.yaml', AiRoutingConfig),
  };

  const errors = checkReferentialIntegrity(cfg);
  if (errors.length) {
    throw new ConfigError('*', `referential integrity failed:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  }

  if (dir === CONFIG_DIR) cached = cfg;
  return cfg;
}

export function clearConfigCache(): void {
  cached = null;
}
