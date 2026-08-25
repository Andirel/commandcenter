-- 0006_triggers_and_views.sql
-- updated_at maintenance and read models used by briefs and the routing engine.

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array[
    'organizations','people','person_capabilities','organization_capabilities',
    'initiatives','tasks','commitments','meetings'
  ] loop
    execute format('drop trigger if exists %I_set_updated_at on %I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on %I
       for each row execute function set_updated_at()', t, t);
  end loop;
end
$$;

-- Any change to a task counts as activity, which feeds staleness detection.
create or replace function touch_task_activity() returns trigger as $$
begin
  if new.status is distinct from old.status
     or new.primary_owner_person_id is distinct from old.primary_owner_person_id
     or new.adjusted_priority_score is distinct from old.adjusted_priority_score then
    new.last_activity_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_touch_activity on tasks;
create trigger tasks_touch_activity before update on tasks
  for each row execute function touch_task_activity();

-- ---------------------------------------------------------------------------
-- v_open_tasks -- the working set. Excludes terminal states everywhere so
-- callers cannot forget to.
-- ---------------------------------------------------------------------------
create or replace view v_open_tasks as
select
  t.*,
  po.name  as primary_owner_name,
  po.slug  as primary_owner_slug,
  pm.name  as project_manager_name,
  dm.name  as decision_maker_name,
  i.name   as initiative_name,
  o.name   as counterparty_name,
  case
    when t.deadline is null then null
    else extract(day from (t.deadline - now()))::int
  end      as days_to_deadline,
  extract(day from (now() - t.last_activity_at))::int as days_since_activity
from tasks t
left join people        po on po.id = t.primary_owner_person_id
left join people        pm on pm.id = t.project_manager_person_id
left join people        dm on dm.id = t.decision_maker_person_id
left join initiatives   i  on i.id  = t.initiative_id
left join organizations o  on o.id  = t.external_counterparty_organization_id
where t.status not in ('completed','cancelled','superseded');

-- ---------------------------------------------------------------------------
-- v_person_workload -- routing must be workload-aware, not just capability-aware
-- ---------------------------------------------------------------------------
create or replace view v_person_workload as
select
  p.id            as person_id,
  p.slug,
  p.name,
  p.discovery_status,
  p.routing_eligible,
  count(t.id) filter (where t.status not in ('completed','cancelled','superseded'))         as open_tasks,
  count(t.id) filter (where t.deadline < now() and t.status not in ('completed','cancelled','superseded')) as overdue_tasks,
  count(t.id) filter (where t.status in ('waiting_internal','waiting_external'))            as waiting_tasks,
  coalesce(sum(t.effort_score) filter (where t.status in ('open','in_progress')), 0)        as committed_effort
from people p
left join tasks t
  on t.primary_owner_person_id = p.id
  or t.project_manager_person_id = p.id
group by p.id, p.slug, p.name, p.discovery_status, p.routing_eligible;

-- ---------------------------------------------------------------------------
-- v_waiting_on -- the follow-up register, split internal vs external
-- ---------------------------------------------------------------------------
create or replace view v_waiting_on as
select
  c.id                as commitment_id,
  c.description,
  c.direction,
  c.due_date,
  c.status,
  c.follow_up_count,
  c.last_followed_up_at,
  cbp.name            as committed_by_person,
  cbo.name            as committed_by_organization,
  cbo.organization_type,
  fu.name             as follow_up_owner,
  t.id                as task_id,
  t.title             as task_title,
  case when cbo.id is not null and cbo.organization_type <> 'internal'
       then 'external' else 'internal' end as party,
  case when c.due_date is null then null
       else extract(day from (now() - c.due_date))::int end as days_overdue
from commitments c
left join people        cbp on cbp.id = c.committed_by_person_id
left join organizations cbo on cbo.id = c.committed_by_organization_id
left join people        fu  on fu.id  = c.follow_up_owner_person_id
left join tasks         t   on t.id   = c.task_id
where c.status in ('open','overdue');

-- ---------------------------------------------------------------------------
-- v_ceo_attention -- separates what Adi must DO from what Adi must merely
-- DECIDE or APPROVE. This distinction is the core of the product.
-- ---------------------------------------------------------------------------
create or replace view v_ceo_attention as
select
  t.id,
  t.title,
  t.ceo_action_mode,
  t.ceo_dependency_score,
  t.adjusted_priority_score,
  t.priority_rank,
  t.deadline,
  t.leverage_class,
  po.name as primary_owner_name,
  case
    when t.primary_owner_person_id = t.decision_maker_person_id then 'ceo_owns_work'
    when t.ceo_action_mode in ('DECIDE','APPROVE')              then 'ceo_decides_only'
    else 'ceo_awareness'
  end as attention_type
from tasks t
left join people po on po.id = t.primary_owner_person_id
where t.ceo_required
  and t.status not in ('completed','cancelled','superseded');

-- ---------------------------------------------------------------------------
-- v_person_capability_ranked -- ranked candidate list per capability,
-- the primary read model for the owner-selection engine.
-- ---------------------------------------------------------------------------
create or replace view v_person_capability_ranked as
select
  c.name                as capability,
  c.specialist_only,
  p.id                  as person_id,
  p.slug,
  p.name                as person_name,
  p.discovery_status,
  p.internal_external,
  pc.confidence,
  pc.proficiency,
  pc.primary_secondary,
  pc.evidence_count,
  pc.last_evidence_at,
  pc.manually_confirmed,
  w.open_tasks,
  w.overdue_tasks
from person_capabilities pc
join capabilities c        on c.id = pc.capability_id
join people p              on p.id = pc.person_id
left join v_person_workload w on w.person_id = p.id
where p.routing_eligible
  and p.discovery_status in ('confirmed','provisional');
