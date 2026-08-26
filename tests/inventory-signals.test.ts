/**
 * Stock and catalogue integrity.
 *
 * The governing rule is the same one the finance module learned: a figure that
 * cannot bear the arithmetic must not be put through it. Real stores oversell
 * deliberately, and their inventory quantities are then a running sales counter
 * rather than a stock level. A days-of-cover number derived from one of those
 * is confident nonsense, and confident nonsense is worse than silence.
 */
import { describe, expect, it } from 'vitest';
import {
  summarizeInventory, inventorySignals, isUsableQuantity, parseMeasure,
  findSkuCollisions, findDuplicateProducts, findVariantDrift, parseVariants,
  PLACEHOLDER_UNITS, type Variant,
} from '../src/signals/inventory.js';

function variant(over: Partial<Variant> = {}): Variant {
  return {
    productTitle: 'Powder',
    productId: 'p1',
    variantTitle: '6.53 oz',
    sku: 'PWD-1',
    quantity: 300,
    policy: 'DENY',
    tracked: true,
    unitsSold: 300,
    ...over,
  };
}

describe('which quantities can be read as stock', () => {
  it('accepts a tracked, positive, plausible figure', () => {
    expect(isUsableQuantity(variant({ quantity: 300 }))).toBe(true);
  });

  it('refuses a negative, because the store has been selling past zero', () => {
    // A real headline product sat at −70,666. That counts oversold units, not
    // remaining ones.
    expect(isUsableQuantity(variant({ quantity: -27126 }))).toBe(false);
  });

  it('refuses a placeholder somebody typed instead of counting', () => {
    expect(isUsableQuantity(variant({ quantity: PLACEHOLDER_UNITS + 1 }))).toBe(false);
    expect(isUsableQuantity(variant({ quantity: 999410 }))).toBe(false);
  });

  it('refuses an untracked variant', () => {
    expect(isUsableQuantity(variant({ tracked: false }))).toBe(false);
  });
});

describe('days of cover', () => {
  it('is computed only from usable figures', () => {
    const h = summarizeInventory([
      variant({ sku: 'A', quantity: 300, unitsSold: 300 }),
      variant({ sku: 'B', quantity: -5000, unitsSold: 800 }),
      variant({ sku: 'C', quantity: 998064, unitsSold: 400 }),
    ]);
    expect(h.cover).toHaveLength(1);
    expect(h.cover[0]!.sku).toBe('A');
    expect(h.cover[0]!.daysOfCover).toBe(30);   // 300 units at 10/day
  });

  it('leaves out a runway nobody could act on', () => {
    // A real variant showed 7,228 days of cover. Twenty years is not a fact
    // about stock, it is a quantity nobody counted — and listing it buries the
    // rows that are genuinely short.
    const h = summarizeInventory([variant({ quantity: 9637, unitsSold: 40 })]);
    expect(h.cover).toHaveLength(0);
    expect(h.unusable.count).toBe(1);
  });

  it('leaves out a variant with no recent sales rather than calling it well stocked', () => {
    // Infinite cover is not a fact about stock, it is an absence of demand.
    const h = summarizeInventory([variant({ quantity: 500, unitsSold: 0 })]);
    expect(h.cover).toHaveLength(0);
  });

  it('warns only when the runway is genuinely short', () => {
    const short = summarizeInventory([variant({ quantity: 60, unitsSold: 300 })]);
    const long = summarizeInventory([variant({ quantity: 3000, unitsSold: 300 })]);
    expect(inventorySignals(short).some((s) => s.signalType === 'stockout_risk')).toBe(true);
    expect(inventorySignals(long).some((s) => s.signalType === 'stockout_risk')).toBe(false);
  });

  it('escalates severity as the runway shortens', () => {
    const week = inventorySignals(summarizeInventory([variant({ quantity: 60, unitsSold: 300 })]));
    const fortnight = inventorySignals(summarizeInventory([variant({ quantity: 180, unitsSold: 300 })]));
    expect(week[0]!.severity).toBeGreaterThan(fortnight[0]!.severity);
  });
});

describe('the same SKU on two products', () => {
  const clash = [
    variant({ productTitle: 'Juice', variantTitle: 'Monthly Case', sku: '120life-case-sf' }),
    variant({ productTitle: '4-Week Pack', productId: 'p2', variantTitle: 'none', sku: '120life-case-sf' }),
  ];

  it('is found', () => {
    const found = findSkuCollisions(clash);
    expect(found).toHaveLength(1);
    expect(found[0]!.on).toHaveLength(2);
  });

  it('collides across case and punctuation, as it would in a warehouse', () => {
    expect(findSkuCollisions([
      variant({ sku: '120Life-Case' }),
      variant({ productId: 'p2', sku: '120life_case' }),
    ])).toHaveLength(1);
  });

  it('is reported as the SKU somebody typed, not the normalized key', () => {
    // "120lifecasesf" is not a string anyone can search for in the admin.
    expect(findSkuCollisions(clash)[0]!.sku).toBe('120life-case-sf');
  });

  it('is the most severe catalogue defect, because fulfilment keys on it', () => {
    const s = inventorySignals(summarizeInventory(clash)).find((x) => x.signalType === 'catalogue_defect');
    expect(s!.severity).toBeGreaterThanOrEqual(7);
  });
});

