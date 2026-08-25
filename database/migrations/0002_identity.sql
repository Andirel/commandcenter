-- 0002_identity.sql
-- Organizations, people, and the capability graph.
--
-- Design premise (see docs/team-model.md): 120/Life is small and highly
-- cross-functional. Ownership is derived from a capability graph plus
-- accumulated evidence, NOT from an org chart. Nothing here hard-codes a name.

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
create table if not exists organizations (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text unique not null,          -- stable config key, e.g. 'radioactive_media'
  name                  text not null,
  organization_type     organization_type not null default 'other',
  domains               text[] not null default '{}',  -- email domains used for inference
  importance            int not null default 3 check (importance between 1 and 5),
  relationship_status   relationship_status not null default 'active',

  -- Who at 120/Life normally manages this relationship. Deliberately NOT
  -- inferred from "most recent email sender" -- see docs/team-model.md §9.
  relationship_owner_person_id uuid,
  execution_tracker_person_id  uuid,

  notes                 text,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists organizations_type_idx    on organizations (organization_type);
create index if not exists organizations_domains_idx on organizations using gin (domains);
create index if not exists organizations_name_trgm   on organizations using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- people
-- ---------------------------------------------------------------------------
create table if not exists people (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique,                       -- stable config key, e.g. 'paul'
  organization_id   uuid references organizations(id) on delete set null,

  name              text not null,
  email             text,
  alternate_emails  text[] not null default '{}',
  slack_user_id     text,
  zoom_identity     text,

  title             text,
  relationship_type relationship_type not null default 'unknown',
  internal_external internal_external not null default 'unknown',

  importance_score  int not null default 3 check (importance_score between 1 and 5),

  -- Discovery lifecycle. Authority is earned, never granted by one email.
  discovery_status  discovery_status not null default 'discovered',
  confidence        numeric(4,3) not null default 0.500 check (confidence between 0 and 1),

  -- Routing capacity signals. Refreshed by the workload refresh job.
  open_task_count       int not null default 0,
  overdue_task_count    int not null default 0,
  workload_capacity     numeric(4,3) not null default 1.000 check (workload_capacity between 0 and 1),
  routing_eligible      boolean not null default true,

  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),

  notes             text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Email is the strongest identity key, but is nullable (Slack-only people exist).
create unique index if not exists people_email_uniq    on people (lower(email)) where email is not null;
create unique index if not exists people_slack_uniq    on people (slack_user_id) where slack_user_id is not null;
create index        if not exists people_org_idx       on people (organization_id);
create index        if not exists people_status_idx    on people (discovery_status);
create index        if not exists people_name_trgm     on people using gin (name gin_trgm_ops);
create index        if not exists people_alt_email_idx on people using gin (alternate_emails);

alter table organizations
  drop constraint if exists organizations_relationship_owner_fkey;
alter table organizations
  add constraint organizations_relationship_owner_fkey
  foreign key (relationship_owner_person_id) references people(id) on delete set null;

alter table organizations
  drop constraint if exists organizations_execution_tracker_fkey;
alter table organizations
  add constraint organizations_execution_tracker_fkey
  foreign key (execution_tracker_person_id) references people(id) on delete set null;

-- ---------------------------------------------------------------------------
-- capabilities -- what kinds of work exist, independent of who does them
-- ---------------------------------------------------------------------------
create table if not exists capabilities (
  id             uuid primary key default gen_random_uuid(),
  name           text unique not null,                 -- e.g. 'manufacturing'
  description    text,
  business_area  text,
  -- Work requiring this capability generally cannot be delegated to a
  -- generalist coordinator (e.g. bookkeeping, manufacturing decisions).
  specialist_only boolean not null default false,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- person_capabilities -- the core of the routing engine
-- ---------------------------------------------------------------------------
create table if not exists person_capabilities (
  person_id          uuid not null references people(id) on delete cascade,
  capability_id      uuid not null references capabilities(id) on delete cascade,

  confidence         numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  proficiency        numeric(4,3) not null default 0.500 check (proficiency between 0 and 1),
  primary_secondary  primary_secondary not null default 'secondary',

  evidence_count     int not null default 0,
  last_evidence_at   timestamptz,

  -- A human asserted this. Evidence-driven updates must never silently
  -- overwrite a manually confirmed edge.
  manually_confirmed boolean not null default false,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (person_id, capability_id)
);

create index if not exists person_capabilities_cap_idx on person_capabilities (capability_id, confidence desc);

-- ---------------------------------------------------------------------------
-- organization_capabilities -- agencies and vendors have capabilities too
-- ---------------------------------------------------------------------------
create table if not exists organization_capabilities (
  organization_id    uuid not null references organizations(id) on delete cascade,
  capability_id      uuid not null references capabilities(id) on delete cascade,

  confidence         numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  proficiency        numeric(4,3) not null default 0.500 check (proficiency between 0 and 1),
  primary_secondary  primary_secondary not null default 'primary',

  evidence_count     int not null default 0,
  last_evidence_at   timestamptz,
  manually_confirmed boolean not null default false,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (organization_id, capability_id)
);

create index if not exists organization_capabilities_cap_idx
  on organization_capabilities (capability_id, confidence desc);

-- ---------------------------------------------------------------------------
-- responsibility_evidence -- WHY the system believes someone handles something
--
-- The system stores its reasons. Confidence without evidence is not allowed.
-- ---------------------------------------------------------------------------
create table if not exists responsibility_evidence (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid references people(id) on delete cascade,
  organization_id  uuid references organizations(id) on delete cascade,
  capability_id    uuid references capabilities(id) on delete cascade,

  source_event_id  uuid,                                -- FK added in 0003

  evidence_summary text not null,
  evidence_weight  numeric(4,3) not null default 1.000, -- strong signals count for more
  confidence       numeric(4,3) not null default 0.500 check (confidence between 0 and 1),

  created_at       timestamptz not null default now(),

  constraint responsibility_evidence_subject_ck
    check (person_id is not null or organization_id is not null)
);

create index if not exists responsibility_evidence_person_idx on responsibility_evidence (person_id, capability_id);
create index if not exists responsibility_evidence_org_idx    on responsibility_evidence (organization_id, capability_id);
