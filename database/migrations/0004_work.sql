-- 0004_work.sql
-- Initiatives, tasks, collaborators, commitments.
--
-- Key design decision: there is NO single `assignee` column. Real work at
-- 120/Life has a primary owner, a project manager, a decision maker, an
-- approver, collaborators, and often an external counterparty. Collapsing
-- those into one field destroys the information the product exists to provide.
-- See docs/team-model.md §2.

-- ---------------------------------------------------------------------------
-- initiatives
-- ---------------------------------------------------------------------------
create table if not exists initiatives (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  description              text,
  business_area            text,
  objective                text,

  primary_owner_person_id  uuid references people(id) on delete set null,
  project_manager_person_id uuid references people(id) on delete set null,
  decision_maker_person_id uuid references people(id) on delete set null,

  status                   initiative_status not null default 'active',
  strategic_importance     int not null default 3 check (strategic_importance between 1 and 5),
  target_date              date,
  success_definition       text,

  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists initiatives_status_idx on initiatives (status);
create index if not exists initiatives_area_idx   on initiatives (business_area);
create index if not exists initiatives_name_trgm  on initiatives using gin (name gin_trgm_ops);

-- Deferred FKs from 0003.
alter table meetings  drop constraint if exists meetings_initiative_fkey;
alter table meetings  add  constraint meetings_initiative_fkey
  foreign key (related_initiative_id) references initiatives(id) on delete set null;

alter table decisions drop constraint if exists decisions_initiative_fkey;
alter table decisions add  constraint decisions_initiative_fkey
  foreign key (initiative_id) references initiatives(id) on delete set null;

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  id                        uuid primary key default gen_random_uuid(),
  initiative_id             uuid references initiatives(id) on delete set null,

  title                     text not null,
  description               text,
  business_area             text,

  -- Ownership is multi-role by design.
  primary_owner_person_id   uuid references people(id) on delete set null,
  project_manager_person_id uuid references people(id) on delete set null,
  decision_maker_person_id  uuid references people(id) on delete set null,
  approver_person_id        uuid references people(id) on delete set null,
  external_counterparty_organization_id uuid references organizations(id) on delete set null,

  status                    task_status not null default 'proposed',
  deadline                  timestamptz,

  -- Priority inputs, stored decomposed so a score can always be EXPLAINED.
  impact_score              int not null default 3 check (impact_score between 0 and 5),
  urgency_score             int not null default 3 check (urgency_score between 0 and 5),
  risk_score                int not null default 0 check (risk_score between 0 and 5),
  relationship_score        int not null default 0 check (relationship_score between 0 and 5),
  ceo_dependency_score      int not null default 0 check (ceo_dependency_score between 0 and 5),
  effort_score              int not null default 2 check (effort_score between 0 and 5),
  blocker_score             int not null default 0 check (blocker_score between 0 and 5),
  strategic_importance      int not null default 3 check (strategic_importance between 0 and 5),

  base_priority_score       numeric(8,3) not null default 0,
  adjusted_priority_score   numeric(8,3) not null default 0,
  priority_rank             int,

  -- CEO dependency is NOT CEO ownership. `ceo_required` means Adi must be
  -- involved at all; `ceo_action_mode` says how much attention that costs.
  ceo_required              boolean not null default false,
  ceo_action_mode           action_mode,
  delegable                 boolean not null default true,
  leverage_class            leverage_class,

  waiting_on_person_id      uuid references people(id) on delete set null,
  waiting_on_organization_id uuid references organizations(id) on delete set null,
  waiting_since             timestamptz,

  follow_up_date            timestamptz,

  source_event_id           uuid references events(id) on delete set null,
  -- Provider conversation key (mail conversationId, Slack thread_ts, Zoom
  -- meeting UUID). Same-thread evidence is much stronger than a topical match,
  -- for both deduplication and completion detection.
  source_thread_id          text,
  confidence                numeric(4,3) not null default 0.700 check (confidence between 0 and 1),

  routing_reason            text,                     -- always populated; unexplained routing is a bug
  approval_class            approval_class not null default 'YELLOW',

  -- Set when this task was merged into another (status 'superseded').
  superseded_by_task_id     uuid references tasks(id) on delete set null,

  -- Completion detection: evidence-based, not checkbox-based.
  completion_confidence     numeric(4,3),
  completion_evidence       text,

  last_activity_at          timestamptz not null default now(),

  metadata                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  completed_at              timestamptz
);

