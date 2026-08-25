/**
 * The AI boundary.
 *
 * Three implementations, because 120/Life can run this three ways:
 *
 *  - `AnthropicClient`  — a direct API call. Needs ANTHROPIC_API_KEY.
 *  - `SessionClient`    — a Claude session (this CLI, or a scheduled Routine)
 *                         performs the interpretation and hands results back.
 *                         Needs NO credentials, which is why it is the default
 *                         today.
 *  - `MockClient`       — deterministic, for tests.
 *
 * Every implementation returns raw JSON. Validation happens in stages.ts, in
 * one place, so no client can write unvalidated output into state.
 */
import type { AiRoutingConfig } from '../schemas/config.js';

export interface AiCallRequest {
  /** Task key from config/ai-routing.yaml → tasks. */
  task: string;
  /**
   * Stable per-item identity (usually the event id), passed through from the
   * caller. The session path needs it to match one supplied answer to one
   * event; hashing the rendered prompt would break the moment a prompt is
   * edited, silently orphaning every prepared answer.
   */
  keyHint?: string;
  system: string;
  user: string;
  maxTokens: number;
  model: string;
  promptVersion: string;
}

export interface AiCallResult {
  raw: string;
  model: string;
  promptVersion: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

export interface AiClient {
  readonly name: string;
  complete(req: AiCallRequest): Promise<AiCallResult>;
}

export class AiUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`No AI client available: ${reason}`);
    this.name = 'AiUnavailableError';
  }
}

/** Resolve the model id and token budget for a task from config. */
export function resolveTask(config: AiRoutingConfig, task: string): { model: string; maxTokens: number; prompt: string; promptVersion: string } {
  const entry = config.tasks[task];
  if (!entry) throw new Error(`ai-routing.yaml has no task "${task}"`);
  const model = config.models[entry.model];
  if (!model) throw new Error(`ai-routing.yaml has no model tier "${entry.model}"`);
  return { model, maxTokens: entry.max_tokens, prompt: entry.prompt, promptVersion: entry.prompt_version };
}

// ---------------------------------------------------------------------------

/** Direct Anthropic Messages API. */
export class AnthropicClient implements AiClient {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly opts: { baseUrl?: string; timeoutMs?: number } = {},
  ) {
    if (!apiKey) throw new AiUnavailableError('ANTHROPIC_API_KEY is not set');
  }

  async complete(req: AiCallRequest): Promise<AiCallResult> {
    const started = Date.now();
    const base = this.opts.baseUrl ?? 'https://api.anthropic.com';

    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        // The system prompt is stable across calls, so it caches; the per-call
        // user message does not.
        system: req.system
          ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
          : undefined,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : undefined,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 400)}`);
    }

    const json = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const raw = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');

    return {
      raw,
      model: req.model,
      promptVersion: req.promptVersion,
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
      latencyMs: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Interpretation performed by a Claude session.
 *
 * The session (this CLI, or a scheduled Routine) reads the assembled prompts,
 * produces the structured output itself, and supplies it here keyed by request
 * id. This is the zero-credential path: no API key, no separate billing, and
 * the session already holds the connectors that produced the events.
 *
 * A missing answer is an error rather than a silent skip — a dropped
 * interpretation would look identical to "this email meant nothing".
 */
export class SessionClient implements AiClient {
  readonly name = 'session';
  private readonly answers = new Map<string, string>();

  constructor(answers: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(answers)) this.provide(key, value);
  }

  provide(key: string, value: unknown): void {
    this.answers.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  /** Deterministic key for one call: the task plus a hash of the rendered user prompt. */
  static keyFor(task: string, user: string): string {
    let h = 5381;
    for (let i = 0; i < user.length; i++) h = ((h << 5) + h + user.charCodeAt(i)) >>> 0;
    return `${task}:${h.toString(36)}`;
  }

  async complete(req: AiCallRequest): Promise<AiCallResult> {
    const key = req.keyHint
      ? `${req.task}:${req.keyHint}`
      : SessionClient.keyFor(req.task, req.user);
    const answer = this.answers.get(key) ?? this.answers.get(req.task);
    if (answer === undefined) {
      throw new AiUnavailableError(
        `no session answer for ${key}. The session must supply interpretations before the sync runs.`,
      );
    }
    return { raw: answer, model: `session:${req.model}`, promptVersion: req.promptVersion };
  }
}

// ---------------------------------------------------------------------------

/** Deterministic client for tests. */
export class MockClient implements AiClient {
  readonly name = 'mock';
  readonly calls: AiCallRequest[] = [];

  constructor(private readonly responder: (req: AiCallRequest) => unknown) {}

  async complete(req: AiCallRequest): Promise<AiCallResult> {
    this.calls.push(req);
    const value = this.responder(req);
    return {
      raw: typeof value === 'string' ? value : JSON.stringify(value),
      model: 'mock',
      promptVersion: req.promptVersion,
    };
  }
}

/** Pick the best client the environment can support. */
export function defaultClient(env: NodeJS.ProcessEnv = process.env): AiClient | null {
  if (env.ANTHROPIC_API_KEY) return new AnthropicClient(env.ANTHROPIC_API_KEY);
  return null;
}
