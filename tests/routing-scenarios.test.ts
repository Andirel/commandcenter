/**
 * The eight required team-routing scenarios (brief §46).
 *
 * These encode how 120/Life actually operates. Each asserts the distinctions
 * the product exists to preserve -- particularly Adi vs. Paul, Paul vs. Mike,
 * and Peter vs. Brian.
 */
import { describe, expect, it } from 'vitest';
import { routeOwnership } from '../src/routing/owner-selection.js';
import { ctx, request, slug } from './helpers.js';

describe('Test 1 — supplier says production date may slip', () => {
  const decision = routeOwnership(
    request({
      title: 'Supplier says production date may slip',
      description: 'Our manufacturer flagged that the production run lead time may slip by two weeks.',
      businessArea: 'operations',
      externalOrganizationId: null,
      valueAtStake: 40000,
    }),
    ctx(),
  );

  it('gives operational ownership to the COO/CTO', () => {
    expect(slug(decision.primaryOwnerPersonId)).toBe('mike');
  });

  it('brings in the CEO because the value at stake is material', () => {
    expect(decision.ceoRequired).toBe(true);
    expect(slug(decision.decisionMakerPersonId)).toBe('adi');
  });

  it('does not make the CEO do the work', () => {
    expect(decision.ceoActionMode).not.toBe('DO');
  });

  it('lets the coordinator track the follow-up', () => {
    expect(slug(decision.projectManagerPersonId)).toBe('paul');
    expect(decision.leverage.classification).toBe('PAUL_CAN_PROJECT_MANAGE');
  });
});

describe('Test 2 — retailer requests routine onboarding documents', () => {
  const decision = routeOwnership(
    request({
      title: 'Retailer requests vendor form and onboarding packet',
      description: 'New retailer sent their new vendor setup paperwork and needs the vendor form returned.',
      businessArea: 'retail',
      isAdministrative: true,
    }),
    ctx(),
  );

  it('routes execution to the coordinator', () => {
    expect(slug(decision.primaryOwnerPersonId)).toBe('paul');
  });

  it('does NOT make the CEO the primary owner', () => {
    expect(slug(decision.primaryOwnerPersonId)).not.toBe('adi');
  });

  it('classifies it as fully delegable coordination work', () => {
    expect(decision.leverage.classification).toBe('PAUL_CAN_OWN');
    expect(decision.delegable).toBe(true);
  });

  it('does not consume CEO attention at all', () => {
    expect(decision.ceoRequired).toBe(false);
  });
});

describe('Test 3 — RadioActive presents a $40,000 podcast opportunity', () => {
  const decision = routeOwnership(
    request({
      title: 'RadioActive Media presents podcast placement opportunity',
      description: 'RadioActive shared a rate card for a podcast placement at roughly $40,000.',
      businessArea: 'marketing',
      isDecision: true,
      valueAtStake: 40000,
    }),
    ctx(),
  );

  it('makes the CEO the decision maker', () => {
    expect(decision.ceoRequired).toBe(true);
    expect(slug(decision.decisionMakerPersonId)).toBe('adi');
    expect(decision.ceoActionMode).toBe('DECIDE');
  });

  it('identifies the media partner as the external execution partner', () => {
    const org = decision.externalCounterpartyOrganizationId;
    expect(org).toBe('radioactive_media');
  });

  it('does not assign an internal person to execute the placement', () => {
    expect(decision.primaryOwnerPersonId).toBeNull();
  });

  it('lets the coordinator gather inputs and track materials', () => {
    expect(slug(decision.projectManagerPersonId)).toBe('paul');
    expect(decision.leverage.classification).toBe('PAUL_CAN_PROJECT_MANAGE');
  });

  it('is never GREEN — a $40k commitment is not auto-anything', () => {
    expect(decision.approvalClass).toBe('RED');
  });
});

