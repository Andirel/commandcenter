/**
 * Validated AI stages.
 *
 * Every model call goes through here, and every response is validated against a
 * Zod schema before it can touch state. An invalid response is retried once,
 * then surfaced as a failure the caller must park as NEEDS_REVIEW — never
 * silently dropped, never written through unvalidated.
 *
 * This is the single choke point. No caller may hold an `AiClient` directly.
 */
import { z } from 'zod';
import type { SystemConfig } from '../schemas/config.js';
import {
  CommitmentExtraction, EventInterpretation, MeetingAnalysis,
  PeopleDiscoveryResult, PortfolioReview, TriageResult,
} from '../schemas/ai.js';
import type { AiClient } from './client.js';
import { resolveTask } from './client.js';
import { loadPrompt, render } from './prompts.js';

/** A persisted record of one call, mirroring `ai_interpretations`. */
export interface InterpretationRecord {
  interpretationType: string;
  model: string;
  promptVersion: string;
  structuredOutput: unknown;
  confidence: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  validationOk: boolean;
  validationError: string | null;
  createdAt: string;
}

export type StageOutcome<T> =
  | { ok: true; value: T; record: InterpretationRecord }
  | { ok: false; error: string; record: InterpretationRecord | null };

export interface StageContext {
  client: AiClient;
  config: SystemConfig;
  /** Every call is appended here for persistence and audit. */
  log?: InterpretationRecord[];
}

/**
 * Pull the JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences even when told not to. Being tolerant
 * here is not sloppiness — it converts a formatting quirk into a successful
 * parse rather than a lost interpretation. The SCHEMA is where strictness
 * lives.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) throw new Error('empty response');

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text;

  try { return JSON.parse(candidate); } catch { /* fall through to brace scan */ }

  // Balanced-brace scan, string-aware so braces inside strings do not confuse it.
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON found in response: ${text.slice(0, 120)}`);
  const open = candidate[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error(`unbalanced JSON in response: ${text.slice(0, 120)}`);
}

async function runStage<S extends z.ZodTypeAny>(
  ctx: StageContext,
  task: string,
  schema: S,
  promptArea: string,
  vars: Record<string, unknown>,
  opts: { variant?: string } = {},
): Promise<StageOutcome<z.output<S>>> {
  const spec = resolveTask(ctx.config.aiRouting, task);
  const prompt = loadPrompt(promptArea, opts.variant);

  const req = {
    task,
    // `__key` is context plumbing, not prompt content: it identifies the item
    // so a session-supplied answer can be matched to it.
    ...(typeof vars.__key === 'string' ? { keyHint: vars.__key } : {}),
    system: prompt.system ? render(prompt.system, vars) : '',
    user: render(prompt.user, vars),
    maxTokens: spec.maxTokens,
    model: spec.model,
    promptVersion: prompt.version,
  };

  const maxAttempts = ctx.config.aiRouting.defaults.max_retries + 1;
  let lastError = 'unknown';
  let lastRecord: InterpretationRecord | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await ctx.client.complete(req);
    } catch (err) {
      lastError = `call failed: ${(err as Error).message}`;
      continue;
    }

    const record: InterpretationRecord = {
      interpretationType: task,
      model: result.model,
      promptVersion: result.promptVersion,
      structuredOutput: null,
      confidence: null,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      latencyMs: result.latencyMs ?? null,
      validationOk: false,
      validationError: null,
      createdAt: new Date().toISOString(),
    };

    let parsed: unknown;
    try {
      parsed = extractJson(result.raw);
    } catch (err) {
      record.validationError = (err as Error).message;
      ctx.log?.push(record);
      lastError = record.validationError;
      lastRecord = record;
      continue;
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      record.structuredOutput = parsed;
      record.validationError = validated.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      ctx.log?.push(record);
      lastError = record.validationError;
      lastRecord = record;
      continue;
    }

    record.structuredOutput = validated.data;
    record.validationOk = true;
    const conf = (validated.data as { confidence?: unknown }).confidence;
    record.confidence = typeof conf === 'number' ? conf : null;
    ctx.log?.push(record);

    return { ok: true, value: validated.data, record };
  }

  return { ok: false, error: lastError, record: lastRecord };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export function triage(ctx: StageContext, vars: Record<string, unknown>) {
  return runStage(ctx, 'email_triage', TriageResult, 'email-classification', vars, { variant: 'triage' });
}

export function interpretEvent(ctx: StageContext, vars: Record<string, unknown>) {
  return runStage(ctx, 'email_classification', EventInterpretation, 'email-classification', vars);
}

export function extractCommitments(ctx: StageContext, vars: Record<string, unknown>) {
  return runStage(ctx, 'commitment_extraction', CommitmentExtraction, 'commitment-extraction', vars);
}

export function analyzeMeeting(ctx: StageContext, vars: Record<string, unknown>) {
  return runStage(ctx, 'meeting_analysis', MeetingAnalysis, 'meeting-analysis', vars);
}

export function discoverPeople(ctx: StageContext, vars: Record<string, unknown>) {
  return runStage(ctx, 'people_discovery', PeopleDiscoveryResult, 'people-discovery', vars);
}

export function reviewPortfolio(ctx: StageContext, vars: Record<string, unknown>) {
  return runStage(ctx, 'priority_review', PortfolioReview, 'priority-review', vars);
}

/** Compact team summary for prompt context; sent as data, not prose. */
export function teamContext(config: SystemConfig): string {
  const lines: string[] = [];
  for (const [slug, person] of Object.entries(config.people.people)) {
    const caps = Object.entries(person.capabilities)
      .filter(([, e]) => e.level === 'primary')
      .map(([name]) => name);
    lines.push(`${slug} — ${person.name}, ${person.role ?? 'unknown role'}${caps.length ? ` [${caps.join(', ')}]` : ''}`);
  }
  for (const [slug, org] of Object.entries(config.organizations.organizations)) {
    if (org.type === 'internal') continue;
    lines.push(`${slug} — ${org.name} (${org.type}, external)`);
  }
  return lines.join('\n');
}

export function capabilityContext(config: SystemConfig): string {
  return Object.keys(config.capabilities.capabilities).join(', ');
}
