-- 0007_agents.sql
-- The agent layer: proposals, agents, jobs, results and measured performance.
--
-- Purely additive. No existing table is altered and no existing column changes
-- meaning, because the brief is explicit that the agent architecture extends
-- Command Center rather than replacing it — and because a migration that
-- reshapes `tasks` to suit a new subsystem is how a working system acquires a
-- second, incompatible model of the same thing.
--
-- Two design choices carry most of the safety here:
--
--   1. Permissions are a text[] validated against an application-level enum
--      rather than a Postgres enum. The forbidden set (send, spend, modify
--      production) must be enforceable in one place that both the database
--      and the running code agree on, and adding a member to a pg enum is a
--      migration while adding one to `AgentPermission` is a code review.
--      A check constraint below rejects the forbidden values outright, so the
--      database refuses them even if the application is wrong.
--
--   2. Every impact figure carries its basis. A column that can hold either a
--      measured saving or a guess, with no way to tell which, is worse than
--      no column: it will be quoted.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$
begin
  -- Proposed is not approved, and approved is not active. Three states because
  -- they answer different questions; collapsing them is how a proposal
  -- quietly starts running.
  if not exists (select 1 from pg_type where typname = 'agent_status') then
    create type agent_status as enum (
      'proposed', 'approved', 'rejected', 'deferred', 'active', 'paused', 'retired'
    );
  end if;

  -- Three of the four outcomes mean nothing gets built.
  if not exists (select 1 from pg_type where typname = 'agent_candidate_verdict') then
    create type agent_candidate_verdict as enum (
      'agent', 'capability', 'deterministic_workflow', 'not_worth_it'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'agent_job_status') then
    create type agent_job_status as enum (
      'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'needs_human'
    );
  end if;

  -- How a coverage claim was reached, so a thin report cannot be quoted as a
  -- thick one later.
  if not exists (select 1 from pg_type where typname = 'coverage_verdict') then
    create type coverage_verdict as enum ('sufficient', 'provisional', 'insufficient');
  end if;

  -- Whether an impact number was observed, inferred, credited or unknown.
  if not exists (select 1 from pg_type where typname = 'impact_basis') then
    create type impact_basis as enum ('measured', 'estimated', 'attributed', 'unknown');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- architecture_reviews -- one row per Architect run.
--
-- Kept as history rather than overwritten, so "the architecture changed when
-- we backfilled Zoom" is answerable. The coverage verdict is stored WITH the
-- review because it governs how that review may be read, and separating them
-- would let a later reader treat a demonstration as a recommendation.
-- ---------------------------------------------------------------------------
create table if not exists architecture_reviews (
  id                uuid primary key default gen_random_uuid(),

  generated_at      timestamptz not null default now(),
  coverage          coverage_verdict not null,
  coverage_statement text not null,

  window_start      timestamptz,
  window_end        timestamptz,
  span_days         int not null default 0,
  active_days       int not null default 0,
  work_items        int not null default 0,
  sync_count        int not null default 0,

  -- Named and specific, so absence is reportable rather than merely absent.
  gaps              text[] not null default '{}',
  biases            text[] not null default '{}',
  reading_guidance  text not null,

  -- The full report, for reproducing a past conclusion exactly.
  report            jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now()
);

create index if not exists architecture_reviews_time_idx
  on architecture_reviews (generated_at desc);

-- ---------------------------------------------------------------------------
-- work_patterns -- the evidence an agent proposal rests on.
--
-- Stored separately from proposals because a pattern outlives any particular
-- verdict about it: the same recurring work may be judged "not worth it" in
-- March and "agent" in September, and the interesting question is what
-- changed.
-- ---------------------------------------------------------------------------
create table if not exists work_patterns (
  id                  uuid primary key default gen_random_uuid(),
  review_id           uuid references architecture_reviews(id) on delete cascade,

  -- Deterministic slug from the grouping facts, not a model's name for it.
  pattern_key         text not null,
  label               text not null,
  business_area       text,
  capabilities        text[] not null default '{}',

  frequency           int not null,
  median_cycle_days   int not null default 0,
  ceo_touch_count     int not null default 0,
  ceo_touch_rate      numeric(4,3) not null default 0,
  delegable_count     int not null default 0,
  average_participants numeric(6,2) not null default 0,
  total_value_at_stake numeric(14,2),
  completion_rate     numeric(4,3) not null default 0,
  recurring           boolean not null default false,

  -- Span separates "eight times a month, every month" from "eight times in one
  -- bad fortnight". Frequency alone cannot.
  first_at            timestamptz,
  last_at             timestamptz,
  span_days           int not null default 0,

  people_involved     text[] not null default '{}',
  external_parties    text[] not null default '{}',
  task_ids            uuid[] not null default '{}',

  created_at          timestamptz not null default now(),

  unique (review_id, pattern_key)
);

