/**
 * The leverage engine and approval classification.
 *
 * Leverage is where the system either creates value or creates busywork. The
 * failure mode to guard against is suggesting a hand-off that duplicates a
 * specialist — "Paul should follow up on the invoice" when Peter simply pays it.
 */
import { describe, expect, it } from 'vitest';
import { routeOwnership } from '../src/routing/owner-selection.js';
import { classifyApproval, canActAutonomously, escalate, resolveApprover } from '../src/routing/approval.js';
import { ctx, request, slug, workload } from './helpers.js';
import { config } from './helpers.js';

describe('leverage classification', () => {
  it('classifies pure coordination as fully ownable', () => {
    const d = routeOwnership(
      request({ title: 'Collect the signed vendor form and file it', isAdministrative: true, businessArea: 'retail' }),
      ctx(),
    );
    expect(d.leverage.classification).toBe('PAUL_CAN_OWN');
    expect(d.leverage.estimatedCeoHoursSaved).toBeGreaterThan(0);
  });

  it('classifies research as research, not generic ownership', () => {
    const d = routeOwnership(
      request({ title: 'Compare three freight quotes', isInformationGathering: true, requiredCapabilities: ['research'] }),
      ctx(),
    );
    expect(d.leverage.classification).toBe('PAUL_CAN_RESEARCH');
  });

  it('refuses to make the coordinator own specialist work', () => {
    const d = routeOwnership(
      request({ title: 'Reconcile the August ledger discrepancy', businessArea: 'finance' }),
      ctx(),
    );
    expect(slug(d.primaryOwnerPersonId)).toBe('brian');
    expect(d.leverage.classification).not.toBe('PAUL_CAN_OWN');
  });

  it('does not propose duplicating a specialist who already does the work', () => {
    const d = routeOwnership(
      request({ title: 'Vendor invoice past due, needs remittance', businessArea: 'finance' }),
      ctx(),
    );
    expect(d.leverage.classification).toBe('SPECIALIST_REQUIRED');
    expect(d.leverage.suggestedHandoff).toBeNull();
    expect(d.leverage.reason).toContain('no value');
  });

  it('stops proposing the coordinator once they hit the hard workload cap', () => {
    const cap = config.routingRules.leverage.max_open_tasks_hard;
    const d = routeOwnership(
      request({ title: 'Collect the signed vendor form', isAdministrative: true, businessArea: 'retail' }),
      ctx({ workload: workload({ paul: { open: cap + 5 } }) }),
    );
    expect(slug(d.primaryOwnerPersonId)).not.toBe('paul');
    expect(d.leverage.reason).toContain('capacity');
  });

  it('flags reduced confidence past the soft cap without refusing outright', () => {
    const soft = config.routingRules.leverage.max_open_tasks_soft;
    const d = routeOwnership(
      request({ title: 'Collect the signed vendor form', isAdministrative: true, businessArea: 'retail' }),
      ctx({ workload: workload({ paul: { open: soft + 1 } }) }),
    );
    expect(d.leverage.classification).toBe('PAUL_CAN_OWN');
    expect(d.leverage.reason).toContain('already carrying');
  });
});

describe('CEO attention modes', () => {
  it('separates approving a spend from doing the work', () => {
    const d = routeOwnership(
      request({ title: 'Approve the October production run budget', businessArea: 'operations', isApproval: true, valueAtStake: 50000 }),
      ctx(),
    );
    expect(d.ceoRequired).toBe(true);
    expect(d.ceoActionMode).toBe('APPROVE');
    // Someone else still does the work.
    expect(slug(d.primaryOwnerPersonId)).toBe('mike');
  });

  it('marks work the CEO must genuinely do personally as DO', () => {
    const d = routeOwnership(
      request({
        title: 'Negotiate partnership terms directly with the distributor',
        businessArea: 'business_development',
        requiredCapabilities: ['negotiation', 'partnerships'],
        isStrategicDirection: true,
      }),
      ctx(),
    );
    expect(slug(d.primaryOwnerPersonId)).toBe('adi');
    expect(d.ceoActionMode).toBe('DO');
    expect(d.leverage.classification).toBe('ADI_REQUIRED');
    expect(d.delegable).toBe(false);
  });

  it('keeps the CEO out entirely when nothing triggers involvement', () => {
    const d = routeOwnership(
      request({ title: 'File the completed retailer paperwork', isAdministrative: true, businessArea: 'retail' }),
      ctx(),
    );
    expect(d.ceoRequired).toBe(false);
    expect(d.ceoDependencyScore).toBe(0);
  });
});

describe('approval classification', () => {
  it('escalates only upward, never downward', () => {
    expect(escalate('GREEN', 'RED')).toBe('RED');
    expect(escalate('RED', 'GREEN')).toBe('RED');
    expect(escalate('YELLOW', 'GREEN')).toBe('YELLOW');
  });

  it('classifies anything contractual as RED', () => {
    expect(classifyApproval(request({ title: 'Review the supply agreement', isContractOrLegal: true }), config)).toBe('RED');
    expect(classifyApproval(request({ title: 'Counsel sent the NDA for signature' }), config)).toBe('RED');
  });

  it('classifies a large expenditure as RED regardless of wording', () => {
    expect(classifyApproval(request({ title: 'Media placement', valueAtStake: 40000 }), config)).toBe('RED');
  });

  it('classifies pricing discussions as at least YELLOW', () => {
    expect(classifyApproval(request({ title: 'Send the vendor our quote' }), config)).toBe('YELLOW');
  });

  it('never classifies a first message to a new contact as GREEN', () => {
    const cls = classifyApproval(request({ title: 'Thanks, received' }), config, { isNewContact: true });
    expect(cls).not.toBe('GREEN');
  });

  it('leaves routine internal acknowledgement GREEN', () => {
    expect(classifyApproval(request({ title: 'Confirm the meeting time for Thursday' }), config)).toBe('GREEN');
  });
});

describe('the sending gate', () => {
  it('blocks external sending while the global switch is off', () => {
    // This is the default posture and must hold for every class.
    for (const cls of ['GREEN', 'YELLOW', 'RED'] as const) {
      expect(canActAutonomously(cls, config, 'send_external')).toBeTruthy();
    }
  });

  it('blocks RED even if every global switch were on', () => {
    const permissive = {
      ...config,
      approvalRules: {
        ...config.approvalRules,
        global: { external_sending_enabled: true, draft_creation_enabled: true, internal_slack_posting_enabled: true },
      },
    };
    expect(canActAutonomously('RED', permissive, 'send_external')).toContain('never automated');
    expect(canActAutonomously('YELLOW', permissive, 'send_external')).toContain('human approval');
    expect(canActAutonomously('GREEN', permissive, 'send_external')).toBeNull();
  });

  it('permits internal posting, which briefs depend on', () => {
    expect(canActAutonomously('GREEN', config, 'post_internal')).toBeNull();
  });
});

describe('approver resolution', () => {
  it('routes operational approvals to the operational lead', () => {
    expect(resolveApprover('operations', 100, config)).toBe('mike');
  });

  it('escalates to the CEO above the value threshold regardless of area', () => {
    expect(resolveApprover('operations', 999999, config)).toBe('adi');
  });
});
