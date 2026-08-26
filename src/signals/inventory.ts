/**
 * Stock, and the catalogue it is counted against.
 *
 * This module was started to answer one question — how many days of cover is
 * there on each SKU — and the real store answered it differently than expected.
 * Every variant carries `inventoryPolicy: CONTINUE`, so Shopify keeps selling
 * past zero and the quantity decrements forever: a headline product sits at
 * −70,666 units. That figure is a running sales counter, not stock.
 *
 * Building days of cover on it would produce confident nonsense, which is the
 * exact failure the unclosed-books rule exists to prevent elsewhere. So cover
 * is computed ONLY where the number can bear it, and the far more useful
 * findings turn out to be about the catalogue itself:
 *
 *   - the same SKU on two different products, which breaks fulfilment,
 *     reporting and every feed downstream
 *   - one product listed twice
 *   - six spellings of one size inside a single product
 *   - nothing in the stack able to warn anyone before a stockout
 *
 * Each of those changes what someone does in the next hour. A days-of-cover
 * number derived from a negative would not.
 */
import type { StateSignal } from '../sync/state.js';

export interface Variant {
  productTitle: string;
  productId: string | null;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  /** CONTINUE means Shopify will sell past zero; DENY means it stops. */
  policy: 'CONTINUE' | 'DENY';
  tracked: boolean;
  /** Units sold in the recent window, where known. Drives cover. */
  unitsSold?: number;
}

/**
 * A quantity above this is somebody typing "effectively infinite" rather than
 * counting. Real values here were 998,064 and 999,410 against a few hundred
 * units a month.
 */
export const PLACEHOLDER_UNITS = 50_000;

/** Below this many days of cover, a SKU is worth someone's attention today. */
export const COVER_WARNING_DAYS = 21;

/**
 * Beyond this, a SKU is not a constraint and does not belong in a list whose
 * whole purpose is runway. Real figures here ran to 7,228 days — twenty years
 * of cover is not a fact about stock, it is a quantity nobody counted.
 */
export const COVER_HORIZON_DAYS = 180;

/** Two measures this close are the same size written two ways. */
const MEASURE_TOLERANCE = 0.02;

export interface CoverRow {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  dailyRate: number;
  daysOfCover: number;
}

export interface InventoryHealth {
  variants: number;
  /** Cover, only for variants whose quantity can actually bear the arithmetic. */
  cover: CoverRow[];
  /** Variants whose quantity says nothing about stock, with their volume. */
  unusable: { count: number; unitsSold: number };
  totalUnitsSold: number;
  /** Same SKU on more than one variant. Always a defect. */
  skuCollisions: Array<{ sku: string; on: string[] }>;
  /** One product listed more than once under the same name. */
  duplicateProducts: Array<{ title: string; count: number }>;
  /** One size written several ways inside a single product. */
  variantDrift: Array<{ productTitle: string; measure: string; spellings: string[] }>;
}

/**
 * Can this quantity be read as stock?
 *
 * Negative means the store has been selling past zero, so the number counts
 * oversold units rather than remaining ones. Above the placeholder ceiling it
 * was typed rather than counted. Neither can produce a cover figure.
 */
export function isUsableQuantity(v: Variant): boolean {
  if (!v.tracked) return false;
  if (v.quantity < 0) return false;
  if (v.quantity > PLACEHOLDER_UNITS) return false;
  return true;
}

export function summarizeInventory(variants: Variant[], windowDays = 30): InventoryHealth {
  const cover: CoverRow[] = [];
  let unusableCount = 0;
  let unusableUnits = 0;
  let totalUnitsSold = 0;

  for (const v of variants) {
    const sold = v.unitsSold ?? 0;
    totalUnitsSold += sold;

    if (!isUsableQuantity(v)) {
      unusableCount++;
      unusableUnits += sold;
      continue;
    }
    // No recent sales means no rate, and a cover figure of infinity helps
    // nobody. Left out rather than reported as "well stocked".
    if (sold <= 0) continue;

    const dailyRate = sold / windowDays;
    const days = Math.round(v.quantity / dailyRate);
    if (days > COVER_HORIZON_DAYS) {
      // Not a stock constraint. Counted with the unusable figures rather than
      // silently dropped, so the share of volume nothing watches stays honest.
      unusableCount++;
      unusableUnits += sold;
      continue;
    }
    cover.push({
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      quantity: v.quantity,
      dailyRate: round(dailyRate, 2),
      daysOfCover: days,
    });
  }

  cover.sort((a, b) => a.daysOfCover - b.daysOfCover);

  return {
    variants: variants.length,
    cover,
    unusable: { count: unusableCount, unitsSold: unusableUnits },
    totalUnitsSold,
    skuCollisions: findSkuCollisions(variants),
    duplicateProducts: findDuplicateProducts(variants),
    variantDrift: findVariantDrift(variants),
  };
}