describe('Test 4 — packaging change required', () => {
  const decision = routeOwnership(
    request({
      title: 'Packaging change required for the new carton artwork',
      description: 'We need a packaging update: revised dieline and label artwork for the carton.',
      businessArea: 'design',
    }),
    ctx(),
  );

  it('routes design work to the designer', () => {
    expect(slug(decision.primaryOwnerPersonId)).toBe('julienne');
  });

  it('does not hand packaging artwork to the coordinator', () => {
    expect(slug(decision.primaryOwnerPersonId)).not.toBe('paul');
  });

  it('lets the coordinator coordinate delivery', () => {
    expect(decision.leverage.classification).toBe('PAUL_CAN_PROJECT_MANAGE');
    expect(slug(decision.projectManagerPersonId)).toBe('paul');
  });
});

describe('Test 5 — invoice needs payment', () => {
  const decision = routeOwnership(
    request({
      title: 'Vendor invoice needs payment',
      description: 'A past due invoice from a vendor needs to be paid; they sent remittance details.',
      businessArea: 'finance',
    }),
    ctx(),
  );

  it('routes payment execution to accounts payable', () => {
    expect(slug(decision.primaryOwnerPersonId)).toBe('peter');
  });

  it('does NOT route it to the bookkeeper just because it is financial', () => {
    expect(slug(decision.primaryOwnerPersonId)).not.toBe('brian');
    expect(decision.collaborators.map((c) => slug(c.personId))).not.toContain('brian');
  });

  it('does not create a duplicate coordination task', () => {
    expect(decision.leverage.classification).toBe('SPECIALIST_REQUIRED');
    expect(decision.projectManagerPersonId).toBeNull();
  });
});

describe('Test 6 — weekly bookkeeping discrepancy', () => {
  const decision = routeOwnership(
    request({
      title: 'Weekly bookkeeping discrepancy in the ledger',
      description: 'The weekly reconciliation shows a discrepancy that needs investigating in the books.',
      businessArea: 'finance',
    }),
    ctx(),
  );

  it('routes to the bookkeeper', () => {
    expect(slug(decision.primaryOwnerPersonId)).toBe('brian');
  });

  it('does NOT route to accounts payable — no payment is involved', () => {
    expect(slug(decision.primaryOwnerPersonId)).not.toBe('peter');
  });
});

describe('Test 7 — Google paid-media performance falls', () => {
  const decision = routeOwnership(
    request({
      title: 'Google Ads ROAS down materially week over week',
      description: 'Google ads ROAS fell sharply; ad spend is flat but conversions dropped.',
      businessArea: 'marketing',
    }),
    ctx(),
  );

  it('makes the agency the external investigation owner', () => {
    expect(decision.externalCounterpartyOrganizationId).toBe('quartile');
  });

  it('does not assign the investigation to an internal person', () => {
    expect(decision.primaryOwnerPersonId).toBeNull();
  });

  it('lets the coordinator track the response', () => {
    expect(slug(decision.projectManagerPersonId)).toBe('paul');
  });

  it('does not put it in front of the CEO until there is a decision', () => {
    expect(decision.ceoRequired).toBe(false);
  });
});

describe('Test 8 — Zoom action item "Adi to look into X"', () => {
  const adi = ctx().team.getPersonBySlug('adi')!;

  it('does not blindly honour meeting attribution for research work', () => {
    const decision = routeOwnership(
      request({
        title: 'Look into sourcing a BP monitor',
        description: 'Investigate options and pricing for sourcing a blood pressure monitor.',
        businessArea: 'general',
        attributedToPersonId: adi.id,
        attributionSource: 'zoom',
        isInformationGathering: true,
        requiredCapabilities: ['research'],
      }),
      ctx(),
    );

    expect(slug(decision.primaryOwnerPersonId)).toBe('paul');
    expect(decision.leverage.classification).toBe('PAUL_CAN_RESEARCH');
    expect(decision.reason).toContain('attributed');
  });

  it('does honour attribution when the work genuinely needs the CEO', () => {
    const decision = routeOwnership(
      request({
        title: 'Adi to negotiate partnership terms with the retailer',
        description: 'Negotiate commercial terms directly.',
        businessArea: 'business_development',
        attributedToPersonId: adi.id,
        attributionSource: 'zoom',
        requiredCapabilities: ['negotiation', 'partnerships'],
        isStrategicDirection: true,
      }),
      ctx(),
    );

    expect(slug(decision.primaryOwnerPersonId)).toBe('adi');
    expect(decision.ceoRequired).toBe(true);
  });
});
