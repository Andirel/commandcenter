-- 003_people.sql
-- The current core team. A STARTING POINT, not a permanent org chart -- the
-- capability edges below are expected to drift as evidence accumulates.
--
-- Emails and Slack ids are deliberately absent: they are populated during
-- directory sync rather than guessed. Aliases ARE populated, because meeting
-- and chat attribution supplies display names and nothing else, and without
-- them "Michaelhammersley" resolves to nobody.

insert into people (slug, organization_id, name, title, relationship_type, internal_external,
                    importance_score, discovery_status, confidence, metadata, notes)
select v.slug, o.id, v.name, v.title, v.relationship_type::relationship_type,
       v.internal_external::internal_external, v.importance, 'confirmed'::discovery_status, 1.0,
       jsonb_build_object('aliases', v.aliases), v.notes
from (values
  ('adi',      'one_twenty_life', 'Adi',      'CEO',                                'employee',   'internal', 5,
   array['Adi Malik'],
   'Hands-on CEO who performs work across essentially all areas. Do not limit routing based on the CEO title; optimize to protect attention without preventing hands-on ownership.'),
  ('paul',     'one_twenty_life', 'Paul',     'Executive Assistant / Project Manager', 'employee', 'internal', 5,
   array[]::text[],
   'Highly capable VA functioning well beyond admin support. Major operational leverage point. Consider as project manager even when a specialist owns the task. Do not overload indiscriminately.'),
  ('mike',     'one_twenty_life', 'Mike',     'COO / CTO',                          'employee',   'internal', 5,
   array['Michaelhammersley','michaelhammersley','Michael Hammersley','Mike Hammersley'],
   'Broad operational AND technical ownership. Do not classify as only operations or only technology. The CEO may decide while Mike owns execution.'),
  ('ira',      'one_twenty_life', 'Ira',      'Customer Service',                   'employee',   'internal', 3,
   array['Ira Antelis'],
   'Customer-service trends should generate business signals, not a task per ticket. Do not route customer-originated strategic decisions here by default.'),
  ('peter',    'one_twenty_life', 'Peter',    'Accounts Payable',                   'employee',   'internal', 3,
   array[]::text[],
   'Handles invoice and payment EXECUTION. Not the owner of financial analysis. Do not conflate with the bookkeeper.'),
  ('brian',    'one_twenty_life', 'Brian',    'Bookkeeping / Financials',           'employee',   'internal', 3,
   array['Brian Ouellette'],
   'Handles bookkeeping and recurring financial management. Do not route invoice payment here; that is accounts payable.'),
  ('buster',   null,              'Buster',   'Organic Social',                     'contractor', 'external', 3,
   array[]::text[], 'Organic social content. Frequently collaborates with Chase.'),
  ('chase',    null,              'Chase',    'Organic Social',                     'contractor', 'external', 3,
   array['Chase Dinning'], 'Organic social content. Frequently collaborates with Buster.'),
  ('julienne', null,              'Julienne', 'Designer',                           'contractor', 'external', 3,
   array[]::text[], 'Packaging and graphic design. Coordination and approval usually sit elsewhere.'),
  ('susan',    null,              'Susan',    'Podcast / Interview Support',        'contractor', 'external', 2,
   array['Susan Schachter'],
   'Involved SELECTIVELY. Not the default owner of podcast activity -- include only when correspondence indicates an interview needs her.')
) as v(slug, org_slug, name, title, relationship_type, internal_external, importance, aliases, notes)
left join organizations o on o.slug = v.org_slug
on conflict (slug) do update
  set name              = excluded.name,
      title             = excluded.title,
      importance_score  = excluded.importance_score,
      metadata          = excluded.metadata,
      notes             = excluded.notes;

