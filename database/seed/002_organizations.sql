-- 002_organizations.sql
-- Organizations. External partners are ORGANIZATIONS with individual people as
-- contacts -- never modeled as if they were employees.
--
-- Email domains are intentionally left empty: they are populated during
-- directory sync from real correspondence rather than guessed.

insert into organizations (slug, name, organization_type, importance, relationship_status, notes) values
  ('one_twenty_life',    '120/Life',           'internal',      5, 'active',
   'The company itself.'),
  ('radioactive_media',  'RadioActive Media',  'agency',        4, 'active',
   'Podcast advertising partner. Sources opportunities, coordinates placements, quotes pricing. The CEO decides whether an opportunity is attractive; RadioActive executes.'),
  ('quartile',           'Quartile',           'agency',        4, 'active',
   'Paid digital advertising across Google, Bing and Amazon. Owns investigation of paid-media performance changes; the CEO receives only material recommendations.')
on conflict (slug) do update
  set name              = excluded.name,
      organization_type = excluded.organization_type,
      importance        = excluded.importance,
      notes             = excluded.notes;

-- Organization capabilities. Agencies and vendors hold capabilities exactly as
-- people do -- this is what lets routing say "the agency owns this
-- investigation" rather than forcing an internal owner.
insert into organization_capabilities (organization_id, capability_id, confidence, proficiency, primary_secondary, manually_confirmed)
select o.id, c.id, v.confidence, v.proficiency, v.level::primary_secondary, true
from (values
  ('radioactive_media', 'podcast_advertising', 0.95, 0.90, 'primary'),
  ('quartile',          'paid_media',          0.95, 0.88, 'primary'),
  ('quartile',          'analytics',           0.75, 0.75, 'secondary')
) as v(org_slug, cap_name, confidence, proficiency, level)
join organizations o on o.slug = v.org_slug
join capabilities  c on c.name = v.cap_name
on conflict (organization_id, capability_id) do update
  set confidence = excluded.confidence,
      proficiency = excluded.proficiency,
      manually_confirmed = true;
