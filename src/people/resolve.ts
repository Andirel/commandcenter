/**
 * Identity resolution.
 *
 * Resolves an event participant to a known person, or reports that they are
 * new. Resolution NEVER blocks the pipeline: an unknown sender becomes a
 * provisional record and processing continues.
 *
 * Order matters. Email is the strongest key; name matching is the weakest and
 * is only trusted within a known organization, because "Mike" at a supplier is
 * not our Mike.
 */
import type { OrganizationsConfig } from '../schemas/config.js';
import type { ParticipantRef } from '../schemas/events.js';
import type { Organization, Person } from '../schemas/people.js';
import type { TeamModel } from '../capabilities/graph.js';

export type ResolutionMethod =
  | 'email' | 'alternate_email' | 'slack_id' | 'zoom_identity'
  | 'alias' | 'name_within_organization' | 'unresolved';

export interface Resolution {
  person: Person | null;
  organization: Organization | null;
  method: ResolutionMethod;
  confidence: number;
  /** True when the participant should be routed to discovery. */
  isNew: boolean;
}

export function resolveParticipant(
  ref: ParticipantRef,
  team: TeamModel,
  orgConfig: OrganizationsConfig,
): Resolution {
  // 1. Exact email.
  if (ref.email) {
    const person = team.getPersonByEmail(ref.email);
    if (person) {
      return {
        person,
        organization: person.organizationId ? team.getOrganization(person.organizationId) ?? null : null,
        method: person.email?.toLowerCase() === ref.email.toLowerCase() ? 'email' : 'alternate_email',
        confidence: 0.99,
        isNew: false,
      };
    }
  }

  // 2. Platform identity.
  if (ref.slackUserId) {
    const person = team.getPersonBySlackId(ref.slackUserId);
    if (person) {
      return {
        person,
        organization: person.organizationId ? team.getOrganization(person.organizationId) ?? null : null,
        method: 'slack_id',
        confidence: 0.98,
        isNew: false,
      };
    }
  }
  if (ref.zoomIdentity) {
    const person = team.allPeople().find((p) => p.zoomIdentity === ref.zoomIdentity);
    if (person) {
      return {
        person,
        organization: person.organizationId ? team.getOrganization(person.organizationId) ?? null : null,
        method: 'zoom_identity',
        confidence: 0.95,
        isNew: false,
      };
    }
  }

  // 3. Curated alias / canonical name.
  //    Meetings and chat often supply a display name and nothing else, so this
  //    step is what makes Zoom attribution resolvable at all. It is safe
  //    because aliases are human-curated, unlike free-text name matching.
  if (ref.name) {
    const person = team.getPersonByAlias(ref.name);
    if (person) {
      return {
        person,
        organization: person.organizationId ? team.getOrganization(person.organizationId) ?? null : null,
        method: 'alias',
        confidence: 0.9,
        isNew: false,
      };
    }
  }

  // 4. Organization from the email domain.
  const organization = ref.email ? organizationForEmail(ref.email, team, orgConfig) : null;

  // 5. Name match, but ONLY within a known organization. A bare name match
  //    across the whole directory is how two different Mikes become one person.
  if (ref.name && organization) {
    const normalized = normalizeName(ref.name);
    const person = team.allPeople().find(
      (p) => p.organizationId === organization.id && normalizeName(p.name) === normalized,
    );
    if (person) {
      return { person, organization, method: 'name_within_organization', confidence: 0.75, isNew: false };
    }
  }

  return { person: null, organization, method: 'unresolved', confidence: 0, isNew: true };
}

/**
 * Infer the organization from an email domain.
 *
 * Consumer domains are excluded outright: two people at gmail.com are not
 * colleagues, and treating them as such would merge unrelated parties into a
 * fictional company.
 */
export function organizationForEmail(
  email: string,
  team: TeamModel,
  orgConfig: OrganizationsConfig,
): Organization | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  if (isGenericDomain(domain, orgConfig)) return null;
  return team.getOrganizationByDomain(domain) ?? null;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

export function isGenericDomain(domain: string, orgConfig: OrganizationsConfig): boolean {
  return orgConfig.generic_email_domains.some((d) => d.toLowerCase() === domain.toLowerCase());
}

/**
 * Automated senders. These create no person, no organization, and no task --
 * this check runs before any AI call and is the single largest cost saving in
 * the pipeline.
 */
export function isAutomatedSender(email: string | null, orgConfig: OrganizationsConfig): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return orgConfig.noreply_patterns.some((p) => lower.includes(p.toLowerCase()));
}

/** Casing, accents, punctuation and extra whitespace removed for comparison. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
