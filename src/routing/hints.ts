/**
 * Capability resolution and routing hints.
 *
 * Hints exist because the capability graph alone gets a small number of genuine
 * role distinctions wrong -- most importantly the finance split, where
 * "financial" is not a routing destination: paying an invoice and reconciling
 * the books are different jobs done by different people.
 *
 * Hints are deliberately few. They are not a shadow org chart.
 */
import type { RoutingRulesConfig, SystemConfig } from '../schemas/config.js';
import type { RoutingRequest } from '../schemas/routing.js';

export type Hint = RoutingRulesConfig['hints'][number];

export { containsKeyword };

/** Text the hint matcher searches. */
function haystack(req: RoutingRequest): string {
  return `${req.title} ${req.description ?? ''}`.toLowerCase();
}

const boundaryCache = new Map<string, RegExp>();

/**
 * Keyword matching on word boundaries.
 *
 * Plain substring matching is not safe here: the keyword "edi" matches inside
 * "Media", which silently pulled retailer-onboarding rules onto podcast
 * correspondence. Boundaries are defined as "not adjacent to another
 * alphanumeric", which keeps multi-word and punctuated keywords ("past due
 * invoice", "w-9", "p&l") working.
 */
function containsKeyword(text: string, keyword: string): boolean {
  const k = keyword.toLowerCase().trim();
  if (!k) return false;
  let re = boundaryCache.get(k);
  if (!re) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
    boundaryCache.set(k, re);
  }
  return re.test(text);
}

/**
 * All hints whose keywords match.
 *
 * `not_keyword` is what keeps the finance split intact: an email about a
 * "past due invoice" routes to accounts payable, but one about "reconciling
 * invoices in the ledger" does not.
 */
export function matchHints(req: RoutingRequest, rules: RoutingRulesConfig): Hint[] {
  const text = haystack(req);
  return rules.hints.filter((hint) => {
    const positives = hint.match.any_keyword;
    if (positives.length && !positives.some((k) => containsKeyword(text, k))) return false;
    const negatives = hint.match.not_keyword;
    if (negatives.length && negatives.some((k) => containsKeyword(text, k))) return false;
    return true;
  });
}

/**
 * The capabilities this work actually requires.
 *
 * Precedence: explicit capabilities from the interpretation, then matched
 * hints, then the business area's defaults. Business area is the weakest
 * signal because areas are for grouping, not routing.
 */
export function resolveCapabilities(
  req: RoutingRequest,
  hints: Hint[],
  config: SystemConfig,
): string[] {
  const known = new Set(Object.keys(config.capabilities.capabilities));
  const out = new Set<string>();

  for (const cap of req.requiredCapabilities) {
    if (known.has(cap)) out.add(cap);
  }
  for (const hint of hints) {
    for (const cap of hint.required_capabilities) if (known.has(cap)) out.add(cap);
  }

  // Business area is the WEAKEST signal and is only a fallback. In particular,
  // it is not consulted when a hint already matched: a hint is a specific
  // statement about what this work needs, and layering "everything in
  // marketing" on top of it drags in unrelated specialists as collaborators.
  if (out.size === 0 && hints.length === 0 && req.businessArea) {
    const area = config.businessAreas.business_areas[req.businessArea];
    for (const cap of area?.default_capabilities ?? []) if (known.has(cap)) out.add(cap);
  }

  // Pure decisions with no other signal still need judgment, which is itself
  // a capability.
  if (out.size === 0 && (req.isDecision || req.isStrategicDirection)) out.add('strategy');

  return [...out];
}

/** True when any matched hint says this should be aggregated as a signal rather than tasked. */
export function shouldAggregateAsSignal(hints: Hint[]): boolean {
  return hints.some((h) => h.aggregate_as_signal);
}
