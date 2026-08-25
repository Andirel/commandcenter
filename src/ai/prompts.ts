/**
 * Prompt loading and rendering.
 *
 * Prompts live in prompts/<area>/{system,user}.md with a version comment. The
 * version travels with every call and is persisted to `ai_interpretations`, so
 * "does v3 route better than v2?" stays an answerable question.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config/load.js';

const PROMPTS_DIR = join(REPO_ROOT, 'prompts');

export interface LoadedPrompt {
  area: string;
  system: string;
  user: string;
  version: string;
}

const cache = new Map<string, LoadedPrompt>();

/** `<!-- version: 1.2.3 -->` anywhere in the file. */
function extractVersion(text: string): string {
  const m = /<!--\s*version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*-->/i.exec(text);
  return m?.[1] ?? '0.0.0';
}

/**
 * Load a prompt pair by area, e.g. 'email-classification'.
 *
 * `variant` selects a single-file prompt in the same directory (the triage
 * prompt is one file rather than a system/user pair, because it is one cheap
 * call with no reusable system half).
 */
export function loadPrompt(area: string, variant?: string): LoadedPrompt {
  const key = variant ? `${area}/${variant}` : area;
  const cached = cache.get(key);
  if (cached) return cached;

  if (variant) {
    const path = join(PROMPTS_DIR, area, `${variant}.md`);
    if (!existsSync(path)) throw new Error(`prompt not found: ${path}`);
    const text = readFileSync(path, 'utf8');
    const loaded = { area: key, system: '', user: text, version: extractVersion(text) };
    cache.set(key, loaded);
    return loaded;
  }

  const systemPath = join(PROMPTS_DIR, area, 'system.md');
  const userPath = join(PROMPTS_DIR, area, 'user.md');
  if (!existsSync(systemPath)) throw new Error(`prompt not found: ${systemPath}`);
  if (!existsSync(userPath)) throw new Error(`prompt not found: ${userPath}`);

  const system = readFileSync(systemPath, 'utf8');
  const user = readFileSync(userPath, 'utf8');
  const loaded = {
    area: key,
    system,
    user,
    // The system prompt carries the authoritative version for the pair.
    version: extractVersion(system) !== '0.0.0' ? extractVersion(system) : extractVersion(user),
  };
  cache.set(key, loaded);
  return loaded;
}

/**
 * Substitute `{{placeholders}}`.
 *
 * An unresolved placeholder is replaced with an explicit marker rather than
 * left raw or silently blanked: a prompt that reaches the model still carrying
 * `{{thread_history}}` produces confidently wrong output, and a silent blank
 * hides the fact that context assembly failed.
 */
export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) return `(none)`;
    if (typeof value === 'string') return value.trim() || '(none)';
    return JSON.stringify(value, null, 2);
  });
}

/** Placeholders a template expects — used to validate context assembly. */
export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string))];
}

export function clearPromptCache(): void { cache.clear(); }
