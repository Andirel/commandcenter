/**
 * Slack rendering for the daily brief.
 *
 * Plain, scannable text. A section with nothing material in it is OMITTED
 * rather than printed empty -- "RISKS: none" trains the reader to skip, and a
 * brief that is skipped is a brief that has failed.
 */
import type { DailyBrief } from './daily.js';

const MODE_LABEL: Record<string, string> = {
  DO: 'DO', DECIDE: 'DECIDE', APPROVE: 'APPROVE',
  DELEGATE: 'DELEGATE', FOLLOW_UP: 'FOLLOW UP', REVIEW: 'REVIEW', AWARE: 'FYI',
};

export function renderDailyBrief(brief: DailyBrief, opts: { weekday?: string } = {}): string {
  const out: string[] = [];
  const heading = opts.weekday ? `120/LIFE — ${opts.weekday.toUpperCase()}` : `120/LIFE — ${brief.date}`;
  out.push(heading, '');

  if (brief.topActions.length) {
    out.push('YOUR HIGHEST-VALUE ACTIONS', '');
    brief.topActions.forEach((line, i) => {
      out.push(`${i + 1}. ${MODE_LABEL[line.mode] ?? line.mode} — ${line.title}`);
      out.push(`   Why: ${line.whyItMatters}`);
      if (line.whatChanged) out.push(`   Changed: ${line.whatChanged}`);
      out.push(`   Next: ${line.recommendedNextMove}`);
      if (line.whoElseIsInvolved.length) out.push(`   Involved: ${line.whoElseIsInvolved.join(', ')}`);
      if (line.deadline) out.push(`   Due: ${formatDate(line.deadline)}`);
      out.push('');
    });
  }

  if (brief.decisions.length) {
    out.push('DECISIONS YOU NEED TO MAKE', '');
    brief.decisions.forEach((d, i) => {
      out.push(`${i + 1}. ${d.title}`);
      out.push(`   ${d.recommendedNextMove}`);
      if (d.deadline) out.push(`   Due: ${formatDate(d.deadline)}`);
    });
    out.push('');
  }

  if (brief.delegationOpportunities.length) {
    const to = brief.delegationOpportunities[0]?.delegateTo ?? 'the coordinator';
    out.push(`${to.toUpperCase()} CAN TAKE OFF YOUR PLATE`, '');
    brief.delegationOpportunities.forEach((d, i) => {
      out.push(`${i + 1}. ${d.title}`);
    });
    out.push('');
  }

  if (brief.operationsSummary.length) {
    out.push('OPERATIONS', '');
    for (const note of brief.operationsSummary) out.push(`• ${note}`);
    out.push('');
  }

  const { internal, external } = brief.waitingOn;
  if (internal.length || external.length) {
    out.push('WAITING ON OTHERS', '');
    if (external.length) {
      out.push('External');
      for (const w of external) out.push(`  • ${w.counterparty} — ${w.description} — ${w.businessDaysOverdue}d`);
    }
    if (internal.length) {
      out.push('Internal');
      for (const w of internal) out.push(`  • ${w.counterparty} — ${w.description} — ${w.businessDaysOverdue}d`);
    }
    out.push('');
  }

  if (brief.changedSinceYesterday.length) {
    out.push('CHANGED SINCE YESTERDAY', '');
    for (const change of brief.changedSinceYesterday) out.push(`• ${change}`);
    out.push('');
  }

  if (brief.risks.length) {
    out.push('RISKS', '');
    for (const risk of brief.risks) out.push(`• ${risk}`);
    out.push('');
  }

  if (brief.opportunities.length) {
    out.push('OPPORTUNITIES', '');
    for (const opp of brief.opportunities) out.push(`• ${opp}`);
    out.push('');
  }

  if (brief.meetingsToday.length) {
    out.push('MEETINGS TODAY', '');
    for (const m of brief.meetingsToday) {
      out.push(`• ${formatTime(m.startsAt)} — ${m.topic}${m.prepReady ? ' (prep ready)' : ''}`);
    }
    out.push('');
  }

  // If literally nothing was material, say so in one line rather than
  // printing a skeleton of empty headings.
  if (out.length <= 2) {
    return `${heading}\n\nNothing material today. ${brief.waitingOn.external.length} external items still outstanding.`;
  }

  return out.join('\n').trimEnd();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 16);
}