-- Capability edges. manually_confirmed = true means evidence accumulation may
-- record observations against these but must never silently overwrite them.
insert into person_capabilities (person_id, capability_id, confidence, proficiency, primary_secondary, manually_confirmed)
select p.id, c.id, v.confidence, v.proficiency, v.level::primary_secondary, true
from (values
  -- Adi: eligible to own work in EVERY area. This breadth is deliberate.
  ('adi','strategy',0.98,0.95,'primary'),            ('adi','partnerships',0.95,0.90,'primary'),
  ('adi','negotiation',0.93,0.90,'primary'),         ('adi','podcast_advertising',0.90,0.85,'primary'),
  ('adi','retail',0.88,0.85,'primary'),              ('adi','product',0.88,0.85,'primary'),
  ('adi','finance',0.85,0.80,'primary'),             ('adi','copywriting',0.80,0.80,'secondary'),
  ('adi','paid_media',0.75,0.70,'secondary'),        ('adi','analytics',0.78,0.75,'secondary'),
  ('adi','research_grants',0.75,0.70,'secondary'),   ('adi','legal_coordination',0.80,0.70,'primary'),
  ('adi','hiring',0.85,0.80,'primary'),              ('adi','website',0.60,0.55,'secondary'),
  ('adi','operations',0.65,0.65,'secondary'),        ('adi','vendor_coordination',0.70,0.70,'secondary'),
  -- Paul: the leverage point.
  ('paul','project_management',0.95,0.90,'primary'), ('paul','coordination',0.95,0.90,'primary'),
  ('paul','follow_up',0.95,0.92,'primary'),          ('paul','administration',0.95,0.90,'primary'),
  ('paul','research',0.88,0.82,'primary'),           ('paul','vendor_coordination',0.90,0.85,'primary'),
  ('paul','retail',0.75,0.72,'secondary'),           ('paul','operations',0.70,0.68,'secondary'),
  -- Mike: broad operations AND technology.
  ('mike','operations',0.95,0.92,'primary'),         ('mike','supply_chain',0.93,0.90,'primary'),
  ('mike','manufacturing',0.93,0.90,'primary'),      ('mike','inventory',0.92,0.90,'primary'),
  ('mike','production',0.92,0.90,'primary'),         ('mike','logistics',0.90,0.88,'primary'),
  ('mike','fulfillment',0.88,0.85,'primary'),        ('mike','website',0.90,0.85,'primary'),
  ('mike','technical',0.92,0.88,'primary'),          ('mike','integrations',0.90,0.85,'primary'),
  ('mike','vendor_coordination',0.82,0.80,'secondary'), ('mike','product',0.75,0.75,'secondary'),
  ('mike','analytics',0.65,0.65,'secondary'),
  -- Specialists.
  ('ira','customer_service',0.95,0.90,'primary'),    ('ira','customer_feedback',0.85,0.80,'primary'),
  ('peter','accounts_payable',0.95,0.90,'primary'),  ('peter','invoice_payments',0.95,0.92,'primary'),
  ('brian','bookkeeping',0.95,0.92,'primary'),       ('brian','financial_reporting',0.92,0.88,'primary'),
  ('brian','analytics',0.60,0.60,'secondary'),
  ('buster','organic_social',0.92,0.88,'primary'),   ('buster','content_creation',0.90,0.85,'primary'),
  ('chase','organic_social',0.92,0.88,'primary'),    ('chase','content_creation',0.90,0.85,'primary'),
  ('julienne','packaging_design',0.93,0.90,'primary'), ('julienne','graphic_design',0.92,0.90,'primary'),
  ('julienne','content_creation',0.65,0.65,'secondary'),
  ('susan','interview_support',0.85,0.85,'occasional')
) as v(person_slug, cap_name, confidence, proficiency, level)
join people       p on p.slug = v.person_slug
join capabilities c on c.name = v.cap_name
on conflict (person_id, capability_id) do update
  set confidence         = excluded.confidence,
      proficiency        = excluded.proficiency,
      primary_secondary  = excluded.primary_secondary,
      manually_confirmed = true;

-- Relationship ownership. Deliberately NOT inferred from "most recent email
-- sender": one message sent on someone's behalf does not transfer a relationship.
update organizations o
set relationship_owner_person_id = (select id from people where slug = 'adi'),
    execution_tracker_person_id  = (select id from people where slug = 'paul')
where o.slug in ('radioactive_media', 'quartile');