create index if not exists work_patterns_review_idx on work_patterns (review_id);
create index if not exists work_patterns_key_idx on work_patterns (pattern_key, created_at desc);

-- ---------------------------------------------------------------------------
-- agent_proposals -- what the Architect concluded, and why.
--
-- `evidence` and `pattern_keys` are not-null with a non-empty check for the
-- same reason the Zod schema requires them: a proposal that cannot point at
-- what it was derived from is an opinion, and this subsystem exists to avoid
-- shipping opinions as findings.
-- ---------------------------------------------------------------------------
create table if not exists agent_proposals (
  id                    uuid primary key default gen_random_uuid(),
  review_id             uuid references architecture_reviews(id) on delete cascade,

  slug                  text not null,
  name                  text not null,
  verdict               agent_candidate_verdict not null,
  mission               text not null,
  why_it_exists         text not null,

  pattern_keys          text[] not null,
  evidence              text[] not null,
  leverage_score        numeric(8,3) not null default 0,
  leverage_normalized   numeric(4,3) not null default 0,
  -- Never higher than the coverage of the review that produced it.
  confidence            numeric(4,3) not null default 0.5,

  primary_jobs          text[] not null default '{}',
  human_counterpart_person_id uuid references people(id) on delete set null,
  decision_maker_person_id    uuid references people(id) on delete set null,
  external_counterparty_ids   uuid[] not null default '{}',

  required_data         text[] not null default '{}',
  permissions           text[] not null default '{}',
  allowed_actions       text[] not null default '{}',
  disallowed_actions    text[] not null default '{}',
  approval_class        approval_class not null default 'YELLOW',

  max_subjobs           int not null default 3,
  max_depth             int not null default 2,
  max_runtime_seconds   int not null default 300,
  budget_cents          int not null default 500,
  allowed_target_agents text[] not null default '{}',

  metrics               text[] not null default '{}',
  estimated_hours_saved_per_month numeric(8,2),
  estimated_ceo_touches_removed   int,
  estimated_value_at_stake        numeric(14,2),

  -- Named overlaps, so a reviewer sees a merge candidate immediately, and the
  -- fold is visible from both ends.
  overlaps_with         text[] not null default '{}',
  folds_into            text,
  rationale_against     text,

  status                agent_status not null default 'proposed',
  proposed_at           timestamptz not null default now(),
  decided_at            timestamptz,
  decided_by_person_id  uuid references people(id) on delete set null,
  decision_note         text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint agent_proposals_has_evidence check (
    array_length(evidence, 1) >= 1 and array_length(pattern_keys, 1) >= 1
  ),
  -- The safe state is the absence of the permission, not a flag that could be
  -- configured around. The database refuses these even if the code is wrong.
  constraint agent_proposals_no_forbidden_permissions check (
    not (permissions && array[
      'SEND_OUTLOOK_EMAIL', 'POST_SLACK', 'SPEND_MONEY', 'MODIFY_CAMPAIGN',
      'PLACE_ORDER', 'APPROVE_INVOICE', 'MODIFY_PRODUCTION_SYSTEM'
    ]::text[])
  ),
  -- A proposal is a document. It cannot describe itself as running.
  constraint agent_proposals_not_running check (status <> 'active'),

  unique (review_id, slug)
);

create index if not exists agent_proposals_review_idx on agent_proposals (review_id);
create index if not exists agent_proposals_status_idx on agent_proposals (status, leverage_normalized desc);
create index if not exists agent_proposals_slug_idx on agent_proposals (slug, proposed_at desc);

-- ---------------------------------------------------------------------------
-- agents -- an approved proposal that a human turned on.
--
-- Separate from `agent_proposals` on purpose: the row only exists because
-- somebody decided it should, and `approved_by_person_id` is not-null so there
-- is no path to an agent nobody approved.
-- ---------------------------------------------------------------------------
create table if not exists agents (
  id                    uuid primary key default gen_random_uuid(),
  proposal_id           uuid references agent_proposals(id) on delete set null,

  slug                  text not null unique,
  name                  text not null,
  version               int not null default 1,

  mission               text not null,
  objective             text not null,
  -- What "working" means, written before it runs. Without this the first
  -- performance review becomes an argument about what success was.
  success_definition    text not null,

  status                agent_status not null default 'approved',
  human_counterpart_person_id uuid references people(id) on delete set null,
  approved_by_person_id uuid not null references people(id) on delete restrict,
  approved_at           timestamptz not null default now(),

  permissions           text[] not null default '{}',
  approval_class        approval_class not null default 'YELLOW',

  max_subjobs           int not null default 3,
  max_depth             int not null default 2,
  max_runtime_seconds   int not null default 300,
  budget_cents          int not null default 500,
  allowed_target_agents text[] not null default '{}',

  system_prompt         text,
  config                jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  retired_at            timestamptz,

  constraint agents_no_forbidden_permissions check (
    not (permissions && array[
      'SEND_OUTLOOK_EMAIL', 'POST_SLACK', 'SPEND_MONEY', 'MODIFY_CAMPAIGN',
      'PLACE_ORDER', 'APPROVE_INVOICE', 'MODIFY_PRODUCTION_SYSTEM'
    ]::text[])
  ),
  constraint agents_depth_bounded check (max_depth between 0 and 5),
  constraint agents_fanout_bounded check (max_subjobs between 0 and 20)
);