describe('a product listed twice', () => {
  it('is found by name, across distinct product ids', () => {
    const found = findDuplicateProducts([
      variant({ productId: 'p1', productTitle: '120/Life Ready-to-Drink Juice' }),
      variant({ productId: 'p8', productTitle: '120/Life Ready-to-Drink Juice' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.count).toBe(2);
  });

  it('does not flag two variants of one product', () => {
    expect(findDuplicateProducts([
      variant({ productId: 'p1', variantTitle: 'A' }),
      variant({ productId: 'p1', variantTitle: 'B' }),
    ])).toHaveLength(0);
  });
});

describe('one size written several ways', () => {
  it('matches on the measure rather than the words', () => {
    // Real catalogue: four spellings of one size, each with its own SKU, each
    // fragmenting its own sales history and feed entry.
    const found = findVariantDrift([
      variant({ variantTitle: '6.53 oz' }),
      variant({ variantTitle: '6.530 oz' }),
      variant({ variantTitle: '6.5oz' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.spellings).toHaveLength(3);
  });

  it('keeps genuinely different sizes apart', () => {
    expect(findVariantDrift([
      variant({ variantTitle: '6.53 oz' }),
      variant({ variantTitle: '14 oz' }),
    ])).toHaveLength(0);
  });

  it('does not confuse the same number in a different unit', () => {
    expect(findVariantDrift([
      variant({ variantTitle: '14 servings' }),
      variant({ variantTitle: '14 oz' }),
    ])).toHaveLength(0);
  });

  it('reads a measure out of a title, or says there is none', () => {
    expect(parseMeasure('6.53 oz')).toEqual({ value: 6.53, unit: 'oz' });
    expect(parseMeasure('28 servings')).toEqual({ value: 28, unit: 'servings' });
    expect(parseMeasure('2-Week Trial Pack (14 Bottles)')).toEqual({ value: 14, unit: 'bottles' });
    expect(parseMeasure('Default Title')).toBeNull();
  });
});

describe('when nothing can warn you', () => {
  it('says so, as a share of real volume rather than a count of variants', () => {
    // A store that oversells deliberately is not misconfigured. What it needs
    // to know is the consequence: no system it owns can raise the alarm.
    const h = summarizeInventory([
      variant({ sku: 'A', quantity: -5000, unitsSold: 900 }),
      variant({ sku: 'B', quantity: -2000, unitsSold: 800 }),
      variant({ sku: 'C', quantity: 300, unitsSold: 100 }),
    ]);
    const s = inventorySignals(h).find((x) => x.signalType === 'stock_unwatched');
    expect(s).toBeDefined();
    expect(s!.summary).toMatch(/94%/);
  });

  it('stays quiet when most volume is genuinely tracked', () => {
    const h = summarizeInventory([
      variant({ sku: 'A', quantity: 900, unitsSold: 900 }),
      variant({ sku: 'B', quantity: -10, unitsSold: 20 }),
    ]);
    expect(inventorySignals(h).some((x) => x.signalType === 'stock_unwatched')).toBe(false);
  });
});

describe('reading the Shopify shape', () => {
  it('flattens products into variants and attaches sales by SKU', () => {
    const payload = {
      data: { products: { nodes: [{
        id: 'gid://shopify/Product/1', title: 'Powder',
        variants: { nodes: [
          { title: '6.53 oz', sku: 'PWD-1', inventoryQuantity: 300, inventoryPolicy: 'DENY', inventoryItem: { tracked: true } },
          { title: '6.5oz', sku: 'PWD-2', inventoryQuantity: -50, inventoryPolicy: 'CONTINUE', inventoryItem: { tracked: false } },
        ] },
      }] } },
    };
    const vs = parseVariants(payload, { 'PWD-1': 300 });
    expect(vs).toHaveLength(2);
    expect(vs[0]).toMatchObject({ sku: 'PWD-1', quantity: 300, policy: 'DENY', tracked: true, unitsSold: 300 });
    expect(vs[1]).toMatchObject({ sku: 'PWD-2', policy: 'CONTINUE', tracked: false });
    expect(vs[1]!.unitsSold).toBeUndefined();
  });

  it('survives an empty or unexpected payload', () => {
    expect(parseVariants({})).toEqual([]);
    expect(parseVariants(null)).toEqual([]);
  });
});
