-- 0001_extensions_and_enums.sql
-- Foundational extensions and enumerated types for the 120/Life AI OS.
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "pg_trgm";       -- trigram similarity for matching/dedup
create extension if not exists "unaccent";      -- name normalization

-- ---------------------------------------------------------------------------
-- Enum helper: create type only if absent.
-- ---------------------------------------------------------------------------
do $$
begin
  -- Organization classification -------------------------------------------
  if not exists (select 1 from pg_type where typname = 'organization_type') then
    create type organization_type as enum (
      'internal', 'agency', 'vendor', 'retailer', 'manufacturer',
      'media_partner', 'research_partner', 'professional_services',
      'financial', 'logistics', 'customer', 'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'relationship_status') then
    create type relationship_status as enum ('active', 'prospective', 'dormant', 'ended');
  end if;

  -- People -----------------------------------------------------------------
  -- Discovery lifecycle. A person only becomes eligible to OWN work at
  -- 'confirmed'; 'provisional' may collaborate or be a counterparty.
  if not exists (select 1 from pg_type where typname = 'discovery_status') then
    create type discovery_status as enum ('discovered', 'provisional', 'confirmed', 'inactive');
  end if;

  if not exists (select 1 from pg_type where typname = 'internal_external') then
    create type internal_external as enum ('internal', 'external', 'unknown');
  end if;

  if not exists (select 1 from pg_type where typname = 'relationship_type') then
    create type relationship_type as enum (
      'employee', 'contractor', 'agency_contact', 'vendor_contact',
      'retailer_contact', 'manufacturer_contact', 'media_contact',
      'professional_services_contact', 'customer', 'other', 'unknown'
    );
  end if;

  -- Capability edges -------------------------------------------------------
  if not exists (select 1 from pg_type where typname = 'primary_secondary') then
    create type primary_secondary as enum ('primary', 'secondary', 'occasional');
  end if;

  -- Work -------------------------------------------------------------------
  if not exists (select 1 from pg_type where typname = 'initiative_status') then
    create type initiative_status as enum (
      'proposed', 'active', 'paused', 'blocked', 'completed', 'abandoned'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type task_status as enum (
      'proposed',            -- system-created, not yet accepted by a human
      'open',
      'in_progress',
      'waiting_internal',    -- blocked on someone at 120/Life
      'waiting_external',    -- blocked on an outside party
      'blocked',
      'needs_review',        -- system is unsure; a human must look
      'completed',
      'cancelled',
      'superseded'           -- merged into another task
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'task_collaborator_role') then
    create type task_collaborator_role as enum (
      'contributor', 'reviewer', 'approver', 'watcher',
      'external_counterparty', 'informed'
    );
  end if;

  -- The CEO's mode of engagement. Central to the product: what Adi must DO
  -- is a different thing from what Adi must merely APPROVE.
  if not exists (select 1 from pg_type where typname = 'action_mode') then
    create type action_mode as enum (
      'DO', 'DECIDE', 'APPROVE', 'DELEGATE', 'FOLLOW_UP', 'REVIEW', 'AWARE'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'commitment_status') then
    create type commitment_status as enum (
      'open', 'fulfilled', 'overdue', 'waived', 'cancelled', 'needs_review'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'commitment_direction') then
    create type commitment_direction as enum ('we_owe', 'they_owe', 'internal');
  end if;

  -- Events / processing ----------------------------------------------------
  if not exists (select 1 from pg_type where typname = 'source_system') then
    create type source_system as enum (
      'outlook', 'outlook_sent', 'zoom', 'slack', 'google_drive', 'calendar',
      'finaloop', 'klaviyo', 'gusto', 'quartile', 'customer_service',
      'manual', 'system'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'processing_status') then
    create type processing_status as enum (
      'pending', 'processing', 'processed', 'ignored', 'failed', 'needs_review'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'match_decision') then
    create type match_decision as enum (
      'CREATE', 'UPDATE_EXISTING', 'MERGE', 'IGNORE', 'NEEDS_REVIEW'
    );
  end if;

  -- Approval gating --------------------------------------------------------
  if not exists (select 1 from pg_type where typname = 'approval_class') then
    create type approval_class as enum ('GREEN', 'YELLOW', 'RED');
  end if;

  -- Paul leverage classification ------------------------------------------
  if not exists (select 1 from pg_type where typname = 'leverage_class') then
    create type leverage_class as enum (
      'PAUL_CAN_OWN',
      'PAUL_CAN_PROJECT_MANAGE',
      'PAUL_CAN_PREPARE_FOR_ADI',
      'PAUL_CAN_FOLLOW_UP',
      'PAUL_CAN_RESEARCH',
      'SPECIALIST_REQUIRED',
      'ADI_REQUIRED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'workflow_run_status') then
    create type workflow_run_status as enum ('running', 'succeeded', 'failed', 'partial');
  end if;

  if not exists (select 1 from pg_type where typname = 'correction_type') then
    create type correction_type as enum (
      'wrong_owner', 'reassign_paul', 'reassign_mike', 'self_assign',
      'not_important', 'duplicate', 'wrong_deadline', 'defer',
      'stop_tracking', 'wrong_interpretation', 'wrong_priority', 'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'signal_severity_source') then
    create type signal_severity_source as enum ('deterministic', 'ai', 'human');
  end if;

  if not exists (select 1 from pg_type where typname = 'attendance_type') then
    create type attendance_type as enum ('host', 'attendee', 'invited_absent', 'unknown');
  end if;
end
$$;
