-- 001_capabilities.sql
-- Capability catalogue. Kept in sync with config/capabilities.yaml by
-- scripts/seed.ts; this file exists so a database can be stood up with psql
-- alone if needed.
--
-- specialist_only gates the leverage engine: a coordinator may PROJECT-MANAGE
-- specialist work but must not be made its owner.

insert into capabilities (name, description, business_area, specialist_only) values
  ('strategy',             'Company direction, positioning, major business choices', 'strategy', false),
  ('project_management',   'Tracking work, chasing dependencies, keeping things from falling through', 'operations', false),
  ('research',             'Gathering information, comparing options, assembling inputs', 'general', false),
  ('coordination',         'Scheduling, organizing, aligning multiple parties', 'operations', false),
  ('follow_up',            'Chasing outstanding items until they arrive', 'operations', false),
  ('administration',       'Forms, paperwork, document collection, routine business tasks', 'operations', false),
  ('vendor_coordination',  'Working with vendors on logistics, documents, scheduling', 'operations', false),
  ('retail',               'Retailer relationships, onboarding, buyer communication', 'retail', false),
  ('podcast_advertising',  'Podcast ad placements, sourcing, campaign coordination', 'marketing', false),
  ('paid_media',           'Google, Bing, Amazon paid advertising management', 'marketing', true),
  ('organic_social',       'Organic social content, posting, content calendar', 'marketing', true),
  ('content_creation',     'Video, photo, written content production', 'marketing', true),
  ('graphic_design',       'Visual assets, mockups, creative deliverables', 'design', true),
  ('packaging_design',     'Packaging artwork, dielines, packaging updates', 'design', true),
  ('copywriting',          'Marketing copy, website copy, email copy', 'marketing', false),
  ('manufacturing',        'Production runs, manufacturer coordination, formulation execution', 'operations', true),
  ('inventory',            'Stock levels, forecasting, replenishment', 'operations', true),
  ('production',           'Production planning and scheduling', 'operations', true),
  ('supply_chain',         'Sourcing, components, supplier management', 'operations', true),
  ('logistics',            'Shipping, freight, 3PL, fulfillment operations', 'operations', true),
  ('fulfillment',          'Order fulfillment execution and exceptions', 'operations', true),
  ('website',              'Website changes, ecommerce storefront, site content', 'technology', true),
  ('technical',            'Technical implementation, systems, infrastructure', 'technology', true),
  ('integrations',         'System integrations, APIs, data flow between tools', 'technology', true),
  ('finance',              'Financial decisions, cash management, financial strategy', 'finance', false),
  ('accounts_payable',     'Invoice processing and vendor payment execution', 'finance', true),
  ('invoice_payments',     'Executing payments against approved invoices', 'finance', true),
  ('bookkeeping',          'Books, reconciliations, recurring financial management', 'finance', true),
  ('financial_reporting',  'Financial reports, weekly financials, statements', 'finance', true),
  ('customer_service',     'Customer inquiries, issues, support', 'customer', true),
  ('customer_feedback',    'Aggregating and interpreting customer sentiment', 'customer', false),
  ('research_grants',      'Research partnerships, grants, scientific collaboration', 'research', false),
  ('analytics',            'Business analytics, performance measurement, reporting', 'analytics', false),
  ('operations',           'General operational ownership and troubleshooting', 'operations', false),
  ('partnerships',         'Business development, partnership sourcing and negotiation', 'business_development', false),
  ('negotiation',          'Commercial negotiation on pricing and terms', 'business_development', false),
  ('legal_coordination',   'Coordinating with counsel; contract routing (never legal advice)', 'legal', false),
  ('interview_support',    'Podcast and interview subject-matter participation', 'marketing', true),
  ('product',              'Product decisions, formulation direction, roadmap', 'product', false),
  ('hiring',               'Hiring, contractor selection, team decisions', 'people', false)
on conflict (name) do update
  set description   = excluded.description,
      business_area = excluded.business_area,
      specialist_only = excluded.specialist_only;
