/**
 * Browser entry point for the decision engine.
 *
 * Exposes the same routing, priority, matching and normalization code the test
 * suite exercises, plus the frozen configuration, as a single global (`OS120`).
 * The Command Center page calls into this — it does not reimplement any of it.
 */
import { CONFIG } from './config.generated.js';
import { teamModelFromConfig, TeamModel } from '../capabilities/graph.js';
import { routeOwnership } from '../routing/owner-selection.js';
import { classifyApproval, canActAutonomously } from '../routing/approval.js';
import { matchHints, shouldAggregateAsSignal } from '../routing/hints.js';
import { scoreTask } from '../priority/score.js';
import { rankTasks, diffRankings, briefWorthy } from '../priority/rank.js';
import { matchTask } from '../deduplication/match.js';
import { detectCompletion } from '../completion/detect.js';
import { resolveParticipant, isAutomatedSender, emailDomain } from '../people/resolve.js';
import { discoverFromEvent } from '../people/discovery.js';
import { normalizeOutlookMessage, isBulkMail } from '../normalization/outlook.js';
import { normalizeZoomAssets, parseZoomSummaryMarkdown } from '../normalization/zoom.js';
import { normalizeSlackMessage, isSlackNoise } from '../normalization/slack.js';
import { composeDailyBrief } from '../brief/daily.js';
import { renderDailyBrief } from '../brief/render.js';
import { findDueFollowUps } from '../followup/engine.js';
import { RoutingRequest } from '../schemas/routing.js';
import { Task } from '../schemas/tasks.js';

/** Built once; the team model is read-only at runtime. */
const team: TeamModel = teamModelFromConfig(CONFIG);

export {
  CONFIG, team, TeamModel,
  routeOwnership, classifyApproval, canActAutonomously, matchHints, shouldAggregateAsSignal,
  scoreTask, rankTasks, diffRankings, briefWorthy,
  matchTask, detectCompletion,
  resolveParticipant, isAutomatedSender, emailDomain, discoverFromEvent,
  normalizeOutlookMessage, isBulkMail,
  normalizeZoomAssets, parseZoomSummaryMarkdown,
  normalizeSlackMessage, isSlackNoise,
  composeDailyBrief, renderDailyBrief, findDueFollowUps,
  RoutingRequest, Task,
};

/** Convenience for the UI: route a described piece of work in one call. */
export function route(partial: Record<string, unknown>) {
  const request = RoutingRequest.parse(partial);
  return routeOwnership(request, { team, config: CONFIG });
}

/** Person and organization lookup helpers the UI needs constantly. */
export const lookup = {
  person: (id: string | null) => (id ? team.getPerson(id) ?? null : null),
  personName: (id: string | null) => (id ? team.getPerson(id)?.name ?? null : null),
  org: (id: string | null) => (id ? team.getOrganization(id) ?? null : null),
  orgName: (id: string | null) => (id ? team.getOrganization(id)?.name ?? null : null),
  allPeople: () => team.allPeople(),
  allOrganizations: () => team.allOrganizations(),
};
