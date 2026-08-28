#!/usr/bin/env python3
"""
Assemble the 2026-08-28 pull file from what was actually in the inbox.

The window picks up where the 2026-08-25 pull stopped, so the ledger gets a
genuine second run rather than a re-read of the same evidence. Noise is kept in
deliberately — a triage table that never rejects anything says nothing about
whether the filter works.

Carries forward the finance, funnel, email and catalogue payloads from the
previous pull unchanged: those come from connectors on their own cadence and
did not need re-fetching to test the loop.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
prev = json.loads((ROOT / 'dist' / 'pull-2026-08-25.json').read_text())

WINDOW = {'from': '2026-08-25T09:00:00.000Z', 'to': '2026-08-28T07:45:00.000Z'}


def mail(ext_id, at, sender_name, sender_email, to, subject, summary, thread,
         body=None, org=None):
    e = {
        'eventType': 'email_received',
        'occurredAt': at,
        'sourceSystem': 'outlook',
        'sourceExternalId': ext_id,
        'actor': {'name': sender_name, 'email': sender_email, 'role': 'from'},
        'participants': [{'email': x, 'role': 'to'} for x in to],
        'subject': subject,
        'summary': summary,
        'threadId': thread,
    }
    if body:
        e['body'] = body
    if org:
        e['organizationId'] = org
    return e


events = [
    # --- substantive -------------------------------------------------------
    mail(
        'rm-sports-hosts-pricing', '2026-08-27T22:28:41.000Z',
        'Jhonathan Aguirre', 'jhonathan@radioactivemedia.com',
        ['adi@120life.com', 'ira@120life.com', 'mike@120life.com'],
        'Re: Sports Podcast Personalities to Explore',
        'Pricing is in on the six-figure hosts: Stephen A. Smith $180k (SiriusXM radio a '
        'cheaper alternative), Sharpe/Ochocinco $250k, Cowherd $150k, Nick Wright $125k. '
        'RadioActive says none are test-worthy at that price. Six hosts still pending.',
        'thr-sports-hosts',
        body=(
            'Hello Adi, Just wanted to keep you updated and let you know we are still waiting to '
            'receive information on some of the hosts. In the meantime, I wanted to note the hosts '
            'you mentioned that require a 6+ figure contract, since at that price point it would '
            'not be test-worthy. Stephen A. Smith requires a $180,000 commitment for his podcast, '
            'but does have a radio show on SiriusXM that may be an alternative. Colin Cowherd '
            'requires a $150,000 commitment. Nick Wright requires a $125,000 commitment. Shannon '
            'Sharpe and Chad Ochocinco Johnson require a $250,000 commitment. Jason Whitlock, Dan '
            'Dakich, Craig Carton, Pat McAfee, Mike Francesa and Dan Le Batard are still pending.'
        ),
        org='radioactive_media',
    ),
    mail(
        'radial-delinquent-po', '2026-08-28T03:59:13.000Z',
        'Radial Exchange Compliance', 'excdsprod@radial.com',
        ['adi@120life.com'],
        'Delinquent Shipment for the Exchange for 120Life LLC (22297202)',
        'Order 0239052576 is 24 hours overdue and may be subject to compliance charges. '
        'Please review the status of this order and communicate a revised ship date.',
        'thr-asn',
        body=(
            'Order 0239052576 is 24 hours overdue and may be subject to compliance charges. '
            'Please review the status of this order and communicate a revised ship date. '
            'Please navigate to the Radial VendorNet portal to update the order.'
        ),
    ),
    mail(
        'radial-delinquent-list', '2026-08-28T04:02:27.000Z',
        'Radial Exchange Compliance', 'excdsprod@radial.com',
        ['adi@120life.com', 'mike@120life.com'],
        '120/LIFE LLC DELINQUENT ORDERS',
        'The attached list of POs for the Exchange have not been Shipped and/or Invoiced in '
        'Radial/VendorNet and may be subject to compliance charges. Each PO must be updated '
        'in Radial/VendorNet.',
        'thr-delinquent-list',
    ),
    mail(
        'dscopify-collaborator', '2026-08-28T07:16:36.000Z',
        'Ashvin Gunga', 'hello@dscopify.com',
        ['mike@120life.com', 'adi@120life.com'],
        'Re: [EXTERNAL] Re: AAFES/Exchange x Radial System to System Integration - 120/Life LLC (22297202)',
        "I've submitted a collaborator request on Shopify (the previous one expired). "
        'Please approve it so I can check the issue.',
        'thr-dscopify',
        body=(
            "Hello Mike, I've submitted collaborator request on Shopify (since previous one is "
            'expired). Please approve it so I can check the issue. Ashvin Gunga, Dscopify.'
        ),
    ),
    mail(
        'nutriient-testing-quote', '2026-08-27T16:14:44.000Z',
        'Whitney', 'whitney@nutriient.biz',
        ['mike@120life.com', 'adi@120life.com'],
        'Re: Testing for Upcoming 120/Life Stickpack Production Run',
        'Heavy metals testing for each finished product is $150. For individual raw ingredients '
        'the cost varies; if you let me know which ingredients you would like tested I can '
        'request an accurate quote from the lab.',
        'thr-nutriient',
        body=(
            'Hi Mike, Heavy metals testing for each finished product is $150. For individual raw '
            'ingredients, the cost varies depending on the ingredient. If you let me know which '
            'ingredients you would like tested, I can request an accurate quote from the lab.'
        ),
    ),
    mail(
        'faire-beyondhealthy', '2026-08-27T19:38:31.000Z',
        'Faire', 'updates@info.faire.com',
        ['adi@120life.com'],
        'Reminder: Review and accept your new order from BeyondHealthy',
        'A new wholesale order from BeyondHealthy is waiting to be reviewed and accepted in '
        'the Faire portal.',
        'thr-faire-bh',
    ),
    mail(
        'rm-prelog-0831', '2026-08-27T23:06:31.000Z',
        'Jhonathan Aguirre', 'jhonathan@radioactivemedia.com',
        ['adi@120life.com'],
        '120Life Pre Log',
        'Here are your pre-logs for the week of 8/31/26. Let us know if you have any questions.',
        'thr-prelog',
        org='radioactive_media',
    ),
    mail(
        'walmart-2sv', '2026-08-27T18:05:25.000Z',
        'Walmart Marketplace', 'no-reply@mpsend.walmart.com',
        ['adi@120life.com'],
        'Action required: Set up 2-Step Verification',
        'Complete 2-Step Verification setup today to avoid interruptions to the Walmart '
        'Marketplace seller account.',
        'thr-walmart-2sv',
    ),

    # --- noise, kept so triage has something to reject ----------------------
    mail('shopify-payout-1', '2026-08-28T05:29:21.000Z', 'Shopify', 'mailer@shopify.com',
         ['adi@120life.com'], 'Payout for Aug 28, 2026 ($572.10 USD)',
         '$572.10 USD will be deposited to your bank account in 1-2 business days.', 'thr-payout-1'),
    mail('shopify-payout-2', '2026-08-28T01:59:50.000Z', 'Shopify', 'mailer@shopify.com',
         ['adi@120life.com'], 'Payout for Aug 28, 2026 ($6,020.83 USD)',
         '$6,020.83 USD will be deposited to your bank account in 1-2 business days.', 'thr-payout-2'),
    mail('shipbob-payment', '2026-08-28T05:06:42.000Z', 'ShipBob', 'noreply@shipbob.com',
         ['adi@120life.com'], "We've received your payment",
         'We have charged the bank account ending 7989 for $1313.22 USD.', 'thr-shipbob'),
    mail('gusto-payroll', '2026-08-27T22:19:39.000Z', 'Gusto', 'gustonoreply@gusto.com',
         ['adi@120life.com'], '120 LIFE LLC: Payroll on AutoPilot confirmed for Aug 16-Aug 31',
         "We'll debit $12,073.26 from the bank account ending in 7989 at 6pm CDT on Fri Aug 28.",
         'thr-gusto-payroll'),
    mail('starwest-promo', '2026-08-27T22:32:02.000Z', 'Starwest Botanicals',
         'ingredients@starwest-botanicals.com', ['adi@120life.com'],
         'Limited Time: Save Big on Fall Essentials',
         'Save up to 25% on select fall seasonings. Stock up now. View in your browser. Unsubscribe.',
         'thr-starwest'),
    mail('intelligems-bfcm', '2026-08-27T20:16:25.000Z', 'Intelligems', 'info@intelligems.io',
         ['adi@120life.com'], 'Everything you need for BFCM',
         'Plus Gruns on offer testing. View in your browser. Unsubscribe.', 'thr-intelligems'),
    mail('walmart-release-notes', '2026-08-27T18:31:46.000Z', 'Walmart Marketplace',
         'no-reply@mpsend.walmart.com', ['adi@120life.com'],
         'Walmart Marketplace Release Notes | August, Issue 2 of 2',
         'Introducing 3 new APIs to streamline Listing Quality and inventory management. '
         'View all Release Notes on Marketplace Learn.', 'thr-walmart-notes'),
    mail('webgility-nexus', '2026-08-27T18:17:12.000Z', 'John May', 'john.may@webgility.com',
         ['adi@120life.com'], "Hey Adi, Nexus doesn't send a warning. It sends a notice.",
         'Live with Avalara, Sep 16, see if your expansion triggered nexus. Unsubscribe.',
         'thr-webgility'),
    mail('readai-digest', '2026-08-27T21:02:17.000Z', 'Read AI', 'executiveassistant@e.read.ai',
         ['adi@120life.com'], 'Eureka Sync on August 26, 2026 | Read Meeting Report',
         "We noticed you still haven't viewed the meeting report Jay Sebben shared with you.",
         'thr-readai'),
    mail('quarantine-digest', '2026-08-27T20:05:56.000Z', 'GoDaddy',
         'do-not-reply@cloud-protect.net', ['adi@120life.com'],
         'Quarantine List - GoDaddy Email Encryption',
         'Quarantine digest. Sign in to your account to manage quarantined messages.',
         'thr-quarantine'),
    mail('dive-newsletter', '2026-08-27T17:59:25.000Z', 'Daily Dive',
         'newsletter@divenewsletter.com', ['adi@120life.com'],
         'Aug. 27 - $100B SpaceX project | DOE minerals investment',
         'DOE proposes $10M for critical minerals research. View online. Signup.', 'thr-dive'),
    mail('gusto-webinar', '2026-08-27T16:11:24.000Z', 'Gusto', 'gustonoreply@gusto.com',
         ['adi@120life.com'], "It's not too late! Register for the Benefits 101 Webinar on 9/3",
         'RSVP now to save your seat. Unsubscribe.', 'thr-gusto-webinar'),
]

# --- interpretations -------------------------------------------------------
KEEP = {
    'rm-sports-hosts-pricing': {
        'summary': 'RadioActive returned pricing on the sports podcast hosts. Four require '
                   'six-figure commitments; the agency judges them not test-worthy at that price.',
        'businessArea': 'marketing', 'materiality': 'high', 'createsTask': True,
        'taskTitle': 'Decide which sports podcast hosts to pursue now that pricing is in',
        'taskDescription': 'Stephen A. Smith $180k (SiriusXM radio a cheaper alternative), Colin '
                           'Cowherd $150k, Nick Wright $125k, Sharpe/Ochocinco $250k. RadioActive '
                           'advises against testing at those levels. Remaining hosts still pending.',
        'requiredCapabilities': ['podcast_advertising'],
        'deadline': None, 'valueAtStake': 180000,
        'priorityHints': {'impact': 5, 'urgency': 4, 'risk': 3, 'effort': 2},
        'flags': {'isDecision': True, 'isStrategicDirection': True},
        'suggestedOwnerHint': None, 'confidence': 0.93,
        'reasoning': 'Concrete prices on a spend decision only the CEO makes.',
    },
    'radial-delinquent-po': {
        'summary': 'Radial escalated: PO 0239052576 is now 24 hours overdue and exposed to '
                   'compliance charges.',
        'businessArea': 'fulfillment', 'materiality': 'high', 'createsTask': True,
        'taskTitle': 'Ship or re-date PO 0239052576 before Exchange compliance charges land',
        'taskDescription': 'Order is 24 hours overdue in Radial/VendorNet. Either ship it or '
                           'communicate a revised ship date.',
        'requiredCapabilities': ['fulfillment'],
        'deadline': '2026-08-28T23:59:00.000Z', 'valueAtStake': None,
        'priorityHints': {'impact': 4, 'urgency': 5, 'risk': 4, 'effort': 2},
        'flags': {}, 'suggestedOwnerHint': 'mike', 'confidence': 0.92,
        'reasoning': 'Named PO with a compliance deadline already passed.',
    },
    'radial-delinquent-list': {
        'summary': 'A broader list of Exchange POs are unshipped or uninvoiced in VendorNet.',
        'businessArea': 'fulfillment', 'materiality': 'moderate', 'createsTask': True,
        'taskTitle': 'Clear the delinquent Exchange PO list in Radial/VendorNet',
        'taskDescription': 'Multiple POs not shipped and/or invoiced; each must be updated '
                           'individually in the portal to avoid compliance charges.',
        'requiredCapabilities': ['fulfillment'],
        'deadline': None, 'valueAtStake': None,
        'priorityHints': {'impact': 4, 'urgency': 4, 'risk': 4, 'effort': 3},
        'flags': {}, 'suggestedOwnerHint': 'mike', 'confidence': 0.88,
        'reasoning': 'Recurring compliance exposure across several orders.',
    },
    'dscopify-collaborator': {
        'summary': 'Dscopify needs the expired Shopify collaborator request approved before they '
                   'can investigate the Radial integration issue.',
        'businessArea': 'fulfillment', 'materiality': 'moderate', 'createsTask': True,
        'taskTitle': 'Approve the Dscopify Shopify collaborator request',
        'taskDescription': 'The previous collaborator access expired. Dscopify is blocked on the '
                           'AAFES/Radial system-to-system integration until it is re-approved.',
        'requiredCapabilities': ['administration'],
        'deadline': None, 'valueAtStake': None,
        'priorityHints': {'impact': 3, 'urgency': 4, 'risk': 2, 'effort': 1},
        'flags': {'isAdministrative': True}, 'suggestedOwnerHint': 'mike', 'confidence': 0.9,
        'reasoning': 'A vendor is blocked on one approval click.',
    },
    'nutriient-testing-quote': {
        'summary': 'Nutriient quoted $150 per finished product for heavy metals testing and asked '
                   'which raw ingredients to quote individually.',
        'businessArea': 'production', 'materiality': 'moderate', 'createsTask': True,
        'taskTitle': 'Choose which raw ingredients to heavy-metals test for the stickpack run',
        'taskDescription': 'Finished product testing is $150 each. Raw ingredient pricing varies '
                           'and Nutriient needs a list before they can quote the lab.',
        'requiredCapabilities': ['manufacturing'],
        'deadline': None, 'valueAtStake': None,
        'priorityHints': {'impact': 3, 'urgency': 3, 'risk': 3, 'effort': 2},
        'flags': {'isDecision': True}, 'suggestedOwnerHint': 'mike', 'confidence': 0.9,
        'reasoning': 'A supplier is waiting on a specific answer to proceed.',
    },
    'faire-beyondhealthy': {
        'summary': 'A wholesale order from BeyondHealthy is waiting for acceptance on Faire.',
        'businessArea': 'retail', 'materiality': 'moderate', 'createsTask': True,
        'taskTitle': 'Review and accept the BeyondHealthy wholesale order on Faire',
        'taskDescription': 'New order sitting unaccepted in the Faire portal.',
        'requiredCapabilities': ['retail_accounts'],
        'deadline': None, 'valueAtStake': None,
        'priorityHints': {'impact': 3, 'urgency': 4, 'risk': 2, 'effort': 1},
        'flags': {'isAdministrative': True}, 'suggestedOwnerHint': None, 'confidence': 0.85,
        'reasoning': 'Revenue waiting on an acceptance click.',
    },
    'walmart-2sv': {
        'summary': 'Walmart Marketplace requires 2-Step Verification setup to avoid account '
                   'interruption.',
        'businessArea': 'retail', 'materiality': 'low', 'createsTask': True,
        'taskTitle': 'Set up 2-Step Verification on the Walmart Marketplace account',
        'taskDescription': 'Required to avoid interruptions to the seller account.',
        'requiredCapabilities': ['administration'],
        'deadline': None, 'valueAtStake': None,
        'priorityHints': {'impact': 2, 'urgency': 3, 'risk': 3, 'effort': 1},
        'flags': {'isAdministrative': True}, 'suggestedOwnerHint': None, 'confidence': 0.82,
        'reasoning': 'Small administrative task with an account-access risk behind it.',
    },
    # Received and read, but implies nothing to do.
    'rm-prelog-0831': {
        'summary': 'RadioActive sent the pre-logs for the week of 8/31.',
        'businessArea': 'marketing', 'materiality': 'low', 'createsTask': False,
        'taskTitle': '', 'taskDescription': '', 'requiredCapabilities': [],
        'deadline': None, 'valueAtStake': None,
        'priorityHints': {'impact': 1, 'urgency': 1, 'risk': 0, 'effort': 1},
        'flags': {}, 'suggestedOwnerHint': None, 'confidence': 0.85,
        'reasoning': 'Routine weekly delivery; nothing is asked for.',
    },
    'gusto-payroll': {
        'summary': 'Payroll of $12,073.26 is confirmed and debits Aug 28.',
        'businessArea': 'finance', 'materiality': 'moderate', 'createsTask': False,
        'taskTitle': '', 'taskDescription': '', 'requiredCapabilities': [],
        'deadline': None, 'valueAtStake': 12073.26,
        'priorityHints': {'impact': 2, 'urgency': 1, 'risk': 1, 'effort': 1},
        'flags': {}, 'suggestedOwnerHint': None, 'confidence': 0.9,
        'reasoning': 'Confirmation of an automated run; no action implied.',
    },
}

DROP = {
    'shopify-payout-1': 'automated_notification',
    'shopify-payout-2': 'automated_notification',
    'shipbob-payment': 'automated_notification',
    'starwest-promo': 'newsletter',
    'intelligems-bfcm': 'newsletter',
    'walmart-release-notes': 'newsletter',
    'webgility-nexus': 'newsletter',
    'readai-digest': 'automated_notification',
    'quarantine-digest': 'automated_notification',
    'dive-newsletter': 'newsletter',
    'gusto-webinar': 'newsletter',
}

interpretations = {}
for ext_id, interp in KEEP.items():
    interpretations[f'email_triage:{ext_id}'] = {
        'worthInterpreting': True, 'category': 'business_correspondence',
        'reason': 'Real correspondence from a person or a system that needs a response.',
        'confidence': 0.9,
    }
    interpretations[f'email_classification:{ext_id}'] = interp

for ext_id, category in DROP.items():
    interpretations[f'email_triage:{ext_id}'] = {
        'worthInterpreting': False, 'category': category,
        'reason': 'Bulk or automated; nothing is asked of anyone.',
        'confidence': 0.92,
    }

pull = {
    'window': WINDOW,
    'events': events,
    'meetings': [],
    'commitments': [],
    'interpretations': interpretations,
    'proposals': prev.get('proposals', []),
    'finaloopPnl': prev.get('finaloopPnl'),
    'shopifySales': prev.get('shopifySales'),
    'shopifySessions': prev.get('shopifySessions'),
    'klaviyoFlows': prev.get('klaviyoFlows'),
    'shopifyCatalogue': prev.get('shopifyCatalogue'),
    'shopifyUnitsSold': prev.get('shopifyUnitsSold'),
}

out = ROOT / 'dist' / 'pull-2026-08-28.json'
out.write_text(json.dumps(pull, indent=1))
print(f'wrote {out}  —  {len(events)} events, {len(KEEP)} kept, {len(DROP)} dropped')
