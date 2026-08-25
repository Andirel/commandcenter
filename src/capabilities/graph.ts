/**
 * The team model: people, organizations, and the capability graph.
 *
 * This is the read model the routing engine works against. It can be built
 * from config (tests, bootstrap) or hydrated from the database (production) --
 * the routing engine cannot tell the difference, which is what makes routing
 * unit-testable without a database.
 *
 * NOTHING in this module hard-codes a person's name. Adding a person is a
 * config edit or a database row, never a code change.
 */
import type { SystemConfig } from '../schemas/config.js';
import type { CapabilityEdge, Organization, Person } from '../schemas/people.js';
import type { PrimarySecondary } from '../schemas/core.js';

export interface CapabilityDef {
  name: string;
  description?: string;
  businessArea?: string;
  /** Work that a capable generalist coordinator must not be made the OWNER of. */
  specialistOnly: boolean;
}

export interface TeamModelSource {
  people: Person[];
  organizations: Organization[];
  capabilities: CapabilityDef[];
}

/** A person's fit for one capability, decomposed for explanation. */
export interface CapabilityMatch {
  capability: string;
  confidence: number;
  proficiency: number;
  level: PrimarySecondary;
  /** confidence * proficiency -- the single number used for ranking. */
  strength: number;
}

export class TeamModel {
  private readonly peopleById = new Map<string, Person>();
  private readonly peopleBySlug = new Map<string, Person>();
  private readonly peopleByEmail = new Map<string, Person>();
  private readonly peopleBySlackId = new Map<string, Person>();
  private readonly orgsById = new Map<string, Organization>();
  private readonly orgsBySlug = new Map<string, Organization>();
  private readonly orgsByDomain = new Map<string, Organization>();
  private readonly capabilitiesByName = new Map<string, CapabilityDef>();

  constructor(source: TeamModelSource) {
    for (const cap of source.capabilities) this.capabilitiesByName.set(cap.name, cap);

    for (const org of source.organizations) {
      this.orgsById.set(org.id, org);
      this.orgsBySlug.set(org.slug, org);
      for (const domain of org.domains) this.orgsByDomain.set(domain.toLowerCase(), org);
    }

    for (const person of source.people) {
      this.peopleById.set(person.id, person);
      if (person.slug) this.peopleBySlug.set(person.slug, person);
      if (person.email) this.peopleByEmail.set(person.email.toLowerCase(), person);
      for (const alt of person.alternateEmails) this.peopleByEmail.set(alt.toLowerCase(), person);
      if (person.slackUserId) this.peopleBySlackId.set(person.slackUserId, person);
    }
  }

  // --- lookups -------------------------------------------------------------

  getPerson(id: string): Person | undefined { return this.peopleById.get(id); }
  getPersonBySlug(slug: string): Person | undefined { return this.peopleBySlug.get(slug); }
  getPersonByEmail(email: string): Person | undefined { return this.peopleByEmail.get(email.toLowerCase()); }
  getPersonBySlackId(id: string): Person | undefined { return this.peopleBySlackId.get(id); }
  getOrganization(id: string): Organization | undefined { return this.orgsById.get(id); }
  getOrganizationBySlug(slug: string): Organization | undefined { return this.orgsBySlug.get(slug); }
  getOrganizationByDomain(domain: string): Organization | undefined {
    return this.orgsByDomain.get(domain.toLowerCase());
  }
  getCapability(name: string): CapabilityDef | undefined { return this.capabilitiesByName.get(name); }

  allPeople(): Person[] { return [...this.peopleById.values()]; }
  allOrganizations(): Organization[] { return [...this.orgsById.values()]; }
  allCapabilities(): CapabilityDef[] { return [...this.capabilitiesByName.values()]; }

  /** True when any of the named capabilities is specialist-only. */
  requiresSpecialist(capabilities: string[]): boolean {
    return capabilities.some((c) => this.capabilitiesByName.get(c)?.specialistOnly === true);
  }

  // --- capability queries --------------------------------------------------

  /** One person's edge for one capability, or undefined if they have none. */
  match(personId: string, capability: string): CapabilityMatch | undefined {
    const person = this.peopleById.get(personId);
    if (!person) return undefined;
    const edge = person.capabilities.find((c) => c.capability === capability);
    if (!edge) return undefined;
    return toMatch(edge);
  }

  /**
   * Mean strength across the required capabilities, counting a missing
   * capability as zero. Averaging (rather than taking the best) is deliberate:
   * a person strong in one required capability and absent in another is a
   * partial fit, and the score should say so.
   */
  matchStrength(personId: string, capabilities: string[]): number {
    if (capabilities.length === 0) return 0;
    let total = 0;
    for (const cap of capabilities) total += this.match(personId, cap)?.strength ?? 0;
    return total / capabilities.length;
  }

  /** True if the person holds any of these capabilities at `primary` level. */
  hasPrimaryCapability(personId: string, capabilities: string[]): boolean {
    return capabilities.some((c) => this.match(personId, c)?.level === 'primary');
  }

