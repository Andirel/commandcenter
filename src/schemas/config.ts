/**
 * Schemas for config/*.yaml.
 *
 * Config is validated at startup. Invalid config must fail loudly at boot
 * rather than misbehave quietly at runtime.
 */
import { z } from 'zod';
import { ActionMode, ApprovalClass, Confidence, Importance, LeverageClass, OrganizationType, PrimarySecondary } from './core.js';

const CapabilityRef = z.object({
  confidence: Confidence.default(0.5),
  proficiency: Confidence.default(0.5),
  level: PrimarySecondary.default('secondary'),
  confirmed: z.boolean().default(false),
});

export const CapabilitiesConfig = z.object({
  capabilities: z.record(z.object({
    description: z.string().optional(),
    business_area: z.string().optional(),
    /** Gates the leverage engine: specialist work may be tracked but not owned by a coordinator. */
    specialist_only: z.boolean().default(false),
  })),
});
export type CapabilitiesConfig = z.infer<typeof CapabilitiesConfig>;

export const PeopleConfig = z.object({
  people: z.record(z.object({
    name: z.string(),
    role: z.string().optional(),
    internal: z.boolean().default(true),
    relationship_type: z.string().optional(),
    discovery_status: z.enum(['discovered', 'provisional', 'confirmed', 'inactive']).default('confirmed'),
    importance: Importance.default(3),
    decision_authority: z.enum(['high', 'medium', 'low']).optional(),
    broad_generalist: z.boolean().default(false),
    eligible_for_all_areas: z.boolean().default(false),
    leverage_candidate: z.boolean().default(false),
    /** Display names this person appears under in Zoom / Slack / mail. */
    aliases: z.array(z.string()).default([]),
    capabilities: z.record(CapabilityRef).default({}),
    collaborates_with: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([]),
    email: z.string().optional(),
    slack_user_id: z.string().optional(),
  })),
});
export type PeopleConfig = z.infer<typeof PeopleConfig>;

export const OrganizationsConfig = z.object({
  organizations: z.record(z.object({
    name: z.string(),
    type: OrganizationType.default('other'),
    importance: Importance.default(3),
    domains: z.array(z.string()).default([]),
    relationship_owner: z.string().optional(),
    execution_tracker: z.string().optional(),
    capabilities: z.union([z.record(CapabilityRef), z.array(z.string())]).default({}),
    notes: z.array(z.string()).default([]),
  })),
  organization_types: z.array(z.string()).default([]),
  /** Never infer a shared organization from a consumer mail domain. */
  generic_email_domains: z.array(z.string()).default([]),
  /** Senders matching these create no person, organization, or task. */
  noreply_patterns: z.array(z.string()).default([]),
});
export type OrganizationsConfig = z.infer<typeof OrganizationsConfig>;

export const BusinessAreasConfig = z.object({
  business_areas: z.record(z.object({
    description: z.string().optional(),
    default_capabilities: z.array(z.string()).default([]),
    typical_decision_maker: z.string().optional(),
    escalate_to_ceo_when: z.array(z.string()).default([]),
    aggregate_signals: z.boolean().default(false),
    approval_class: ApprovalClass.optional(),
    routing_note: z.string().optional(),
  })),
});
export type BusinessAreasConfig = z.infer<typeof BusinessAreasConfig>;

export const PriorityRulesConfig = z.object({
  weights: z.object({
    impact: z.number(),
    urgency: z.number(),
    risk: z.number(),
    relationship: z.number(),
    strategic_importance: z.number(),
    blocker: z.number(),
    decision_dependency: z.number(),
    effort_penalty: z.number(),
  }),
  bonuses: z.object({
    blocks_other_tasks_each: z.number(),
    blocks_other_tasks_cap: z.number(),
    decision_ready_bonus: z.number(),
    approve_only_bonus: z.number(),
    we_owe_external_bonus: z.number(),
    deadline_bonus: z.object({
      overdue: z.number(),
      within_24h: z.number(),
      within_3d: z.number(),
      within_7d: z.number(),
      within_14d: z.number(),
      beyond: z.number(),
    }),
  }),
  penalties: z.object({
    stale_days_threshold: z.number(),
    stale_penalty: z.number(),
    unconfirmed_proposal_penalty: z.number(),
    low_confidence_threshold: z.number(),
    low_confidence_penalty: z.number(),
    waiting_external_penalty: z.number(),
    waiting_internal_penalty: z.number(),
  }),
  signal_multipliers: z.record(z.number()).default({}),
  compound_rules: z.array(z.object({
    name: z.string(),
    when: z.record(z.unknown()),
    multiplier: z.number().optional(),
    bonus: z.number().optional(),
    reason: z.string(),
  })).default([]),
  ranking: z.object({
    brief_inclusion_floor: z.number(),
    material_rank_change: z.number(),
    material_score_change: z.number(),
    daily_brief: z.object({
      ceo_top_n: z.number(),
      paul_can_take_n: z.number(),
      decisions_n: z.number(),
      waiting_on_n: z.number(),
      risks_n: z.number(),
      opportunities_n: z.number(),
    }),
  }),
  portfolio_review: z.object({
    max_ai_adjustment_ratio: z.number(),
    run_schedule: z.string(),
    min_tasks_to_review: z.number(),
  }),
});
export type PriorityRulesConfig = z.infer<typeof PriorityRulesConfig>;

