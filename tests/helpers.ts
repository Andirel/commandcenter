/**
 * Shared test fixtures.
 *
 * The team model is built from the real config/*.yaml, so these tests exercise
 * the configuration the system actually ships with. A config change that breaks
 * routing breaks the suite -- which is the point.
 */
import { loadConfig } from '../src/config/load.js';
import { teamModelFromConfig, TeamModel } from '../src/capabilities/graph.js';
import type { SystemConfig } from '../src/schemas/config.js';
import { RoutingRequest } from '../src/schemas/routing.js';
import type { RoutingContext } from '../src/routing/owner-selection.js';

export const config: SystemConfig = loadConfig();
export const team: TeamModel = teamModelFromConfig(config);

export function ctx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return { team, config, ...overrides };
}

/** Build a routing request, filling defaults so tests only state what matters. */
export function request(partial: Partial<RoutingRequest> & { title: string }) {
  return RoutingRequest.parse(partial);
}

/** Map person ids back to slugs for legible assertions. */
export function slug(id: string | null): string | null {
  if (!id) return null;
  return team.getPerson(id)?.slug ?? id;
}

export function workload(entries: Record<string, { open: number; overdue?: number }>) {
  const map = new Map<string, { openTasks: number; overdueTasks: number }>();
  for (const [personSlug, v] of Object.entries(entries)) {
    const person = team.getPersonBySlug(personSlug);
    if (person) map.set(person.id, { openTasks: v.open, overdueTasks: v.overdue ?? 0 });
  }
  return map;
}