/**
 * The same SKU on two variants.
 *
 * Unambiguous and always wrong: fulfilment, stock counts and every downstream
 * feed key on it. Compared after normalizing case and punctuation, because
 * `120Life-Case` and `120life-case` collide just as badly in a warehouse.
 */
export function findSkuCollisions(variants: Variant[]): Array<{ sku: string; on: string[] }> {
  // Keyed on the normalized form so case and punctuation collide, but reported
  // as the SKU somebody actually typed — "120lifecasesf" is not a string
  // anyone can search for in the admin.
  // Counted by variant IDENTITY, displayed by label. Keying the set on the
  // label instead would silently collapse the worst case there is: two
  // different variants sharing both a SKU and a name.
  const bySku = new Map<string, { display: string; on: Map<string, string> }>();
  for (const v of variants) {
    if (!v.sku) continue;
    const key = v.sku.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) continue;
    const identity = `${v.productId ?? v.productTitle}\u0000${v.variantTitle}`;
    if (!bySku.has(key)) bySku.set(key, { display: v.sku, on: new Map() });
    bySku.get(key)!.on.set(identity, `${v.productTitle} — ${v.variantTitle}`);
  }
  return [...bySku.values()]
    .filter((e) => e.on.size > 1)
    .map((e) => ({ sku: e.display, on: [...e.on.values()].sort() }))
    .sort((a, b) => b.on.length - a.on.length);
}

/** One product listed more than once under the same name. */
export function findDuplicateProducts(variants: Variant[]): Array<{ title: string; count: number }> {
  const ids = new Map<string, Set<string>>();
  for (const v of variants) {
    const key = normalizeTitle(v.productTitle);
    if (!key) continue;
    if (!ids.has(key)) ids.set(key, new Set());
    ids.get(key)!.add(v.productId ?? v.productTitle);
  }
  return [...ids.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([title, set]) => ({ title, count: set.size }))
    .sort((a, b) => b.count - a.count);
}

/**
 * One size written several ways inside a single product.
 *
 * Real example: a single product carrying `6.53 oz`, `6.530 oz`, `6.5oz` and
 * `28 servings` as separate variants with separate SKUs. Each spelling
 * fragments its own sales history and its own feed entry, which is why the
 * merchant-centre audits keep finding mismatches.
 *
 * Matched on the measure rather than the words: two numbers within two per
 * cent of each other, carrying the same unit, are the same size.
 */
export function findVariantDrift(variants: Variant[]): Array<{ productTitle: string; measure: string; spellings: string[] }> {
  const byProduct = new Map<string, Variant[]>();
  for (const v of variants) {
    const key = v.productId ?? v.productTitle;
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(v);
  }

  const out: Array<{ productTitle: string; measure: string; spellings: string[] }> = [];
  for (const group of byProduct.values()) {
    const measured = group
      .map((v) => ({ v, m: parseMeasure(v.variantTitle) }))
      .filter((x): x is { v: Variant; m: { value: number; unit: string } } => x.m !== null);

    const clusters: Array<{ unit: string; value: number; spellings: Set<string> }> = [];
    for (const { v, m } of measured) {
      const hit = clusters.find(
        (c) => c.unit === m.unit && Math.abs(c.value - m.value) / Math.max(c.value, m.value) <= MEASURE_TOLERANCE,
      );
      if (hit) hit.spellings.add(v.variantTitle);
      else clusters.push({ unit: m.unit, value: m.value, spellings: new Set([v.variantTitle]) });
    }

    for (const c of clusters) {
      if (c.spellings.size < 2) continue;
      out.push({
        productTitle: group[0]!.productTitle,
        measure: `${c.value} ${c.unit}`,
        spellings: [...c.spellings].sort(),
      });
    }
  }
  return out.sort((a, b) => b.spellings.length - a.spellings.length);
}

/** A number and its unit, from a variant title. Null when there isn't one. */
export function parseMeasure(title: string): { value: number; unit: string } | null {
  const m = /(\d+(?:\.\d+)?)\s*(oz|ounces?|ml|l|g|kg|ct|count|pack|packs|servings?|bottles?|sticks?)\b/i.exec(title);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit: canonicalUnit(m[2]!.toLowerCase()) };
}

