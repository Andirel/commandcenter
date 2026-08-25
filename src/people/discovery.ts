/**
 * People and organization discovery.
 *
 * When someone unknown appears, the system builds a provisional profile and
 * keeps going. Two rules:
 *   1. Discovery never blocks processing.
 *   2. A single email never grants operational authority.
 */
import type { OrganizationsConfig, RoutingRulesConfig } from '../schemas/config.js';
import type { CanonicalEvent, ParticipantRef } from '../schemas/events.js';
import type { PersonCandidate } from '../schemas/people.js';
import type { OrganizationType, RelationshipType } from '../schemas/core.js';
import type { TeamModel } from '../capabilities/graph.js';
import { emailDomain, isAutomatedSender, isGenericDomain, resolveParticipant } from './resolve.js';

export interface DiscoveryResult {
  /** Participants matched to existing people. */
  resolved: Array<{ ref: ParticipantRef; personId: string }>;
  /** New people worth creating a provisional record for. */
  candidates: PersonCandidate[];
  /** Domains seen that map to no known organization. */
  unknownDomains: string[];
  /** Participants deliberately skipped (automated senders and the like). */
  skipped: Array<{ ref: ParticipantRef; reason: string }>;
}

export function discoverFromEvent(
  event: CanonicalEvent,
  team: TeamModel,
  orgConfig: OrganizationsConfig,
): DiscoveryResult {
  const result: DiscoveryResult = { resolved: [], candidates: [], unknownDomains: [], skipped: [] };
  const seenEmails = new Set<string>();

  const refs = [event.actor, ...event.participants].filter(Boolean) as ParticipantRef[];

  for (const ref of refs) {
    const key = (ref.email ?? ref.slackUserId ?? ref.name ?? '').toLowerCase();
    if (key && seenEmails.has(key)) continue;
    if (key) seenEmails.add(key);

    if (isAutomatedSender(ref.email, orgConfig)) {
      result.skipped.push({ ref, reason: 'automated sender' });
      continue;
    }

    const resolution = resolveParticipant(ref, team, orgConfig);
    if (resolution.person) {
      result.resolved.push({ ref, personId: resolution.person.id });
      continue;
    }

    if (!ref.email && !ref.slackUserId) {
      // A bare display name with no identifier is not enough to build a
      // profile on -- it would create a duplicate the moment they email us.
      result.skipped.push({ ref, reason: 'no usable identifier' });
      continue;
    }

    const domain = ref.email ? emailDomain(ref.email) : null;
    if (domain && !resolution.organization && !isGenericDomain(domain, orgConfig)) {
      if (!result.unknownDomains.includes(domain)) result.unknownDomains.push(domain);
    }

    result.candidates.push(buildCandidate(ref, resolution.organization?.name ?? null, event, domain));
  }

  return result;
}

/**
 * A first-pass profile from deterministic signals only.
 *
 * The AI discovery prompt (prompts/people-discovery/) refines this with
 * signature blocks and thread context. Starting deterministically means most
 * discoveries never need a model call at all.
 */
function buildCandidate(
  ref: ParticipantRef,
  organizationName: string | null,
  event: CanonicalEvent,
  domain: string | null,
): PersonCandidate {
  const name = ref.name?.trim() || guessNameFromEmail(ref.email) || 'Unknown';

  // Confidence reflects how well we can IDENTIFY them, not how important they
  // are. Deliberately low: this is a stranger who has sent one message.
  let confidence = 0.35;
  if (ref.email) confidence += 0.15;
  if (ref.name) confidence += 0.1;
  if (organizationName) confidence += 0.15;

  return {
    name,
    email: ref.email,
    organization: organizationName ?? (domain ? domainToOrgName(domain) : null),
    organizationType: null,
    likelyRelationshipType: guessRelationshipType(ref, event),
    likelyFunction: null,
    likelyCapabilities: [],
    evidenceCount: 1,
    confidence: Math.min(0.75, confidence),
    reason: `First seen as ${ref.role} on ${event.sourceSystem} event "${event.subject ?? event.eventType}".`,
  };
}

function guessRelationshipType(ref: ParticipantRef, event: CanonicalEvent): RelationshipType {
  if (event.sourceSystem === 'slack' && ref.slackUserId) return 'employee';
  return 'unknown';
}

/** "jane.smith@example.com" -> "Jane Smith". A guess, replaced the moment a real name appears. */
function guessNameFromEmail(email: string | null): string | null {
  if (!email) return null;
  const local = email.split('@')[0];
  if (!local) return null;
  const parts = local.split(/[._-]+/).filter((p) => p.length > 1 && !/^\d+$/.test(p));
  if (!parts.length) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

/** "acme-foods.com" -> "Acme Foods". Provisional; a human or a signature corrects it. */
export function domainToOrgName(domain: string): string {
  const base = domain.replace(/\.(com|net|org|io|co|co\.uk|us|biz|info)$/i, '');
  return base
    .split(/[.-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Classify a newly discovered organization from weak signals.
 *
 * Returns 'other' rather than guessing when nothing matches: a wrong type
 * misroutes work, while 'other' merely asks a human.
 */
export function guessOrganizationType(
  domain: string,
  context: { subject?: string | null; body?: string | null } = {},
): OrganizationType {
  const text = `${context.subject ?? ''} ${context.body ?? ''}`.toLowerCase();
  const rules: Array<[OrganizationType, RegExp]> = [
    ['manufacturer', /\b(co-?packer|manufactur|production run|batch|formulation)\b/],
    ['retailer', /\b(retailer|buyer|store|shelf|planogram|vendor portal)\b/],
    ['agency', /\b(agency|campaign|media buy|retainer)\b/],
    ['professional_services', /\b(attorney|counsel|law firm|accountant|consultant)\b/],
    ['logistics', /\b(freight|3pl|carrier|shipment|customs)\b/],
    ['research_partner', /\b(study|research|clinical|university|grant)\b/],
  ];
  for (const [type, re] of rules) if (re.test(text)) return type;
  return 'other';
}

/**
 * Whether a candidate has accumulated enough evidence to become provisional.
 * Below this they stay `discovered` and cannot be routed anything.
 */
export function shouldPromoteToProvisional(
  evidenceCount: number,
  thresholds: RoutingRulesConfig['evidence_thresholds'],
): boolean {
  return evidenceCount >= thresholds.promote_to_provisional;
}