export const RoutingRulesConfig = z.object({
  engine_version: z.string(),
  scoring: z.object({
    capability_match: z.number(),
    primary_capability_bonus: z.number(),
    continuity_bonus: z.number(),
    relationship_owner_bonus: z.number(),
    recent_involvement_bonus: z.number(),
    specialist_required_bonus: z.number(),
    workload_penalty_per_open_task: z.number(),
    workload_penalty_cap: z.number(),
    overdue_penalty_per_task: z.number(),
    overdue_penalty_cap: z.number(),
    handoff_friction_penalty: z.number(),
    min_gain_to_reassign: z.number(),
    provisional_person_penalty: z.number(),
    external_person_penalty: z.number(),
  }),
  ceo: z.object({
    person: z.string(),
    eligible_for_all_areas: z.boolean().default(true),
    requires_ceo_when: z.array(z.record(z.unknown())).default([]),
    reconsider_ceo_attribution_when: z.array(z.record(z.unknown())).default([]),
    brief_dependency_floor: z.number().default(2),
  }),
  leverage: z.object({
    person: z.string(),
    can_own_capabilities: z.array(z.string()).default([]),
    can_project_manage_when_specialist_owns: z.boolean().default(true),
    never_owner_of_capabilities: z.array(z.string()).default([]),
    do_not_duplicate: z.array(z.object({ capability: z.string(), reason: z.string() })).default([]),
    max_open_tasks_soft: z.number(),
    max_open_tasks_hard: z.number(),
    min_leverage_value: z.number(),
  }),
  hints: z.array(z.object({
    name: z.string(),
    match: z.object({
      any_keyword: z.array(z.string()).default([]),
      not_keyword: z.array(z.string()).default([]),
    }),
    required_capabilities: z.array(z.string()).default([]),
    external_organization_capability: z.string().optional(),
    decision_required: z.boolean().default(false),
    aggregate_as_signal: z.boolean().default(false),
    leverage_hint: LeverageClass.optional(),
    reason: z.string(),
  })).default([]),
  evidence_thresholds: z.object({
    create_provisional_person: z.number(),
    promote_to_provisional: z.number(),
    promote_to_confirmed: z.number(),
    confirmed_requires_days: z.number(),
    capability_edge_create: z.number(),
    capability_edge_strengthen: z.number(),
    reassign_low_impact_confidence: z.number(),
    reassign_high_impact_confidence: z.number(),
    high_impact_when_priority_above: z.number(),
    min_routing_confidence: z.number(),
  }),
  decay: z.object({
    half_life_days: z.number(),
    floor: z.number(),
    exempt_manually_confirmed: z.boolean(),
  }),
});
export type RoutingRulesConfig = z.infer<typeof RoutingRulesConfig>;