function canonicalUnit(u: string): string {
  if (u.startsWith('ounce') || u === 'oz') return 'oz';
  if (u.startsWith('serving')) return 'servings';
  if (u.startsWith('bottle')) return 'bottles';
  if (u.startsWith('stick')) return 'sticks';
  if (u.startsWith('pack')) return 'pack';
  if (u === 'count') return 'ct';
  return u;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * What the Business panel should say about stock.
 *
 * The tone here matters. A store that deliberately oversells is not
 * misconfigured — it is a made-to-order or 3PL-backed operation making a
 * reasonable choice. What it needs to know is the CONSEQUENCE of that choice:
 * no system it owns can warn it before a shortage, so the warning has to come
 * from somewhere else.
 */
export function inventorySignals(health: InventoryHealth, opts: { windowDays?: number } = {}): StateSignal[] {
  const out: StateSignal[] = [];
  const windowDays = opts.windowDays ?? 30;

  for (const c of health.cover.filter((r) => r.daysOfCover <= COVER_WARNING_DAYS)) {
    out.push({
      signalType: 'stockout_risk',
      businessArea: 'operations',
      severity: c.daysOfCover <= 10 ? 8 : 6,
      summary: `${c.productTitle} — ${c.variantTitle} has about ${c.daysOfCover} days of cover left.`,
      evidence: `${c.quantity} units on hand against ${c.dailyRate}/day over the last ${windowDays} days.`,
      recommendedAction: 'Confirm the next production or replenishment date covers the gap.',
      likelyPeople: [],
      valueAtStake: null,
    });
  }

  if (health.skuCollisions.length) {
    const worst = health.skuCollisions[0]!;
    out.push({
      signalType: 'catalogue_defect',
      businessArea: 'operations',
      severity: 7,
      summary: `${health.skuCollisions.length} SKU${health.skuCollisions.length === 1 ? ' is' : 's are'} used on more than one product.`,
      evidence: `"${worst.sku}" is on ${worst.on.length}: ${worst.on.join('; ')}.`,
      recommendedAction: 'Give each variant its own SKU — fulfilment, stock counts and every product feed key on it.',
      likelyPeople: [],
      valueAtStake: null,
    });
  }

  if (health.duplicateProducts.length) {
    const worst = health.duplicateProducts[0]!;
    out.push({
      signalType: 'catalogue_defect',
      businessArea: 'operations',
      severity: 5,
      summary: `${health.duplicateProducts.length} product${health.duplicateProducts.length === 1 ? ' is' : 's are'} listed more than once under the same name.`,
      evidence: `"${worst.title}" exists as ${worst.count} separate products.`,
      recommendedAction: 'Merge or retire the duplicates; each one splits its own sales history.',
      likelyPeople: [],
      valueAtStake: null,
    });
  }

  const drift = health.variantDrift.filter((d) => d.spellings.length >= 3);
  if (drift.length) {
    const worst = drift[0]!;
    out.push({
      signalType: 'catalogue_defect',
      businessArea: 'operations',
      severity: 5,
      summary: `One size is written ${worst.spellings.length} different ways on ${worst.productTitle}.`,
      evidence: `${worst.measure} appears as ${worst.spellings.map((s) => `"${s}"`).join(', ')}.`,
      recommendedAction: 'Consolidate the spellings — each one fragments its own sales history and feed entry.',
      likelyPeople: [],
      valueAtStake: null,
    });
  }

  // The consequence of overselling everywhere, stated as a share of real volume.
  const share = health.totalUnitsSold > 0 ? health.unusable.unitsSold / health.totalUnitsSold : 0;
  if (share >= 0.5 && health.unusable.count > 0) {
    out.push({
      signalType: 'stock_unwatched',
      businessArea: 'operations',
      severity: 6,
      summary: `${Math.round(share * 100)}% of unit volume sits on variants whose stock figure cannot be read.`,
      evidence: `${health.unusable.count} of ${health.variants} variants either sell past zero or carry a placeholder quantity, so no days-of-cover figure exists for them.`,
      recommendedAction: 'Nothing in the storefront can warn before a shortage — the cover check has to come from the production plan instead.',
      likelyPeople: [],
      valueAtStake: null,
    });
  }

  return out;
}

/** Parse the Shopify Admin API product/variant shape into flat variants. */
export function parseVariants(payload: unknown, unitsSoldBySku: Record<string, number> = {}): Variant[] {
  const nodes = (payload as { data?: { products?: { nodes?: unknown[] } } })?.data?.products?.nodes
    ?? (payload as { products?: { nodes?: unknown[] } })?.products?.nodes
    ?? (Array.isArray(payload) ? payload : []);

  const out: Variant[] = [];
  for (const raw of nodes as Array<Record<string, unknown>>) {
    const productTitle = String(raw.title ?? '');
    const productId = raw.id ? String(raw.id) : null;
    const variants = (raw.variants as { nodes?: unknown[] } | undefined)?.nodes ?? [];
    for (const rv of variants as Array<Record<string, unknown>>) {
      const sku = rv.sku ? String(rv.sku) : null;
      const tracked = Boolean((rv.inventoryItem as { tracked?: boolean } | undefined)?.tracked);
      const entry: Variant = {
        productTitle,
        productId,
        variantTitle: String(rv.title ?? ''),
        sku,
        quantity: Number(rv.inventoryQuantity ?? 0),
        policy: rv.inventoryPolicy === 'DENY' ? 'DENY' : 'CONTINUE',
        tracked,
      };
      const sold = sku ? unitsSoldBySku[sku] : undefined;
      if (sold !== undefined) entry.unitsSold = sold;
      out.push(entry);
    }
  }
  return out;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