create index if not exists tasks_status_idx        on tasks (status);
create index if not exists tasks_owner_idx         on tasks (primary_owner_person_id, status);
create index if not exists tasks_pm_idx            on tasks (project_manager_person_id, status);
create index if not exists tasks_decision_idx      on tasks (decision_maker_person_id, status);
create index if not exists tasks_rank_idx          on tasks (priority_rank) where status not in ('completed','cancelled','superseded');
create index if not exists tasks_deadline_idx      on tasks (deadline) where deadline is not null;
create index if not exists tasks_waiting_person_idx on tasks (waiting_on_person_id) where waiting_on_person_id is not null;
create index if not exists tasks_waiting_org_idx   on tasks (waiting_on_organization_id) where waiting_on_organization_id is not null;
create index if not exists tasks_initiative_idx    on tasks (initiative_id);
create index if not exists tasks_thread_idx        on tasks (source_thread_id) where source_thread_id is not null;
create index if not exists tasks_title_trgm        on tasks using gin (title gin_trgm_ops);
create index if not exists tasks_ceo_idx           on tasks (ceo_required, ceo_action_mode) where ceo_required;

-- ---------------------------------------------------------------------------
-- task_collaborators -- RACI-like flexibility; shared work is not forced
-- into single-owner semantics (e.g. Buster + Chase on organic social).
-- ---------------------------------------------------------------------------
create table if not exists task_collaborators (
  task_id     uuid not null references tasks(id) on delete cascade,
  person_id   uuid not null references people(id) on delete cascade,
  role        task_collaborator_role not null default 'contributor',
  added_at    timestamptz not null default now(),
  primary key (task_id, person_id, role)
);

create index if not exists task_collaborators_person_idx on task_collaborators (person_id);

-- ---------------------------------------------------------------------------
-- task_events -- the multi-source evidence trail behind one canonical task.
-- The same activity arriving via Zoom, Slack and email produces ONE task
-- with three attached events.
-- ---------------------------------------------------------------------------
create table if not exists task_events (
  task_id       uuid not null references tasks(id) on delete cascade,
  event_id      uuid not null references events(id) on delete cascade,
  relation      text not null default 'evidence',   -- 'origin','evidence','completion','update'
  note          text,
  created_at    timestamptz not null default now(),
  primary key (task_id, event_id, relation)
);

create index if not exists task_events_event_idx on task_events (event_id);

-- ---------------------------------------------------------------------------
-- commitments -- promises made, in both directions
-- ---------------------------------------------------------------------------
create table if not exists commitments (
  id                            uuid primary key default gen_random_uuid(),
  initiative_id                 uuid references initiatives(id) on delete set null,
  task_id                       uuid references tasks(id) on delete set null,

  committed_by_person_id        uuid references people(id) on delete set null,
  committed_by_organization_id  uuid references organizations(id) on delete set null,

  owed_to_person_id             uuid references people(id) on delete set null,
  owed_to_organization_id       uuid references organizations(id) on delete set null,

  direction                     commitment_direction not null default 'we_owe',
  description                   text not null,
  due_date                      timestamptz,
  status                        commitment_status not null default 'open',

  -- Follow-up ownership is distinct from the commitment itself: Adi may own
  -- the relationship while Paul does the chasing. See docs/team-model.md §9.
  follow_up_owner_person_id     uuid references people(id) on delete set null,
  last_followed_up_at           timestamptz,
  follow_up_count               int not null default 0,

  source_event_id               uuid references events(id) on delete set null,
  confidence                    numeric(4,3) not null default 0.700 check (confidence between 0 and 1),

  metadata                      jsonb not null default '{}'::jsonb,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  fulfilled_at                  timestamptz
);

create index if not exists commitments_status_idx    on commitments (status, due_date);
create index if not exists commitments_direction_idx on commitments (direction, status);
create index if not exists commitments_owed_org_idx  on commitments (owed_to_organization_id) where owed_to_organization_id is not null;
create index if not exists commitments_by_org_idx    on commitments (committed_by_organization_id) where committed_by_organization_id is not null;
create index if not exists commitments_followup_idx  on commitments (follow_up_owner_person_id, status);