export const ApprovalRulesConfig = z.object({
  global: z.object({
    external_sending_enabled: z.boolean(),
    draft_creation_enabled: z.boolean(),
    internal_slack_posting_enabled: z.boolean(),
  }),
  classes: z.record(z.object({
    description: z.string(),
    requires_human_approval: z.boolean(),
    never_automate: z.boolean().default(false),
    phase_available_from: z.number().nullable().default(null),
    examples: z.array(z.string()).default([]),
    applies_to: z.array(z.string()).default([]),
    conditions: z.array(z.record(z.unknown())).default([]),
  })),
  triggers: z.object({
    red_keywords: z.array(z.string()).default([]),
    red_when_amount_above: z.number(),
    yellow_keywords: z.array(z.string()).default([]),
    yellow_when_amount_above: z.number(),
    yellow_when_new_contact: z.boolean().default(true),
  }),
  approvers: z.object({
    default: z.string(),
    by_business_area: z.record(z.string()).default({}),
    ceo_approval_required_above: z.number(),
  }),
  audit: z.object({
    log_all_actions: z.boolean(),
    require_reversibility: z.boolean(),
    retain_drafts_days: z.number(),
  }),
});
export type ApprovalRulesConfig = z.infer<typeof ApprovalRulesConfig>;

const CadenceEntry = z.object({
  first_followup_business_days: z.number().optional(),
  second_followup_business_days: z.number().optional(),
  escalate_business_days: z.number().optional(),
  max_followups: z.number().optional(),
});

export const FollowupRulesConfig = z.object({
  defaults: z.object({
    business_days_only: z.boolean(),
    timezone: z.string(),
  }),
  cadence: z.object({ external: CadenceEntry, internal: CadenceEntry }),
  by_importance: z.record(CadenceEntry).default({}),
  follow_up_ownership: z.object({
    resolution_order: z.array(z.string()),
    /** The system never sends as another person; it prepares a draft for them. */
    never_send_on_behalf_of_others: z.boolean(),
    notification_pattern: z.string(),
  }),
  escalation: z.object({
    to_ceo_when: z.array(z.record(z.unknown())).default([]),
    suppress_repeat_days: z.number(),
  }),
  resolution: z.object({
    auto_resolve_on_reply: z.boolean(),
    auto_resolve_confidence: z.number(),
    require_human_confirmation_when: z.array(z.record(z.unknown())).default([]),
    stale_close_business_days: z.number(),
    stale_close_action: z.string(),
  }),
});
export type FollowupRulesConfig = z.infer<typeof FollowupRulesConfig>;

export const AiRoutingConfig = z.object({
  defaults: z.object({
    provider: z.string(),
    max_retries: z.number(),
    timeout_ms: z.number(),
    persist_all_interpretations: z.boolean(),
  }),
  models: z.record(z.string()),
  tasks: z.record(z.object({
    model: z.string(),
    prompt: z.string(),
    prompt_version: z.string(),
    max_tokens: z.number(),
    description: z.string().optional(),
  })),
  cost_controls: z.object({
    short_circuit_before_ai: z.array(z.record(z.unknown())).default([]),
    cache_stable_context: z.boolean(),
    batch_where_possible: z.boolean(),
    daily_call_budget_warn: z.number(),
    daily_call_budget_halt: z.number(),
  }),
  confidence_gates: z.object({
    create_task: z.number(),
    auto_route: z.number(),
    auto_complete: z.number(),
    auto_merge: z.number(),
    send_anything: z.number(),
  }),
});
export type AiRoutingConfig = z.infer<typeof AiRoutingConfig>;

const BooksUsability = z.object({
  revenue_usable: z.boolean(),
  expenses_usable: z.boolean(),
  profit_usable: z.boolean(),
  flag_uncategorized: z.boolean(),
});

export const FinanceRulesConfig = z.object({
  books: z.object({
    /** Books for month M close by this day of month M+1. */
    close_day_of_month: z.number().int().min(1).max(28),
    open_month: BooksUsability,
    closed_month: BooksUsability,
  }),
  live_commerce: z.object({ independent_of_books_close: z.boolean() }),
  thresholds: z.object({
    min_comparison_base: z.number(),
    uncategorized_floor: z.number(),
  }),
});
export type FinanceRulesConfig = z.infer<typeof FinanceRulesConfig>;

/** The fully-loaded, validated configuration set. */
export const SystemConfig = z.object({
  capabilities: CapabilitiesConfig,
  people: PeopleConfig,
  organizations: OrganizationsConfig,
  businessAreas: BusinessAreasConfig,
  priorityRules: PriorityRulesConfig,
  routingRules: RoutingRulesConfig,
  approvalRules: ApprovalRulesConfig,
  followupRules: FollowupRulesConfig,
  aiRouting: AiRoutingConfig,
  financeRules: FinanceRulesConfig,
});
export type SystemConfig = z.infer<typeof SystemConfig>;

export const ACTION_MODES = ActionMode.options;