create index if not exists agents_status_idx on agents (status);

-- ---------------------------------------------------------------------------
-- agent_jobs -- one unit of work an agent was asked to do.
--
-- `parent_job_id` and `depth` exist so a recursion limit is enforceable from
-- the data rather than only from whatever process happens to be running: a
-- chain can be reconstructed and audited after the fact.
-- ---------------------------------------------------------------------------
create table if not exists agent_jobs (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references agents(id) on delete cascade,

  parent_job_id     uuid references agent_jobs(id) on delete cascade,
  depth             int not null default 0,
  -- Who asked. A job with no requester is a job nobody can be asked about.
  requested_by      text not null,

  objective         text not null,
  input             jsonb not null default '{}'::jsonb,

  status            agent_job_status not null default 'queued',
  queued_at         timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,

  runtime_seconds   int,
  cost_cents        int,
  error             text,

  created_at        timestamptz not null default now(),

  constraint agent_jobs_depth_bounded check (depth between 0 and 5),
  constraint agent_jobs_not_own_parent check (parent_job_id is null or parent_job_id <> id)
);

create index if not exists agent_jobs_agent_idx on agent_jobs (agent_id, queued_at desc);
create index if not exists agent_jobs_status_idx on agent_jobs (status, queued_at);
create index if not exists agent_jobs_parent_idx on agent_jobs (parent_job_id);

-- ---------------------------------------------------------------------------
-- agent_results -- what a job produced, and what a human did with it.
--
-- `accepted` is nullable on purpose: null means nobody has said, which is
-- different from rejected. Defaulting it to false would quietly score every
-- unreviewed recommendation as a failure.
-- ---------------------------------------------------------------------------
create table if not exists agent_results (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references agent_jobs(id) on delete cascade,
  agent_id          uuid not null references agents(id) on delete cascade,

  summary           text not null,
  output            jsonb not null default '{}'::jsonb,
  confidence        numeric(4,3) not null default 0.5,

  -- Everything the agent leaned on, so a wrong answer is traceable to what it
  -- read rather than to "the model".
  evidence          text[] not null default '{}',
  source_event_ids  uuid[] not null default '{}',
  created_task_ids  uuid[] not null default '{}',

  needs_human       boolean not null default false,
  accepted          boolean,
  accepted_by_person_id uuid references people(id) on delete set null,
  accepted_at       timestamptz,
  correction_note   text,

  created_at        timestamptz not null default now()
);

create index if not exists agent_results_job_idx on agent_results (job_id);
create index if not exists agent_results_agent_idx on agent_results (agent_id, created_at desc);
create index if not exists agent_results_review_idx on agent_results (agent_id, accepted, created_at desc);

-- ---------------------------------------------------------------------------
-- agent_performance -- whether it is actually working.
--
-- Every impact figure carries its basis. An agent that cannot show a measured
-- effect after a fair window should be retired, and that conversation is only
-- possible if estimates were never allowed to masquerade as measurements.
-- ---------------------------------------------------------------------------
create table if not exists agent_performance (
  id                    uuid primary key default gen_random_uuid(),
  agent_id              uuid not null references agents(id) on delete cascade,

  period_start          timestamptz not null,
  period_end            timestamptz not null,

  jobs_run              int not null default 0,
  jobs_failed           int not null default 0,
  recommendations_made  int not null default 0,
  recommendations_accepted int not null default 0,

  ceo_touches_removed   int,
  median_cycle_days     numeric(6,2),
  -- The comparison that makes the number mean anything.
  baseline_cycle_days   numeric(6,2),
  value_influenced      numeric(14,2),

  impact_basis          impact_basis not null default 'unknown',
  impact_note           text,

  created_at            timestamptz not null default now(),

  constraint agent_performance_period check (period_end > period_start),
  unique (agent_id, period_start, period_end)
);

create index if not exists agent_performance_agent_idx
  on agent_performance (agent_id, period_end desc);
