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
import { extractCommitments, parseDue as parseCommitmentDue } from '../commitments/extract.js';
import { resolveParticipant, isAutomatedSender, emailDomain } from '../people/resolve.js';
import { discoverFromEvent } from '../people/discovery.js';
import { normalizeOutlookMessage, isBulkMail } from '../normalization/outlook.js';
import { normalizeZoomAssets, parseZoomSummaryMarkdown } from '../normalization/zoom.js';
import { normalizeSlackMessage, isSlackNoise } from '../normalization/slack.js';
import { composeDailyBrief } from '../brief/daily.js';
import { buildDayPlan, estimateMinutes, blocksSomeone } from '../brief/plan.js';
import { renderDailyBrief } from '../brief/render.js';
import { findDueFollowUps } from '../followup/engine.js';
import { readPnl, financeSignals, latestClosedIndex, findNode, money, pct } from '../signals/finance.js';
import { parseSalesRows, salesTrend, commerceSignals } from '../signals/commerce.js';
import { parseTrafficRows, trafficTrend, trafficSignals } from '../signals/traffic.js';
import { parseFlowReport, summarizeEmail, emailSignals } from '../signals/email.js';
import { parseVariants, summarizeInventory, inventorySignals } from '../signals/inventory.js';
import { RoutingRequest } from '../schemas/routing.js';
import { Task } from '../schemas/tasks.js';

/** Built once; the team model is read-only at runtime. */
const team: TeamModel = teamModelFromConfig(CONFIG);

export {
  CONFIG, team, TeamModel,
  routeOwnership, classifyApproval, canActAutonomously, matchHints, shouldAggregateAsSignal,
  scoreTask, rankTasks, diffRankings, briefWorthy,
  matchTask, detectCompletion, extractCommitments, parseCommitmentDue,
  resolveParticipant, isAutomatedSender, emailDomain, discoverFromEvent,
  normalizeOutlookMessage, isBulkMail,
  normalizeZoomAssets, parseZoomSummaryMarkdown,
  normalizeSlackMessage, isSlackNoise,
  composeDailyBrief, renderDailyBrief, findDueFollowUps,
  readPnl, financeSignals, latestClosedIndex, findNode, money, pct,
  buildDayPlan, estimateMinutes, blocksSomeone,
  parseSalesRows, salesTrend, commerceSignals,
  parseTrafficRows, trafficTrend, trafficSignals,
  parseFlowReport, summarizeEmail, emailSignals,
  parseVariants, summarizeInventory, inventorySignals,
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
