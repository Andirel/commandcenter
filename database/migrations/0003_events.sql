-- 0003_events.sql
-- Append-oriented evidence layer: events, meetings, decisions, AI interpretations.
--
-- Invariant: Outlook / Slack / Zoom / Drive are EVIDENCE. Postgres is STATE.
-- Rows in `events` are never mutated after processing except for their
-- processing_status bookkeeping.

create table if not exists events (
  id                    uuid primary key default gen_random_uuid(),

  event_type            text not null,          -- 'email_received', 'slack_message', ...
  occurred_at           timestamptz not null,

  source_system         source_system not null,
  source_external_id    text,                   -- provider id; dedup key with source_system

  actor_person_id       uuid references people(id) on delete set null,
  organization_id       uuid references organizations(id) on delete set null,

  subject               text,
  summary               text,

  -- Prefer references over copies: raw bodies stay in the source system where
  -- retention and access control already exist (see docs/security.md).
  raw_reference         text,
  raw_payload_reference text,
  raw_payload           jsonb,                  -- only when a reference is impossible

  processing_status     processing_status not null default 'pending',
  processing_error      text,
  processed_at          timestamptz,

  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

-- First line of defense against reprocessing the same provider object.
create unique index if not exists events_source_uniq
  on events (source_system, source_external_id)
  where source_external_id is not null;

create index if not exists events_occurred_idx on events (occurred_at desc);
create index if not exists events_status_idx   on events (processing_status) where processing_status in ('pending','needs_review','failed');
create index if not exists events_actor_idx    on events (actor_person_id, occurred_at desc);
create index if not exists events_org_idx      on events (organization_id, occurred_at desc);

-- Participants of an event beyond the actor (email recipients, channel members).
create table if not exists event_participants (
  event_id  uuid not null references events(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  role      text not null default 'participant',   -- 'to','cc','mentioned','attendee'
  primary key (event_id, person_id, role)
);

create index if not exists event_participants_person_idx on event_participants (person_id);

-- Deferred FK from 0002.
alter table responsibility_evidence
  drop constraint if exists responsibility_evidence_event_fkey;
alter table responsibility_evidence
  add constraint responsibility_evidence_event_fkey
  foreign key (source_event_id) references events(id) on delete set null;

-- ---------------------------------------------------------------------------
-- meetings -- Zoom is a first-class source of operational state
-- ---------------------------------------------------------------------------
create table if not exists meetings (
  id                    uuid primary key default gen_random_uuid(),

  zoom_meeting_id       text,
  zoom_meeting_uuid     text unique,
  calendar_event_id     text,

  topic                 text,
  started_at            timestamptz,
  ended_at              timestamptz,

  -- The original Zoom output is preserved verbatim. Normalization is additive:
  -- we must always be able to show what the meeting actually said.
  summary_original      text,
  original_next_steps   jsonb not null default '[]'::jsonb,
  summary_normalized    text,

  related_initiative_id uuid,                      -- FK added in 0004
  source_url            text,

  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists meetings_started_idx on meetings (started_at desc);

create table if not exists meeting_attendees (
  meeting_id      uuid not null references meetings(id) on delete cascade,
  person_id       uuid not null references people(id) on delete cascade,
  attendance_type attendance_type not null default 'attendee',
  primary key (meeting_id, person_id)
);

create index if not exists meeting_attendees_person_idx on meeting_attendees (person_id);

-- ---------------------------------------------------------------------------
-- decisions -- what the company has actually decided, and why
-- ---------------------------------------------------------------------------
create table if not exists decisions (
  id                 uuid primary key default gen_random_uuid(),
  initiative_id      uuid,                         -- FK added in 0004
  meeting_id         uuid references meetings(id) on delete set null,

  decision           text not null,
  reasoning          text,

  made_by_person_id  uuid references people(id) on delete set null,

  decision_date      timestamptz not null default now(),
  source_event_id    uuid references events(id) on delete set null,

  confidence         numeric(4,3) not null default 0.700 check (confidence between 0 and 1),
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists decisions_date_idx on decisions (decision_date desc);

-- ---------------------------------------------------------------------------
-- ai_interpretations -- every AI output is persisted, versioned, and auditable.
-- This is what makes "does prompt v3 route better than v2?" answerable.
-- ---------------------------------------------------------------------------
create table if not exists ai_interpretations (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid references events(id) on delete cascade,

  model               text not null,
  prompt_version      text not null,
  interpretation_type text not null,               -- 'email_classification', 'owner_routing', ...

  structured_output   jsonb not null,
  confidence          numeric(4,3) check (confidence between 0 and 1),

  input_tokens        int,
  output_tokens       int,
  latency_ms          int,

  validation_ok       boolean not null default true,
  validation_error    text,

  created_at          timestamptz not null default now()
);

create index if not exists ai_interpretations_event_idx on ai_interpretations (event_id);
create index if not exists ai_interpretations_type_idx  on ai_interpretations (interpretation_type, created_at desc);