  /**
   * People who can plausibly do this work, ranked by raw capability strength.
   * Routing applies workload, continuity and friction on top of this.
   *
   * Only `confirmed` and `provisional` people are returned -- a person seen
   * once is never a candidate to own anything.
   */
  candidatesFor(capabilities: string[], opts: { includeExternal?: boolean } = {}): Array<{ person: Person; strength: number }> {
    const out: Array<{ person: Person; strength: number }> = [];
    for (const person of this.peopleById.values()) {
      if (!person.routingEligible) continue;
      if (person.discoveryStatus !== 'confirmed' && person.discoveryStatus !== 'provisional') continue;
      if (!opts.includeExternal && person.internalExternal === 'external') continue;
      const strength = this.matchStrength(person.id, capabilities);
      if (strength <= 0) continue;
      out.push({ person, strength });
    }
    return out.sort((a, b) => b.strength - a.strength);
  }

  /** External organizations that hold one of these capabilities (e.g. paid_media). */
  organizationsWithCapability(capability: string): Array<{ organization: Organization; strength: number }> {
    const out: Array<{ organization: Organization; strength: number }> = [];
    for (const org of this.orgsById.values()) {
      if (org.organizationType === 'internal') continue;
      if (org.relationshipStatus === 'ended') continue;
      const edge = org.capabilities.find((c) => c.capability === capability);
      if (!edge) continue;
      out.push({ organization: org, strength: edge.confidence * edge.proficiency });
    }
    return out.sort((a, b) => b.strength - a.strength);
  }
}

function toMatch(edge: CapabilityEdge): CapabilityMatch {
  return {
    capability: edge.capability,
    confidence: edge.confidence,
    proficiency: edge.proficiency,
    level: edge.level,
    strength: edge.confidence * edge.proficiency,
  };
}

/**
 * Build a TeamModel from configuration.
 *
 * Used to bootstrap an empty database and to run the routing engine in tests.
 * Config slugs double as stable ids so that fixtures read legibly.
 */
export function teamModelFromConfig(cfg: SystemConfig): TeamModel {
  const capabilities: CapabilityDef[] = Object.entries(cfg.capabilities.capabilities).map(
    ([name, def]) => ({
      name,
      ...(def.description !== undefined ? { description: def.description } : {}),
      ...(def.business_area !== undefined ? { businessArea: def.business_area } : {}),
      specialistOnly: def.specialist_only,
    }),
  );

  const organizations: Organization[] = Object.entries(cfg.organizations.organizations).map(
    ([slug, org]) => ({
      id: slug,
      slug,
      name: org.name,
      organizationType: org.type,
      domains: org.domains,
      importance: org.importance,
      relationshipStatus: 'active' as const,
      relationshipOwnerPersonId: org.relationship_owner ?? null,
      executionTrackerPersonId: org.execution_tracker ?? null,
      capabilities: normalizeOrgCapabilities(org.capabilities),
      notes: org.notes.length ? org.notes.join(' ') : null,
    }),
  );

  const internalOrg = organizations.find((o) => o.organizationType === 'internal');

  const people: Person[] = Object.entries(cfg.people.people).map(([slug, p]) => ({
    id: slug,
    slug,
    organizationId: p.internal ? (internalOrg?.id ?? null) : null,
    name: p.name,
    email: p.email ?? null,
    alternateEmails: [],
    slackUserId: p.slack_user_id ?? null,
    zoomIdentity: null,
    title: p.role ?? null,
    relationshipType: (p.relationship_type as Person['relationshipType']) ?? (p.internal ? 'employee' : 'contractor'),
    internalExternal: p.internal ? ('internal' as const) : ('external' as const),
    importanceScore: p.importance,
    discoveryStatus: p.discovery_status,
    confidence: 1,
    capabilities: Object.entries(p.capabilities).map(([capability, edge]) => ({
      capability,
      confidence: edge.confidence,
      proficiency: edge.proficiency,
      level: edge.level,
      evidenceCount: 0,
      lastEvidenceAt: null,
      manuallyConfirmed: edge.confirmed,
    })),
    openTaskCount: 0,
    overdueTaskCount: 0,
    routingEligible: true,
    notes: p.notes.length ? p.notes.join(' ') : null,
  }));

  return new TeamModel({ people, organizations, capabilities });
}

function normalizeOrgCapabilities(
  caps: Record<string, { confidence: number; proficiency: number; level: PrimarySecondary; confirmed: boolean }> | string[],
): CapabilityEdge[] {
  if (Array.isArray(caps)) {
    return caps.map((capability) => ({
      capability, confidence: 0.7, proficiency: 0.7, level: 'primary' as const,
      evidenceCount: 0, lastEvidenceAt: null, manuallyConfirmed: false,
    }));
  }
  return Object.entries(caps).map(([capability, edge]) => ({
    capability,
    confidence: edge.confidence,
    proficiency: edge.proficiency,
    level: edge.level,
    evidenceCount: 0,
    lastEvidenceAt: null,
    manuallyConfirmed: edge.confirmed,
  }));
}
