-- 0005_operations.sql
-- Operational tables: priority history, workflow runs, corrections,
-- business signals, Drive index, brief deliveries.

-- ---------------------------------------------------------------------------
-- priority_history -- what makes "moved #8 -> #2 because..." possible.
-- Without a reason column, a reordering is unexplainable, and an
-- unexplainable brief is one the CEO stops trusting.
-- ---------------------------------------------------------------------------
create table if not exists priority_history (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references tasks(id) on delete cascade,

  old_score        numeric(8,3),
  new_score        numeric(8,3),
  old_rank         int,
  new_rank         int,

  reason           text not null,
  trigger_event_id uuid references events(id) on delete set null,

  created_at       timestamptz not null default now()
);

create index if not exists priority_history_task_idx on priority_history (task_id, created_at desc);
create index if not exists priority_history_time_idx on priority_history (created_at desc);

-- ---------------------------------------------------------------------------
-- workflow_runs -- ingestion never silently drops an event
-- ---------------------------------------------------------------------------
create table if not exists workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  workflow_name   text not null,
  external_run_id text,

  started_at      timestamptz not null default now(),
  completed_at    timestamptz,

  status          workflow_run_status not null default 'running',
  error           text,

  items_seen      int not null default 0,
  items_processed int not null default 0,
  items_failed    int not null default 0,

  metadata        jsonb not null default '{}'::jsonb
);

create index if not exists workflow_runs_name_idx   on workflow_runs (workflow_name, started_at desc);
create index if not exists workflow_runs_status_idx on workflow_runs (status) where status in ('running','failed','partial');

-- ---------------------------------------------------------------------------
-- corrections -- humans telling the system it was wrong.
-- These are first-class training data, not error logs. Repeated corrections
-- of the same shape surface a proposed rule change for human confirmation;
-- the system never silently rewrites its own rules.
-- ---------------------------------------------------------------------------
create table if not exists corrections (
  id                   uuid primary key default gen_random_uuid(),

  task_id              uuid references tasks(id) on delete cascade,
  commitment_id        uuid references commitments(id) on delete cascade,
  event_id             uuid references events(id) on delete set null,

  correction_type      correction_type not null,
  corrected_by_person_id uuid references people(id) on delete set null,

  -- What the system thought vs. what is actually true.
  previous_value       jsonb,
  corrected_value      jsonb,
  note                 text,

  -- Set once this correction has been folded into capability confidence.
  applied_to_model     boolean not null default false,
  applied_at           timestamptz,

  created_at           timestamptz not null default now()
);

create index if not exists corrections_type_idx    on corrections (correction_type, created_at desc);
create index if not exists corrections_pending_idx on corrections (applied_to_model) where not applied_to_model;

-- ---------------------------------------------------------------------------
-- business_signals -- standardized output of upstream intelligence services
-- (Finaloop / Klaviyo / Gusto Claude connectors, Quartile, customer service).
-- We consume conclusions; we do not rebuild those systems.
-- ---------------------------------------------------------------------------
create table if not exists business_signals (
  id                 uuid primary key default gen_random_uuid(),

  signal_type        text not null,               -- 'cash_risk', 'roas_decline', ...
  business_area      text,
  source_system      source_system not null,

  severity           int not null default 3 check (severity between 1 and 10),
  severity_source    signal_severity_source not null default 'ai',

  summary            text not null,
  evidence           text,
  recommended_action text,

  -- Advisory only. The routing engine decides actual ownership; a signal
  -- naming "Peter, Mike, Adi" is a hint, not an assignment.
  likely_people      text[] not null default '{}',

  -- Aggregation window, for signals that represent a pattern rather than an
  -- event (e.g. repeated customer complaints).
  window_start       timestamptz,
  window_end         timestamptz,
  observation_count  int,

  task_id            uuid references tasks(id) on delete set null,
  event_id           uuid references events(id) on delete set null,

  processing_status  processing_status not null default 'pending',
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists business_signals_type_idx   on business_signals (signal_type, created_at desc);
create index if not exists business_signals_status_idx on business_signals (processing_status) where processing_status = 'pending';
create index if not exists business_signals_sev_idx    on business_signals (severity desc, created_at desc);

-- ---------------------------------------------------------------------------
-- drive_documents -- Drive provides CONTEXT. It never becomes the task system.
-- ---------------------------------------------------------------------------
create table if not exists drive_documents (
  id                uuid primary key default gen_random_uuid(),
  drive_file_id     text unique not null,

  name              text not null,
  url               text,
  folder_path       text,
  mime_type         text,
  file_type         text,                        -- 'document','spreadsheet','image','pdf','video'

  business_area     text,
  initiative_id     uuid references initiatives(id) on delete set null,

  owner_person_id   uuid references people(id) on delete set null,
  last_modified_at  timestamptz,
  modified_by_person_id uuid references people(id) on delete set null,

  summary           text,
  embedding         jsonb,                       -- pgvector swap-in planned for Phase 8

  indexed_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);

create index if not exists drive_documents_area_idx     on drive_documents (business_area);
create index if not exists drive_documents_modified_idx on drive_documents (last_modified_at desc);
create index if not exists drive_documents_name_trgm    on drive_documents using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- brief_deliveries -- what we told whom, and what changed since last time.
-- "CHANGED SINCE YESTERDAY" requires knowing what yesterday's brief said.
-- ---------------------------------------------------------------------------
create table if not exists brief_deliveries (
  id             uuid primary key default gen_random_uuid(),
  brief_type     text not null,                  -- 'daily_ceo','end_of_day','paul','mike','meeting_prep'
  recipient_person_id uuid references people(id) on delete set null,

  delivered_at   timestamptz not null default now(),
  channel        text,                           -- 'slack_dm','slack_channel','email'

  content        jsonb not null,                 -- structured brief for diffing
  rendered       text,                           -- what the human actually saw

  metadata       jsonb not null default '{}'::jsonb
);

create index if not exists brief_deliveries_type_idx on brief_deliveries (brief_type, delivered_at desc);

-- ---------------------------------------------------------------------------
-- routing_decisions -- audit trail of the owner-selection engine, so routing
-- quality can be measured against human judgment (Phase 3 exit criterion).
-- ---------------------------------------------------------------------------
create table if not exists routing_decisions (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid references tasks(id) on delete cascade,
  event_id           uuid references events(id) on delete set null,

  engine_version     text not null,
  input_snapshot     jsonb not null,
  output             jsonb not null,
  confidence         numeric(4,3),
  reason             text,

  -- Populated when a human corrects it; the pair (output, human_verdict) is
  -- the measurement set for routing accuracy.
  human_verdict      text,                       -- 'agreed','corrected','unreviewed'
  corrected_by_correction_id uuid references corrections(id) on delete set null,

  created_at         timestamptz not null default now()
);

create index if not exists routing_decisions_task_idx    on routing_decisions (task_id);
create index if not exists routing_decisions_verdict_idx on routing_decisions (human_verdict, created_at desc);
