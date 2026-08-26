/* =============================================================================
   120/Life Command Center — application layer.

   Responsibilities:
     - pull live data from the viewer's connectors via the `mcp` capability
     - run the bundled decision engine (global `OS120`) over that data
     - render the operating queue
     - persist corrections back into the page via the `artifact` capability

   Design notes that matter:
     - Connector failures are branched per error CODE, not collapsed into one
       banner: each code has a different fix, and hiding that turns a
       recoverable state into a dead end.
     - Every section degrades on its own. One failed connector greys its own
       section; the rest of the page still works.
     - Nothing is ever sent anywhere. Every call made here is a read.
   ============================================================================= */
(function () {
  'use strict';

  var E = window.OS120;

  // Connector display names. The runtime accepts the tool-prefix segment with
  // underscores read as spaces; listTools() at runtime tells us what actually
  // resolved for this viewer.
  var ZOOM = 'Zoom for Claude';
  var MS365 = 'ms365';
  var SLACK = 'Slack';
  var FINALOOP = 'My Finaloop MCP';
  var SHOPIFY = 'Shopify';
  var KLAVIYO = 'Klaviyo';

  // ---------------------------------------------------------------------------
  // State. Embedded into the published HTML so corrections survive a reload.
  // ---------------------------------------------------------------------------
  var STATE = (function () {
    var el = document.getElementById('cc-state');
    if (!el) return { corrections: {}, dismissed: [], lastSync: null };
    try { return JSON.parse(el.textContent) || {}; }
    catch (e) { return { corrections: {}, dismissed: [], lastSync: null }; }
  })();
  STATE.corrections = STATE.corrections || {};
  STATE.dismissed = STATE.dismissed || [];
  /** Proposals the CEO accepted, with the work each one produced. */
  STATE.chosen = STATE.chosen || {};
  STATE.done = STATE.done || [];
  STATE.view = STATE.view || 'today';
  /*
   * Answers to "did this get done?", by task id.
   *
   * These are the most valuable data the system collects: they are the only
   * place a human tells it whether its inference was right. Held here rather
   * than applied blind, and read back by the next sync so the ledger learns
   * from them instead of asking again tomorrow.
   */
  STATE.completed = STATE.completed || {};
  STATE.stillOpen = STATE.stillOpen || {};

  /**
   * The interpreted state document, embedded at build time by a sync run.
   * This is the rich path: bodies were read, capabilities extracted, and
   * priority scored. The live connector pull is a thinner supplement that
   * routes on metadata alone, and the UI labels which is which.
   */
  var DATA = (function () {
    var node = document.getElementById('cc-data');
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  })();

  var VIEW = { tasks: [], feed: [], meetings: [], waiting: [], connectors: {}, live: [], slack: [], slackRaw: null, finance: null, signals: [] };

  /** Normalize a state task and a live-routed task into one render shape. */
  function fromState(t) {
    return {
      id: t.id,
      title: t.title,
      summary: t.summary,
      source: t.source,
      link: t.link,
      at: t.occurredAt,
      score: t.score,
      rank: t.rank,
      drivers: t.drivers || [],
      owner: t.primaryOwner,
      projectManager: t.projectManager,
      decisionMaker: t.decisionMaker,
      externalParty: t.externalParty,
      ceoRequired: t.ceoRequired,
      mode: t.ceoActionMode,
      leverage: t.leverageClass,
      approvalClass: t.approvalClass,
      deadline: t.deadline,
      reason: t.routingReason,
      attributedTo: t.attributedTo,
      attributionOverridden: t.attributionOverridden,
      interpreted: t.interpreted,
      needsReview: t.needsReview,
      possibleDuplicateOf: t.possibleDuplicateOf || null,
      duplicateSimilarity: t.duplicateSimilarity || null
    };
  }

  /** Live-pulled task → StateTask shape, so one vocabulary reaches the engine. */
  function liveToState(t) {
    var r = t.routed;
    return {
      id: t.id, title: t.title, summary: t.preview || null, source: t.source,
      sourceRef: null, link: t.link, occurredAt: t.at,
      businessArea: null, requiredCapabilities: [],
      primaryOwner: E.lookup.personName(r.primaryOwnerPersonId),
      projectManager: E.lookup.personName(r.projectManagerPersonId),
      decisionMaker: E.lookup.personName(r.decisionMakerPersonId),
      externalParty: E.lookup.orgName(r.externalCounterpartyOrganizationId),
      collaborators: [],
      ceoRequired: r.ceoRequired,
      ceoActionMode: r.ceoActionMode,
      leverageClass: r.leverage.classification,
      approvalClass: r.approvalClass,
      delegable: r.delegable,
      deadline: null, valueAtStake: null,
      score: 0, rank: null, drivers: [],
      routingReason: r.reason,
      attributedTo: t.attributedTo || null, attributionOverridden: false,
      confidence: r.confidence, needsReview: r.needsReview,
      possibleDuplicateOf: null, duplicateSimilarity: null,
      interpreted: false
    };
  }

  function fromLive(t) {
    var r = t.routed;
    return {
      id: t.id, title: t.title, summary: t.preview || null, source: t.source,
      link: t.link, at: t.at, score: 0, rank: null, drivers: [],
      owner: E.lookup.personName(r.primaryOwnerPersonId),
      projectManager: E.lookup.personName(r.projectManagerPersonId),
      decisionMaker: E.lookup.personName(r.decisionMakerPersonId),
      externalParty: E.lookup.orgName(r.externalCounterpartyOrganizationId),
      ceoRequired: r.ceoRequired, mode: r.ceoActionMode,
      leverage: r.leverage.classification, approvalClass: r.approvalClass,
      deadline: null, reason: r.reason,
      attributedTo: t.attributedTo || null, attributionOverridden: false,
      interpreted: false, needsReview: r.needsReview,
      possibleDuplicateOf: null, duplicateSimilarity: null
    };
  }

  // ---------------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function bodyOf(id) { return document.querySelector('#' + id + ' .body'); }
  function countOf(id) { return document.querySelector('#' + id + ' .count'); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---------------------------------------------------------------------------
  // Notices — one per condition, each naming the actual fix
  // ---------------------------------------------------------------------------
  function notice(kind, title, detail, actions) {
    var box = document.getElementById('notices');
    var n = el('div', 'notice');
    n.setAttribute('data-kind', kind);
    var b = el('b', null, title);
    n.appendChild(b);
    if (detail) { n.appendChild(document.createTextNode(' — ' + detail)); }
    if (actions && actions.length) {
      var row = el('div', 'act');
      actions.forEach(function (a) {
        var btn = el('button', 'btn tiny', a.label);
        btn.addEventListener('click', a.onClick);
        row.appendChild(btn);
      });
      n.appendChild(row);
    }
    box.appendChild(n);
    return n;
  }
  function clearNotices() { clear(document.getElementById('notices')); }

  /**
   * Per-code copy. Each branch names the one action that would fix the page.
   * A single catch-all banner is the documented anti-pattern here.
   */
  function describeError(err, server) {
    var code = (err && err.code) || 'upstream_error';
    var name = (err && err.server) || server;
    switch (code) {
      case 'needs_reauth':
        return { kind: 'warn', title: name + ' needs reconnecting',
                 detail: 'Reconnect it in claude.ai Settings → Connectors, then sync again.', retry: false };
      case 'server_not_connected':
        return { kind: 'warn', title: name + ' is not connected',
                 detail: 'Add it in claude.ai Settings → Connectors to pull this section.', retry: false };
      case 'selection_required':
        return { kind: 'warn', title: 'Choose which ' + name + ' account to use',
                 detail: 'You have more than one connected. Pick one when prompted, then sync again.', retry: false };
      case 'not_in_manifest':
        return { kind: 'error', title: name + ' is outside this page’s approved scope',
                 detail: 'The page can only call the tools it declared when published.', retry: false };
      case 'blocked_by_policy':
        return { kind: 'error', title: name + ' is blocked by your organization’s policy', detail: '', retry: false };
      case 'approval_required':
        return { kind: 'warn', title: name + ' needs per-call approval',
                 detail: 'Your policy requires approving each call, which pages cannot request yet.', retry: false };
      case 'server_unavailable':
        return { kind: 'warn', title: name + ' is temporarily unreachable',
                 detail: 'Usually brief. Try syncing again in a moment.', retry: true };
      case 'tool_error':
        return { kind: 'error', title: name + ' rejected the request',
                 detail: (err && err.message) || 'The connector answered with an error.', retry: false };
      case 'not_granted':
      case 'capability_disabled':
      case 'capability_removed':
        return { kind: 'info', title: 'Live data is off in this view',
                 detail: 'Open the artifact from claude.ai to let it read your connectors.', retry: false };
      case 'server_not_found':
        return { kind: 'error', title: name + ' no longer exists', detail: '', retry: false };
      case 'rate_limited':
        return { kind: 'warn', title: 'Too many connector calls',
                 detail: 'Wait a moment before syncing again.', retry: true };
      default:
        return { kind: 'error', title: name + ' could not be read',
                 detail: (err && err.message) || 'Unexpected connector failure.', retry: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Connector plumbing
  // ---------------------------------------------------------------------------
  var mcp = null, artifactCap = null;

  function setConn(name, state, label) {
    VIEW.connectors[name] = { state: state, label: label || name };
    renderStrip();
  }

  function renderStrip() {
    var strip = document.getElementById('strip');
    clear(strip);
    var names = Object.keys(VIEW.connectors);
    if (!names.length) {
      var c = el('span', 'conn'); c.setAttribute('data-state', 'off');
      c.appendChild(el('span', 'dot')); c.appendChild(document.createTextNode('Connectors'));
      strip.appendChild(c);
    }
    names.forEach(function (n) {
      var info = VIEW.connectors[n];
      var c = el('span', 'conn');
      c.setAttribute('data-state', info.state);
      c.appendChild(el('span', 'dot'));
      c.appendChild(document.createTextNode(info.label));
      strip.appendChild(c);
    });
    var meta = el('span', 'meta');
    meta.id = 'strip-meta';
    meta.textContent = STATE.lastSync
      ? 'Last synced ' + relTime(STATE.lastSync)
      : 'Not yet synced';
    strip.appendChild(meta);
  }

  function relTime(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms)) return 'recently';
    var m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  /**
   * The ms365 mail search answers with several JSON objects concatenated rather
   * than one array, so `payload` arrives as raw text. Parse the stream.
   */
  function parseObjectStream(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') return [payload];
    if (typeof payload !== 'string') return [];
    var out = [], depth = 0, start = -1, inStr = false, esc = false;
    for (var i = 0; i < payload.length; i++) {
      var ch = payload[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(payload.slice(start, i + 1))); } catch (e) { /* skip */ }
          start = -1;
        }
      }
    }
    return out;
  }

  function call(server, tool, input) {
    return mcp.callTool(server, tool, input, { cache: { staleTime: 60000 } });
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------
  var syncing = false;

  async function sync() {
    if (syncing) return;
    syncing = true;
    var btn = document.getElementById('sync-btn');
    btn.disabled = true; btn.textContent = 'Syncing…';
    clearNotices();

    if (!mcp) {
      var d = describeError({ code: 'not_granted' }, 'Connectors');
      notice(d.kind, d.title, d.detail);
      showStatic();
      syncing = false; btn.disabled = false; btn.textContent = 'Sync';
      return;
    }

    setConn(MS365, 'busy', 'Outlook');
    setConn(ZOOM, 'busy', 'Zoom');

    // Sections are independent: one failure must not blank the page.
    setConn(SLACK, 'busy', 'Slack');
    setConn(FINALOOP, 'busy', 'Finaloop');
    setConn(KLAVIYO, 'busy', 'Klaviyo');
    var results = await Promise.allSettled([
      pullMail(), pullMeetings(), pullSlack(), pullBusiness(), pullEmail()
    ]);

    var codes = results
      .filter(function (r) { return r.status === 'rejected'; })
      .map(function (r) { return (r.reason && r.reason.code) || 'upstream_error'; });

    // When everything fails with the same code it is a page condition, not a
    // per-section one — say it once.
    if (codes.length === results.length && codes.length > 0 &&
        codes.every(function (c) { return c === codes[0]; })) {
      var pd = describeError({ code: codes[0] }, 'Your connectors');
      notice(pd.kind, pd.title, pd.detail, pd.retry ? [{ label: 'Try again', onClick: sync }] : null);
    } else {
      var servers = [[MS365, 'Outlook'], [ZOOM, 'Zoom'], [SLACK, 'Slack'],
                     [FINALOOP, 'Finaloop'], [KLAVIYO, 'Klaviyo']];
      results.forEach(function (r, i) {
        if (r.status !== 'rejected') return;
        var pair = servers[i];
        var dd = describeError(r.reason, pair[1]);
        setConn(pair[0], 'error', pair[1]);
        notice(dd.kind, dd.title, dd.detail, dd.retry ? [{ label: 'Try again', onClick: sync }] : null);
      });
    }

    STATE.lastSync = new Date().toISOString();
    renderAll();
    renderStrip();

    syncing = false;
    btn.disabled = false; btn.textContent = 'Sync';
  }

  /**
   * Mail → triage → routed work.
   *
   * The engine's short-circuit runs first, before anything expensive. On a real
   * inbox this drops the large majority: newsletters, receipts, payout notices,
   * automated senders.
   */
  async function pullMail() {
    var res = await call(MS365, 'outlook_email_search', {
      folderName: 'Inbox', limit: 25, order: 'newest'
    });
    var rows = parseObjectStream(res.payload).filter(function (r) { return r && r.id; });

    var feed = [], tasks = [];

    rows.forEach(function (m) {
      var ev = E.normalizeOutlookMessage({
        id: m.id,
        internetMessageId: m.internetMessageId,
        conversationId: m.conversationId || m.internetMessageId,
        subject: m.subject,
        bodyPreview: m.summary,
        from: { emailAddress: { name: null, address: m.sender } },
        toRecipients: (m.recipients || []).map(function (a) { return { emailAddress: { address: a } }; }),
        receivedDateTime: m.receivedDateTime
      }, { direction: 'received' });

      var dropped = null;
      if (E.isAutomatedSender(ev.actor && ev.actor.email, E.CONFIG.organizations)) dropped = 'automated sender';
      else if (E.isBulkMail(ev)) dropped = 'bulk mail';
      else if (looksTransactional(m)) dropped = 'transactional';

      if (dropped) {
        feed.push({ kept: false, subject: m.subject || '(no subject)', reason: dropped, at: m.receivedDateTime });
        return;
      }

      // Kept: route it. Interpretation flags come from the subject line only —
      // this page has no model call, so it is deliberately conservative.
      var routed = E.route({
        title: m.subject || '(no subject)',
        description: (m.summary || '').slice(0, 400),
        businessArea: null
      });

      feed.push({ kept: true, subject: m.subject || '(no subject)', reason: 'routed', at: m.receivedDateTime });
      tasks.push({
        id: 'mail:' + m.id,
        title: m.subject || '(no subject)',
        source: 'Outlook',
        at: m.receivedDateTime,
        link: m.webLink || null,
        routed: routed,
        preview: (m.summary || '').slice(0, 220)
      });
    });

    VIEW.feed = feed;
    VIEW.tasks = VIEW.tasks.filter(function (t) { return t.source !== 'Outlook'; }).concat(tasks);
    setConn(MS365, 'live', 'Outlook · ' + feed.filter(function (f) { return f.kept; }).length + '/' + feed.length);
  }

  /**
   * Recent Slack activity.
   *
   * The connector answers with FORMATTED TEXT rather than structured messages,
   * so this displays rather than interprets. Parsing is tolerant and falls back
   * to showing the text as returned: a display panel is not worth breaking the
   * page over, and Slack's real interpretive value happens in the sync run.
   */
  async function pullSlack() {
    var since = new Date(Date.now() - 3 * 86400000);
    var res = await call(SLACK, 'slack_search_public_and_private', {
      query: 'after:' + since.toISOString().slice(0, 10),
      sort: 'timestamp',
      limit: 15,
      include_context: false,
      response_format: 'concise'
    });

    var payload = res.payload;
    if (payload && typeof payload === 'object' && payload.results) payload = payload.results;
    if (typeof payload !== 'string') { VIEW.slack = []; setConn(SLACK, 'live', 'Slack'); return; }

    VIEW.slack = parseSlackResults(payload);
    VIEW.slackRaw = VIEW.slack.length ? null : payload;
    setConn(SLACK, 'live', 'Slack · ' + VIEW.slack.length);
  }

  /** "1. #channel - Author: text 2026-08-24 23:23:28 CDT" */
  function parseSlackResults(text) {
    var out = [];
    var lines = text.split(/\n(?=\d+\.\s)/);
    lines.forEach(function (chunk) {
      var m = /^\d+\.\s+([\s\S]+?)\s-\s([^:]{1,60}):\s([\s\S]*?)\s(\d{4}-\d{2}-\d{2}[^\n]*)$/.exec(chunk.trim());
      if (!m) return;
      var body = m[3].replace(/<[^|>]*\|([^>]*)>/g, '$1').replace(/<([^>]*)>/g, '$1').trim();
      if (!body) return;
      out.push({ channel: m[1].trim(), author: m[2].trim(), text: body, at: m[4].trim() });
    });
    return out;
  }

  /**
   * Financial and commerce position.
   *
   * Two different bases, deliberately not mixed: Finaloop reports BOOKED
   * accounting figures, Shopify reports order-level activity. Blending them
   * produces a number that is true on neither basis.
   *
   * Shopify is optional here — its analytics API rate-limits, and a missing
   * sparkline must not cost the financial headline.
   */
  async function pullBusiness() {
    var companies = await call(FINALOOP, 'list_my_companies', {});
    var payload = companies.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }
    var company = payload && payload.rows && payload.rows[0];
    if (!company) { setConn(FINALOOP, 'warn', 'Finaloop · no company'); return; }

    var now = new Date();
    var start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    var end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

    var pnlRes = await call(FINALOOP, 'get_profit_and_loss', {
      companyId: company.id,
      startDate: iso(start), endDate: iso(end),
      accountingMethod: company.accountingMethod || 'accrual',
      timeRangeGroups: 'month',
      totalsOnly: true
    });
    var tree = pnlRes.payload;
    if (typeof tree === 'string') { try { tree = JSON.parse(tree); } catch (e) { tree = null; } }
    if (!Array.isArray(tree)) { setConn(FINALOOP, 'warn', 'Finaloop · unreadable'); return; }

    // Books close on the 10th of the following month; until then a month's
    // expense side is incomplete and no profit may be read from it.
    var CLOSE_DAY = 10;
    var snap = E.readPnl(tree, now, CLOSE_DAY);
    var ci = E.latestClosedIndex(snap.periods);
    var oi = snap.periods.length - 1;
    if (ci < 0 && oi < 0) { setConn(FINALOOP, 'warn', 'Finaloop · empty'); return; }

    var closed = ci >= 0 ? {
      period: snap.periods[ci].label,
      netSales: snap.netSales[ci] || 0,
      netProfit: snap.netProfit[ci] || 0,
      paidAds: snap.paidAds[ci] || 0,
      priorPeriod: ci > 0 ? snap.periods[ci - 1].label : null,
      priorNetProfit: ci > 0 ? snap.netProfit[ci - 1] : null,
      dailyNetSales: snap.dailyNetSales[ci],
      priorDailyNetSales: ci > 0 ? snap.dailyNetSales[ci - 1] : null
    } : null;

    var openP = (oi >= 0 && !snap.periods[oi].closed) ? snap.periods[oi] : null;
    var open = openP ? {
      period: openP.label,
      daysElapsed: openP.days,
      netSales: snap.netSales[oi] || 0,       // revenue only — no profit field
      closesOn: closesOnDate(openP.label, CLOSE_DAY)
    } : null;

    VIEW.finance = { closed: closed, open: open, dailySales: [], salesChangeRatio: null };
    VIEW.signals = E.financeSignals(snap, { closeDay: CLOSE_DAY });
    setConn(FINALOOP, 'live', 'Finaloop');

    // Sparkline is a bonus, never a dependency.
    try {
      var salesRes = await call(SHOPIFY, 'run-analytics-query', {
        query: 'FROM sales SHOW total_sales, orders, average_order_value TIMESERIES day SINCE -21d UNTIL today'
      });
      var sp = salesRes.payload;
      if (typeof sp === 'string') { try { sp = JSON.parse(sp); } catch (e) { sp = null; } }
      if (sp && sp.rows && sp.rows.length) {
        var trend = E.salesTrend(E.parseSalesRows(sp));
        VIEW.finance.dailySales = trend.complete.map(function (d) { return { day: d.day, value: d.totalSales }; });
        VIEW.finance.salesChangeRatio = trend.changeRatio;
        VIEW.signals = VIEW.signals.concat(E.commerceSignals(trend));
        setConn(SHOPIFY, 'live', 'Shopify');
      }
    } catch (e) {
      // Rate limits here are routine; the financial headline still stands.
      setConn(SHOPIFY, 'warn', 'Shopify · unavailable');
    }

    // Funnel — the diagnostic that separates a traffic problem from a site one.
    try {
      var sessRes = await call(SHOPIFY, 'run-analytics-query', {
        query: 'FROM sessions SHOW sessions, sessions_that_completed_checkout, conversion_rate TIMESERIES week SINCE -63d UNTIL today'
      });
      var sp2 = sessRes.payload;
      if (typeof sp2 === 'string') { try { sp2 = JSON.parse(sp2); } catch (e) { sp2 = null; } }
      if (sp2 && sp2.rows && sp2.rows.length) {
        var tt = E.trafficTrend(E.parseTrafficRows(sp2), 4);
        VIEW.finance.traffic = {
          recentSessions: tt.recent.sessions, priorSessions: tt.prior.sessions,
          recentRate: tt.recent.rate, priorRate: tt.prior.rate,
          weeks: tt.recent.weeks, sigma: tt.conversionSigma,
          weekly: tt.complete.map(function (w) {
            return { week: w.week, sessions: w.sessions, rate: w.conversionRate };
          })
        };
        VIEW.signals = VIEW.signals.concat(
          E.trafficSignals(tt, { adSpendChangeRatio: adSpendDelta() }));
      }
    } catch (e) { /* funnel is a diagnostic, not a dependency */ }
  }

  /** Closed-month daily ad spend change, for the traffic comparison. */
  function adSpendDelta() {
    var f = VIEW.finance;
    if (!f || !f.closed) return null;
    var sig = (VIEW.signals || []).filter(function (s) { return s.signalType === 'roas_decline'; })[0];
    return sig && sig.metadata ? (sig.metadata.adDelta || null) : null;
  }

  /**
   * Email performance.
   *
   * Judged on revenue per recipient. Open rate measures whether a subject line
   * worked; only money says whether the flow is worth sending.
   */
  async function pullEmail() {
    var metrics = await call(KLAVIYO, 'get_metrics', {
      model: 'claude-opus-5', fields_metric: ['name']
    });
    var mp = metrics.payload;
    if (typeof mp === 'string') { try { mp = JSON.parse(mp); } catch (e) { mp = null; } }
    var list = (mp && mp.result && mp.result.data) || (mp && mp.data) || [];
    var placed = list.filter(function (m) {
      return m.attributes && m.attributes.name === 'Placed Order';
    })[0];
    if (!placed) { setConn(KLAVIYO, 'warn', 'Klaviyo · no order metric'); return; }

    var rep = await call(KLAVIYO, 'get_flow_report', {
      model: 'claude-opus-5',
      conversion_metric_id: placed.id,
      statistics: ['recipients', 'conversions', 'conversion_rate', 'open_rate', 'click_rate'],
      value_statistics: ['conversion_value'],
      timeframe: { key: 'last_30_days' },
      filters: 'and(equals(send_channel,"email"))'
    });
    var payload = rep.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }

    var summary = E.summarizeEmail(E.parseFlowReport(payload));
    if (!summary.flows.length) { setConn(KLAVIYO, 'warn', 'Klaviyo · no flow data'); return; }

    if (!VIEW.finance) VIEW.finance = { closed: null, open: null, dailySales: [], salesChangeRatio: null };
    VIEW.finance.email = {
      totalRevenue: summary.totalRevenue,
      totalRecipients: summary.totalRecipients,
      windowDays: 30,
      flows: summary.flows.map(function (f) {
        return {
          name: f.name, recipients: f.recipients, revenue: f.revenue,
          revenuePerRecipient: f.revenuePerRecipient, openRate: f.openRate, clickRate: f.clickRate
        };
      })
    };
    VIEW.signals = VIEW.signals.concat(E.emailSignals(summary, {
      totalBusinessRevenue: VIEW.finance.open ? VIEW.finance.open.netSales : null
    }));
    setConn(KLAVIYO, 'live', 'Klaviyo');
  }

  function iso(d) { return d.toISOString().slice(0, 10); }

  function closesOnDate(label, closeDay) {
    var p = label.split('-');
    return new Date(Date.UTC(Number(p[0]), Number(p[1]), closeDay)).toISOString().slice(0, 10);
  }
  function daysInMonth(label) {
    var p = label.split('-');
    return new Date(Date.UTC(Number(p[0]), Number(p[1]), 0)).getUTCDate();
  }

  /** Receipts, payouts and shipping notices are records, not requests. */
  function looksTransactional(m) {
    var s = (m.subject || '').toLowerCase();
    return /^(payout|receipt|invoice paid|your order|order #|shipping|tracking|payment received|statement)/.test(s)
        || /\b(unsubscribe|newsletter|webinar|watch now|register now)\b/.test(s);
  }

  /**
   * Zoom → meetings + their action items, each re-routed.
   *
   * Zoom's attribution is preserved and shown, but ownership is re-decided by
   * the engine. That disagreement is the point, so the UI surfaces both.
   */
  async function pullMeetings() {
    var to = new Date();
    var from = new Date(to.getTime() - 21 * 86400000);
    var res = await call(ZOOM, 'search_meetings', {
      from: from.toISOString().replace(/\.\d+Z$/, 'Z'),
      to: to.toISOString().replace(/\.\d+Z$/, 'Z'),
      page_size: 12
    });

    var payload = res.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    var list = (payload && payload.meetings) || [];

    var withSummary = list.filter(function (m) { return m.has_summary; }).slice(0, 5);
    var meetings = [];
    var tasks = [];

    for (var i = 0; i < withSummary.length; i++) {
      var rec = withSummary[i];
      var assets = null;
      try {
        var ar = await call(ZOOM, 'get_meeting_assets', { meetingId: rec.meeting_uuid });
        assets = ar.payload;
        if (typeof assets === 'string') { try { assets = JSON.parse(assets); } catch (e) { assets = null; } }
      } catch (e) {
        // One meeting failing must not lose the others.
        meetings.push({ topic: rec.topic, at: rec.meeting_start_time, items: 0, error: true });
        continue;
      }
      if (!assets) { meetings.push({ topic: rec.topic, at: rec.meeting_start_time, items: 0, error: true }); continue; }

      var norm = E.normalizeZoomAssets(assets, rec);
      meetings.push({ topic: norm.meeting.topic || rec.topic, at: rec.meeting_start_time, items: norm.parsed.actionItems.length });

      norm.parsed.actionItems.forEach(function (item) {
        var attributedId = null, attributedName = null;
        if (item.attributedNames.length) {
          var p = E.team.getPersonByAlias(item.attributedNames[0]);
          if (p) { attributedId = p.id; attributedName = p.name; }
          else attributedName = item.attributedNames[0];
        }
        var routed = E.route({
          title: item.text,
          attributedToPersonId: attributedId,
          attributionSource: 'zoom'
        });
        tasks.push({
          id: 'zoom:' + (item.stepId || (rec.meeting_uuid + ':' + item.text.slice(0, 24))),
          title: item.text,
          source: 'Zoom',
          at: rec.meeting_start_time,
          meeting: norm.meeting.topic || rec.topic,
          attributedTo: attributedName,
          routed: routed,
          link: item.taskUrl || null
        });
      });
    }

    VIEW.meetings = meetings;
    VIEW.tasks = VIEW.tasks.filter(function (t) { return t.source !== 'Zoom'; }).concat(tasks);
    setConn(ZOOM, 'live', 'Zoom · ' + meetings.length + ' meetings');
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function effectiveOwner(t) {
    var c = STATE.corrections[t.id];
    return c && c.owner ? c.owner : t.routed.primaryOwnerPersonId;
  }

  function renderAll() {
    // Interpreted state is authoritative; the live pull supplements it with
    // anything that arrived since, routed on metadata alone.
    // One vocabulary: assemble everything in STATE shape, then adapt once for
    // rendering. Mixing the two is how `ceoActionMode` silently reads undefined.
    var rawState = (DATA && DATA.tasks) ? DATA.tasks.slice() : [];
    var stateIds = {};
    rawState.forEach(function (t) { stateIds[t.id] = true; });

    VIEW.tasks.forEach(function (t) {
      if (!stateIds[t.id]) rawState.push(liveToState(t));
    });
    rawState = rawState.concat(generatedTasks())
      .filter(function (t) { return STATE.dismissed.indexOf(t.id) < 0; })
      // Confirmed done in this page. The next sync folds these into the
      // ledger; until then the queue must not keep showing finished work.
      .filter(function (t) { return !STATE.completed[t.id]; });

    // Work that has gone quiet is real but is not today's plan. It gets its
    // own group in the Queue, where the question "still live?" belongs.
    // "Still live" said here overrides the ledger's read of the silence, and
    // holds until the next sync folds the answer in.
    var isQuiet = function (t) { return t.status === 'dormant' && !STATE.stillOpen[t.id]; };
    var dormant = rawState.filter(isQuiet);
    rawState = rawState.filter(function (t) { return !isQuiet(t); });

    var all = rawState.map(fromState);

    // Group suspected duplicates under the record they match, so one incident
    // reported twice reads as one item with two sources.
    var byId = {};
    all.forEach(function (t) { byId[t.id] = t; t.duplicates = []; });
    var primary = [];
    all.forEach(function (t) {
      var parent = t.possibleDuplicateOf && byId[t.possibleDuplicateOf];
      if (parent && parent !== t) parent.duplicates.push(t);
      else primary.push(t);
    });

    var decisions = primary.filter(function (t) {
      return t.ceoRequired && (t.mode === 'DECIDE' || t.mode === 'APPROVE');
    });
    var decisionIds = {};
    decisions.forEach(function (t) { decisionIds[t.id] = true; });

    var actions = primary.filter(function (t) { return t.ceoRequired && !decisionIds[t.id]; });
    var actionIds = {};
    actions.forEach(function (t) { actionIds[t.id] = true; });

    // "Can take off your plate" means exactly that: work sitting with the CEO
    // that someone else could carry. Work that was never his is not a
    // delegation opportunity — it is awareness, and belongs elsewhere.
    var ceoName = 'Adi';
    // Already shown above as a decision or an action — showing it again as a
    // delegation opportunity just makes the day look twice as full.
    var delegate = primary.filter(function (t) {
      if (decisionIds[t.id] || actionIds[t.id]) return false;
      var owner = (STATE.corrections[t.id] && STATE.corrections[t.id].ownerName) || t.owner;
      return owner === ceoName && t.leverage && t.leverage.indexOf('PAUL_CAN') === 0;
    });
    var delegateIds = {};
    delegate.forEach(function (t) { delegateIds[t.id] = true; });

    var moving = primary.filter(function (t) {
      return !t.ceoRequired && !delegateIds[t.id] && !decisionIds[t.id] && !actionIds[t.id];
    });

    renderTasks('b-decisions', decisions);
    renderTasks('b-actions', actions);
    renderTasks('b-delegate', delegate);
    renderTasks('b-moving', moving, { compact: true });

    // If nothing at all needs the CEO, say so once rather than printing two
    // empty headings.
    var quiet = document.getElementById('quiet-note');
    if (quiet) quiet.remove();
    if (!decisions.length && !actions.length && !delegate.length && (DATA || VIEW.tasks.length)) {
      var note = el('div', 'notice', '');
      note.id = 'quiet-note';
      note.setAttribute('data-kind', 'info');
      note.appendChild(el('b', null, 'Nothing needs you today.'));
      note.appendChild(document.createTextNode(
        moving.length ? ' ' + moving.length + ' item' + (moving.length === 1 ? '' : 's') + ' moving without you.' : ''));
      document.getElementById('notices').appendChild(note);
    }
    renderFeed();
    renderMeetings();
    renderWaiting();
    renderBusiness();
    renderNumbers();
    renderSlack();
    renderTeam();
    renderPlan(rawState);
    renderChanged();
    renderChase();
    renderConfirm();
    renderQuiet(dormant);
    renderProposals();
    renderProvenance();
  }

  /** Say plainly how the shown state was produced, and when. */
  function renderProvenance() {
    var meta = document.getElementById('strip-meta');
    if (!meta) return;
    var bits = [];
    if (DATA) {
      var mode = DATA.producedBy === 'metadata-only'
        ? 'metadata only'
        : DATA.producedBy === 'session' ? 'interpreted' : 'interpreted (API)';
      bits.push(mode + ' ' + relTime(DATA.generatedAt));
      if (DATA.counts) bits.push(DATA.counts.mailKept + '/' + DATA.counts.mailSeen + ' mail kept');
    }
    if (STATE.lastSync) bits.push('live ' + relTime(STATE.lastSync));
    meta.textContent = bits.length ? bits.join(' · ') : 'Not yet synced';
  }

  function renderTasks(blockId, tasks, opts) {
    opts = opts || {};
    var section = document.getElementById(blockId);
    var body = bodyOf(blockId);
    clear(body);

    // An empty section is omitted, never printed empty. "RISKS: none" trains
    // the reader to skim, and a skimmed brief has failed.
    if (!tasks.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    countOf(blockId).textContent = String(tasks.length);
    if (opts.compact) {
      var card = el('div', 'card');
      tasks.slice(0, 12).forEach(function (t) { card.appendChild(compactRow(t)); });
      body.appendChild(card);
      return;
    }
    tasks.slice(0, 12).forEach(function (t) { body.appendChild(taskCard(t)); });
  }

  /** One line per item: enough to recognize it, not enough to invite reading. */
  function compactRow(t) {
    var row = el('div', 'wait-row');
    var owner = (STATE.corrections[t.id] && STATE.corrections[t.id].ownerName) || t.owner || t.externalParty || '—';
    row.appendChild(el('span', 'who', owner));
    row.appendChild(el('span', 'what', t.title));
    if (t.deadline) {
      var d = el('span', 'days mono', fmtDate(t.deadline));
      row.appendChild(d);
    }
    return row;
  }

  function taskCard(t) {
    var card = el('div', 'card');

    var top = el('div', 'card-top');
    var modeLabel = t.mode || (t.leverage || '').replace(/^PAUL_CAN_/, '').replace(/_/g, ' ') || 'FYI';
    var mode = el('span', 'mode', modeLabel.replace(/_/g, ' '));
    mode.setAttribute('data-m', t.mode || 'AWARE');
    top.appendChild(mode);
    top.appendChild(el('h3', null, t.title));
    if (t.score) {
      var sc = el('span', 'score mono', String(Math.round(t.score)));
      sc.title = 'Priority score';
      top.appendChild(sc);
    }
    var chip = el('span', 'chip', t.approvalClass);
    chip.setAttribute('data-c', t.approvalClass);
    top.appendChild(chip);
    card.appendChild(top);

    if (t.summary) card.appendChild(el('p', 'why', t.summary));

    if (t.drivers && t.drivers.length) {
      card.appendChild(el('p', 'next', 'Ranked here because ' + t.drivers[0] + '.'));
    }

    var ownerId = STATE.corrections[t.id] && STATE.corrections[t.id].ownerName;
    var ownerName = ownerId || t.owner;

    var roles = el('div', 'roles');
    if (ownerName) roles.appendChild(rolePill('Owner', ownerName));
    if (t.projectManager && t.projectManager !== ownerName) roles.appendChild(rolePill('Tracks', t.projectManager));
    if (t.decisionMaker && t.decisionMaker !== ownerName) roles.appendChild(rolePill('Decides', t.decisionMaker));
    if (t.externalParty) roles.appendChild(rolePill('External', t.externalParty, true));
    if (t.attributedTo && t.attributionOverridden) roles.appendChild(rolePill('Source said', t.attributedTo));
    if (t.deadline) roles.appendChild(rolePill('Due', fmtDate(t.deadline)));

    var src = el('span', 'role');
    src.appendChild(el('b', null, t.source));
    roles.appendChild(src);

    if (!t.interpreted) {
      var thin = el('span', 'role');
      thin.title = 'Routed from subject and metadata only — no body was read';
      thin.appendChild(document.createTextNode('metadata only'));
      roles.appendChild(thin);
    }
    card.appendChild(roles);

    // A second report of the same incident, kept but folded in.
    if (t.duplicates && t.duplicates.length) {
      var dupBox = el('div', 'reason');
      var dupText = t.duplicates.length === 1
        ? 'Also reported once elsewhere'
        : 'Also reported ' + t.duplicates.length + ' times elsewhere';
      var dl = el('div', null, dupText + ' — kept as separate records pending your check.');
      dl.style.fontSize = '12.5px';
      dupBox.appendChild(dl);
      t.duplicates.forEach(function (d) {
        var line = el('div', null, '• ' + d.source + ': ' + d.title);
        line.style.fontSize = '12px';
        line.style.marginTop = '3px';
        dupBox.appendChild(line);
      });
      card.appendChild(dupBox);
    }

    if (t.reason) {
      var det = el('details', 'reason');
      det.appendChild(el('summary', null, 'Why this routing'));
      det.appendChild(el('p', null, t.reason));
      card.appendChild(det);
    }

    var fix = el('div', 'fix');
    fix.appendChild(el('label', null, 'Wrong owner?'));
    var sel = document.createElement('select');
    var none = document.createElement('option');
    none.value = ''; none.textContent = 'Reassign to…';
    sel.appendChild(none);
    E.lookup.allPeople().forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      if (p.name === ownerName) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      if (!sel.value) return;
      var person = E.lookup.person(sel.value);
      STATE.corrections[t.id] = {
        owner: sel.value,
        ownerName: person ? person.name : sel.value,
        was: t.owner,
        at: new Date().toISOString()
      };
      persist();
      renderAll();
    });
    fix.appendChild(sel);

    var dismiss = el('button', 'btn tiny', 'Not important');
    dismiss.addEventListener('click', function () {
      STATE.dismissed.push(t.id);
      persist();
      renderAll();
    });
    fix.appendChild(dismiss);

    if (t.link) {
      var open = document.createElement('a');
      open.href = t.link; open.target = '_blank'; open.rel = 'noopener';
      open.className = 'btn tiny'; open.textContent = 'Open';
      open.style.textDecoration = 'none';
      fix.appendChild(open);
    }
    card.appendChild(fix);
    return card;
  }

  function rolePill(label, name, ext) {
    var p = el('span', 'role' + (ext ? ' ext' : ''));
    p.appendChild(document.createTextNode(label));
    p.appendChild(el('b', null, name || '—'));
    return p;
  }

  function renderFeed() {
    var body = bodyOf('b-feed');
    clear(body);
    var rows = (DATA && DATA.triage ? DATA.triage : []).slice();
    VIEW.feed.forEach(function (f) {
      if (!rows.some(function (r) { return r.subject === f.subject; })) {
        rows.push({ subject: f.subject, kept: f.kept, reason: f.reason, at: f.at });
      }
    });
    if (!rows.length) { document.getElementById('b-feed').style.display = 'none'; return; }

    var kept = rows.filter(function (r) { return r.kept; }).length;
    countOf('b-feed').textContent = kept + ' kept of ' + rows.length;

    var wrap = el('div', 'feed');
    rows.slice(0, 30).forEach(function (f) {
      var row = el('div', 'feed-row ' + (f.kept ? 'kept' : 'filtered'));
      row.appendChild(el('span', 'verdict', f.kept ? 'KEPT' : 'DROPPED'));
      row.appendChild(el('span', 'subj', f.subject));
      row.appendChild(el('span', 'rsn', f.reason));
      wrap.appendChild(row);
    });
    body.appendChild(wrap);
  }

  function renderMeetings() {
    var body = bodyOf('b-meetings');
    clear(body);
    var list = (DATA && DATA.meetings ? DATA.meetings : []).map(function (m) {
      return { topic: m.topic, at: m.at, items: m.actionItemCount, decisions: m.decisions || [] };
    }).concat(VIEW.meetings.map(function (m) {
      return { topic: m.topic, at: m.at, items: m.items, decisions: [], error: m.error };
    }));

    if (!list.length) { document.getElementById('b-meetings').style.display = 'none'; return; }
    countOf('b-meetings').textContent = String(list.length);

    var card = el('div', 'card');
    list.slice(0, 6).forEach(function (m) {
      var row = el('div', 'meeting');
      var top = el('div', 'm-top');
      top.appendChild(el('span', 'm-date mono', fmtDate(m.at)));
      top.appendChild(el('span', 'm-topic', m.topic || 'Untitled'));
      row.appendChild(top);
      row.appendChild(el('div', 'm-items',
        m.error ? 'Summary unavailable'
                : m.items + (m.items === 1 ? ' action item' : ' action items')));
      (m.decisions || []).slice(0, 2).forEach(function (d) {
        var dd = el('div', 'm-items', '· ' + d);
        dd.style.marginTop = '3px';
        row.appendChild(dd);
      });
      card.appendChild(row);
    });
    body.appendChild(card);
  }

  /**
   * Waiting-on comes from extracted commitments, which is the only honest
   * source: it records what was actually promised, in which direction.
   */
  function renderWaiting() {
    var body = bodyOf('b-waiting');
    clear(body);
    var list = (DATA && DATA.commitments ? DATA.commitments : []);
    if (!list.length) { document.getElementById('b-waiting').style.display = 'none'; return; }
    countOf('b-waiting').textContent = String(list.length);

    var card = el('div', 'card');
    ['they_owe', 'we_owe', 'internal'].forEach(function (dir) {
      var group = list.filter(function (c) { return c.direction === dir; });
      if (!group.length) return;
      var head = el('div', 'wait-row');
      var label = el('span', 'who', dir === 'they_owe' ? 'They owe us'
                : dir === 'we_owe' ? 'We owe them' : 'Internal');
      label.style.fontSize = '11px';
      label.style.letterSpacing = '.06em';
      label.style.textTransform = 'uppercase';
      head.appendChild(label);
      card.appendChild(head);

      group.forEach(function (c) {
        var row = el('div', 'wait-row');
        var d = el('span', 'days mono', c.businessDaysOutstanding + 'd');
        if (c.businessDaysOutstanding >= 4) d.setAttribute('data-late', '1');
        row.appendChild(d);
        row.appendChild(el('span', 'who', c.counterparty || c.owedBy || '—'));
        row.appendChild(el('span', 'what', c.description));
        card.appendChild(row);

        if (c.followUpOwner) {
          var note = el('div', 'subline',
            (c.explicit ? '' : 'Implied. ') + c.followUpOwner + ' chases; ' +
            (c.relationshipOwner || 'the owner') + ' sends.');
          note.style.paddingLeft = '2px';
          card.appendChild(note);
        }
      });
    });
    body.appendChild(card);
  }

  /**
   * The Business panel.
   *
   * Leads with the one number that matters — is the period making money — then
   * the movement that explains it, then only signals material enough to act on.
   */
/* ===========================================================================
   TODAY — the ordered plan
   =========================================================================== */

  function renderPlan(tasks) {
    var section = document.getElementById('b-plan');
    var body = bodyOf('b-plan');
    var later = document.getElementById('b-later');
    clear(body); clear(bodyOf('b-later'));

    var plan = E.buildDayPlan(tasks, { ceoName: 'Adi' });

    if (!plan.slots.length && !plan.deferred.length) {
      section.style.display = '';
      body.appendChild(el('div', 'empty', 'Nothing needs you today.'));
      later.style.display = 'none';
      return;
    }
    section.style.display = '';
    section.querySelector('.note').textContent = plan.fits ? 'fits the day' : 'more than fits';
    countOf('b-plan').textContent = String(plan.slots.length);

    // Budget first: a plan that ignores the hours left is not a plan.
    var budget = el('div', 'budget');
    budget.appendChild(el('span', 'big', fmtMins(plan.minutesPlanned)));
    budget.appendChild(el('span', 'sub', plan.summary));
    var bar = el('div', 'bar');
    var pctFull = plan.minutesAvailable > 0
      ? Math.min(100, (plan.minutesPlanned / plan.minutesAvailable) * 100) : 100;
    if (plan.minutesPlanned > plan.minutesAvailable) bar.setAttribute('data-over', '1');
    var fill = el('span'); fill.style.width = pctFull + '%';
    bar.appendChild(fill);
    budget.appendChild(bar);
    body.appendChild(budget);

    plan.slots.forEach(function (slot, i) { body.appendChild(stepRow(slot, i + 1)); });

    if (plan.deferred.length) {
      later.style.display = '';
      countOf('b-later').textContent = String(plan.deferred.length);
      var card = el('div', 'card');
      plan.deferred.forEach(function (slot) {
        var row = el('div', 'wait-row');
        row.appendChild(el('span', 'days mono', fmtMins(slot.minutes)));
        row.appendChild(el('span', 'what', slot.task.title));
        card.appendChild(row);
      });
      bodyOf('b-later').appendChild(card);
    } else {
      later.style.display = 'none';
    }
  }

/* ===========================================================================
   SINCE YOU LAST LOOKED — the delta
   =========================================================================== */

  /**
   * What changed since the previous sync.
   *
   * A snapshot answers "what is true". Someone opening this every morning is
   * asking something narrower: "what do I need to look at that I have not
   * already looked at". Only a delta answers that, and only a system with
   * memory can compute one — which is why this block is empty on a first run
   * and says so rather than presenting everything as news.
   */
  function renderChanged() {
    var section = document.getElementById('b-changed');
    var body = bodyOf('b-changed');
    if (!section) return;
    clear(body);

    var d = DATA && DATA.delta;
    if (!d) {
      section.style.display = '';
      section.querySelector('.note').textContent = '';
      countOf('b-changed').textContent = '';
      body.appendChild(el('div', 'empty',
        'First sync — nothing to compare against yet. From tomorrow this shows what moved.'));
      return;
    }

    // Answered in this page already; showing it again would be asking twice.
    var completed = d.completed.filter(function (x) { return !STATE.stillOpen[x.id]; });
    var added = d.added.filter(function (x) { return !STATE.completed[x.id]; });
    var moved = d.moved.filter(function (x) { return !STATE.completed[x.id]; });
    var quiet = d.quiet.filter(function (x) { return !STATE.completed[x.id]; });

    var total = completed.length + added.length + moved.length + quiet.length + d.reopened.length;
    section.style.display = '';
    section.querySelector('.note').textContent = d.since ? 'since ' + relTime(d.since) : '';
    countOf('b-changed').textContent = String(total);

    if (!total) {
      body.appendChild(el('div', 'empty', 'Nothing moved since your last sync.'));
      return;
    }

    var chips = el('div', 'deltas');
    [['completed', completed.length, 'finished'],
     ['added', added.length, 'new'],
     ['moved', moved.length, 'moved'],
     ['reopened', d.reopened.length, 'came back'],
     ['quiet', quiet.length, 'gone quiet']].forEach(function (row) {
      if (!row[1]) return;
      var chip = el('span', 'dchip');
      chip.setAttribute('data-k', row[0]);
      chip.appendChild(el('b', null, String(row[1])));
      chip.appendChild(document.createTextNode(row[2]));
      chips.appendChild(chip);
    });
    body.appendChild(chips);

    var list = el('div', 'dlist');
    completed.forEach(function (x) {
      list.appendChild(deltaLine('completed', '✓', x.title, x.label, null));
    });
    d.reopened.forEach(function (x) {
      list.appendChild(deltaLine('reopened', '↺', x.title, 'active again after going quiet', null));
    });
    moved.slice(0, 4).forEach(function (x) {
      var dir = x.toRank < x.fromRank ? 'up' : 'down';
      list.appendChild(deltaLine('moved', dir === 'up' ? '↑' : '↓', x.title, null,
        '#' + x.fromRank + ' → #' + x.toRank));
    });
    added.slice(0, 4).forEach(function (x) {
      list.appendChild(deltaLine('added', '+', x.title, null, x.rank ? '#' + x.rank : null));
    });
    quiet.slice(0, 3).forEach(function (x) {
      list.appendChild(deltaLine('quiet', '·', x.title,
        'no evidence for ' + x.daysSilent + ' days', null));
    });
    body.appendChild(list);
  }

  function deltaLine(kind, mark, title, sub, move) {
    var row = el('div', 'dline');
    row.setAttribute('data-k', kind);
    row.appendChild(el('span', 'mark', mark));
    var txt = el('div', 'txt');
    txt.appendChild(document.createTextNode(title));
    if (sub) { txt.appendChild(document.createElement('br')); txt.appendChild(el('span', 'sub', sub)); }
    row.appendChild(txt);
    if (move) row.appendChild(el('span', 'move', move));
    return row;
  }

/* ===========================================================================
   OWED TO US — commitments past their cadence
   =========================================================================== */

  /**
   * Note what each row says: a draft is READY, for a named person.
   *
   * The system never writes in someone else's name, so the output of chasing
   * is a prompt to whoever owns the relationship — not a sent message. What it
   * contributes is the noticing, which is the part that actually fails.
   */
  function renderChase() {
    var section = document.getElementById('b-chase');
    var body = bodyOf('b-chase');
    if (!section) return;
    clear(body);

    var due = (DATA && DATA.followUps) || [];
    due = due.filter(function (f) { return !STATE.completed['commitment:' + f.id]; });
    if (!due.length) { section.style.display = 'none'; return; }

    section.style.display = '';
    countOf('b-chase').textContent = String(due.length);

    var card = el('div', 'card');
    due.forEach(function (f) {
      var item = el('div', 'qitem');
      var row = el('div', 'wait-row');
      var d = el('span', 'days mono', f.businessDaysOverdue + 'd');
      if (f.escalateToCeo || f.businessDaysOverdue >= 10) d.setAttribute('data-late', '1');
      row.appendChild(d);
      row.appendChild(el('span', 'who', f.counterparty || f.owedBy || '—'));
      row.appendChild(el('span', 'what', f.description));
      item.appendChild(row);

      var note = el('div', 'subline',
        (f.attempt > 1 ? 'Nudge #' + f.attempt + '. ' : '') +
        (f.dueDate ? 'Promised ' + fmtDate(f.dueDate) + '. ' : 'No date was ever given. ') +
        (f.followUpOwner ? f.followUpOwner + ' chases' : 'Nobody assigned to chase') +
        (f.relationshipOwner ? '; ' + f.relationshipOwner + ' sends.' : '.'));
      note.style.paddingLeft = '2px';
      item.appendChild(note);

      if (f.quote) {
        // Their own words. Far more persuasive to whoever has to send the
        // nudge than any summary of them.
        var q = el('div', 'ev', '\u201C' + f.quote + '\u201D');
        q.style.margin = '7px 0 0 2px';
        item.appendChild(q);
      }

      var act = el('div', 'fix');
      var got = el('button', 'btn tiny', 'Already have it');
      got.addEventListener('click', function () {
        STATE.completed['commitment:' + f.id] = { at: new Date().toISOString(), by: 'confirmed' };
        persist(); renderAll();
      });
      act.appendChild(got);
      act.style.paddingLeft = '2px';
      item.appendChild(act);
      card.appendChild(item);
    });
    body.appendChild(card);
  }

/* ===========================================================================
   DID THESE GET DONE? — inference that stops short of acting
   =========================================================================== */

  /**
   * Evidence conclusive enough to close cheap work, on an item too
   * consequential to close on inference.
   *
   * The asymmetry decides it: a task wrongly left open costs a moment to
   * dismiss, while a $40k commitment wrongly closed disappears along with the
   * money. So the system does the noticing and the human does the deciding,
   * which is one click either way.
   */
  function renderConfirm() {
    var section = document.getElementById('b-confirm');
    var body = bodyOf('b-confirm');
    if (!section) return;
    clear(body);

    var pending = ((DATA && DATA.delta && DATA.delta.awaitingConfirmation) || [])
      .filter(function (x) { return !STATE.completed[x.id] && !STATE.stillOpen[x.id]; });
    if (!pending.length) { section.style.display = 'none'; return; }

    section.style.display = '';
    countOf('b-confirm').textContent = String(pending.length);

    pending.forEach(function (x) {
      var card = el('div', 'confirm');
      card.appendChild(el('div', 'q', x.title));
      card.appendChild(el('div', 'ev', x.evidence));
      card.appendChild(el('div', 'why',
        'Reads as ' + x.label + ' (' + Math.round(x.confidence * 100) + '% confident), but ' + x.reason + '.'));

      var act = el('div', 'fix');
      var yes = el('button', 'btn tiny primary', 'Yes, done');
      yes.addEventListener('click', function () {
        STATE.completed[x.id] = { at: new Date().toISOString(), by: 'confirmed' };
        persist(); renderAll();
      });
      var no = el('button', 'btn tiny', 'No, still open');
      no.addEventListener('click', function () {
        // Recorded, not just dismissed: this is the system being told it read
        // the evidence wrong, which is worth more than the answer itself.
        STATE.stillOpen[x.id] = new Date().toISOString();
        persist(); renderAll();
      });
      act.appendChild(yes); act.appendChild(no);
      card.appendChild(act);
      body.appendChild(card);
    });
  }

/* ===========================================================================
   GONE QUIET — asked once, not every morning
   =========================================================================== */

  function renderQuiet(tasks) {
    var section = document.getElementById('b-quiet');
    var body = bodyOf('b-quiet');
    if (!section) return;
    clear(body);
    if (!tasks || !tasks.length) { section.style.display = 'none'; return; }

    section.style.display = '';
    countOf('b-quiet').textContent = String(tasks.length);

    /*
     * Capped deliberately. After a long gap the ledger can hold dozens of
     * quiet items at once, and putting thirty "was this done?" buttons on one
     * page is the same nagging the cadence rules exist to prevent — just all
     * at once instead of daily. Show the longest-silent few; the rest keep
     * their place and surface as these are answered.
     */
    var QUIET_SHOWN = 6;
    var shown = tasks.slice()
      .sort(function (a, b) { return (b.daysSilent || 0) - (a.daysSilent || 0); })
      .slice(0, QUIET_SHOWN);

    var card = el('div', 'card');
    shown.forEach(function (t) {
      var item = el('div', 'qitem');
      var row = el('div', 'wait-row');
      var d = el('span', 'days mono', (t.daysSilent == null ? '?' : t.daysSilent) + 'd');
      d.setAttribute('data-late', '1');
      row.appendChild(d);
      row.appendChild(el('span', 'who', t.primaryOwner || t.externalParty || '—'));
      row.appendChild(el('span', 'what', t.title));
      item.appendChild(row);

      var act = el('div', 'fix');
      var done = el('button', 'btn tiny', 'Was done');
      done.addEventListener('click', function () {
        STATE.completed[t.id] = { at: new Date().toISOString(), by: 'manual' };
        persist(); renderAll();
      });
      var live = el('button', 'btn tiny', 'Still live');
      live.addEventListener('click', function () {
        STATE.stillOpen[t.id] = new Date().toISOString();
        persist(); renderAll();
      });
      act.appendChild(done); act.appendChild(live);
      act.style.paddingLeft = '2px';
      item.appendChild(act);
      card.appendChild(item);
    });

    if (tasks.length > shown.length) {
      var more = el('div', 'subline',
        (tasks.length - shown.length) + ' more have gone quiet. They keep their place; ' +
        'these surface as you answer.');
      more.style.paddingLeft = '2px';
      card.appendChild(more);
    }
    body.appendChild(card);
  }

  function stepRow(slot, n) {
    var t = slot.task;
    var row = el('div', 'step');
    row.setAttribute('data-kind', slot.kind);

    var done = STATE.done.indexOf(t.id) >= 0;
    var num = el('div', 'step-n', done ? '✓' : String(n));
    row.appendChild(num);

    var b = el('div', 'step-body');
    var title = el('div', 'step-title', t.title);
    if (done) { title.style.textDecoration = 'line-through'; title.style.opacity = '.55'; }
    b.appendChild(title);

    var meta = el('div', 'step-meta');
    if (t.ceoActionMode) {
      var mode = el('span', 'mode', t.ceoActionMode.replace(/_/g, ' '));
      mode.setAttribute('data-m', t.ceoActionMode);
      meta.appendChild(mode);
    }
    meta.appendChild(el('span', 'mins', fmtMins(slot.minutes)));
    if (t.primaryOwner && t.primaryOwner !== 'Adi') meta.appendChild(rolePill('With', t.primaryOwner));
    if (t.externalParty) meta.appendChild(rolePill('External', t.externalParty, true));
    if (t.deadline) meta.appendChild(rolePill('Due', fmtDate(t.deadline)));
    b.appendChild(meta);

    b.appendChild(el('div', 'step-why', slot.why));
    var move = el('div', 'step-move');
    move.appendChild(el('b', null, 'Next: '));
    move.appendChild(document.createTextNode(slot.move));
    b.appendChild(move);

    var act = el('div', 'fix');
    var mark = el('button', 'btn tiny', done ? 'Undo' : 'Done');
    mark.addEventListener('click', function () {
      var i = STATE.done.indexOf(t.id);
      if (i >= 0) STATE.done.splice(i, 1); else STATE.done.push(t.id);
      persist(); renderAll();
    });
    act.appendChild(mark);
    if (t.link) {
      var open = document.createElement('a');
      open.href = t.link; open.target = '_blank'; open.rel = 'noopener';
      open.className = 'btn tiny'; open.textContent = 'Open';
      open.style.textDecoration = 'none';
      act.appendChild(open);
    }
    b.appendChild(act);

    row.appendChild(b);
    return row;
  }

  function fmtMins(m) {
    if (m >= 60) return (m / 60).toFixed(m % 60 === 0 ? 0 : 1) + 'h';
    return m + 'm';
  }

/* ===========================================================================
   STRATEGY — proposals, and the work choosing one creates
   =========================================================================== */

  /**
   * Tasks materialized from accepted proposals.
   *
   * Routed through the SAME engine as everything else, so a chosen strategy
   * arrives with a real owner rather than as a note to self.
   */
  function generatedTasks() {
    var out = [];
    Object.keys(STATE.chosen).forEach(function (pid) {
      (STATE.chosen[pid].tasks || []).forEach(function (t) {
        if (STATE.dismissed.indexOf(t.id) >= 0) return;
        out.push(t);
      });
    });
    return out;
  }

  function renderProposals() {
    var section = document.getElementById('b-proposals');
    var body = bodyOf('b-proposals');
    clear(body);
    var proposals = (DATA && DATA.proposals) || [];
    if (!proposals.length) {
      body.appendChild(el('div', 'empty', 'Nothing to weigh up right now.'));
    } else {
      var open = proposals.filter(function (p) { return !STATE.chosen[p.id]; });
      countOf('b-proposals').textContent = String(open.length);
      if (!open.length) body.appendChild(el('div', 'empty', 'All current options taken up.'));
      open.forEach(function (p) { body.appendChild(proposalCard(p, false)); });
    }
    renderChosen(proposals);
  }

  function renderChosen(proposals) {
    var section = document.getElementById('b-chosen');
    var body = bodyOf('b-chosen');
    clear(body);
    var ids = Object.keys(STATE.chosen);
    if (!ids.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    countOf('b-chosen').textContent = String(ids.length);
    ids.forEach(function (id) {
      var p = proposals.filter(function (x) { return x.id === id; })[0];
      if (p) body.appendChild(proposalCard(p, true));
    });
  }

  function proposalCard(p, chosen) {
    var card = el('div', 'prop' + (chosen ? ' chosen' : ''));

    var top = el('div', 'prop-top');
    top.appendChild(el('h3', null, p.title));
    var h = el('span', 'horizon', p.horizon === 'now' ? 'now' : p.horizon);
    h.setAttribute('data-h', p.horizon);
    top.appendChild(h);
    card.appendChild(top);

    card.appendChild(el('div', 'prop-why', p.rationale));

    // The facts it rests on. A proposal without these is an opinion.
    if (p.basis && p.basis.length) {
      var ul = el('ul', 'basis');
      p.basis.forEach(function (b) { ul.appendChild(el('li', null, b)); });
      card.appendChild(ul);
    }

    var meta = el('div', 'prop-meta');
    meta.appendChild(labelled('Impact', p.expectedImpact + '/5'));
    meta.appendChild(labelled('Effort', p.effort + '/5'));
    if (p.valueAtStake) meta.appendChild(labelled('At stake', E.money(p.valueAtStake)));
    card.appendChild(meta);

    // Preview what accepting it would create, routed live so the owners shown
    // are the real ones.
    var gen = el('div', 'gen');
    gen.appendChild(el('div', 'gen-h', chosen ? 'Created' : 'Choosing this creates'));
    (p.generates || []).forEach(function (g) {
      var routed = routeGenerated(g);
      var row = el('div', 'gen-row');
      row.appendChild(el('span', null, '· ' + g.title));
      row.appendChild(el('span', 'who', ownerLabel(routed)));
      gen.appendChild(row);
    });
    card.appendChild(gen);

    var act = el('div', 'prop-act');
    if (!chosen) {
      var take = el('button', 'btn primary tiny', 'Take this on');
      take.addEventListener('click', function () { chooseProposal(p); });
      act.appendChild(take);
      var pass = el('button', 'btn tiny', 'Not now');
      pass.addEventListener('click', function () {
        STATE.chosen[p.id] = { at: new Date().toISOString(), passed: true, tasks: [] };
        persist(); renderAll();
      });
      act.appendChild(pass);
    } else {
      var note = el('span', 'mins', STATE.chosen[p.id].passed
        ? 'Passed on ' + fmtDate(STATE.chosen[p.id].at)
        : 'Taken on ' + fmtDate(STATE.chosen[p.id].at));
      act.appendChild(note);
      var undo = el('button', 'btn tiny', 'Undo');
      undo.addEventListener('click', function () {
        delete STATE.chosen[p.id];
        persist(); renderAll();
      });
      act.appendChild(undo);
    }
    card.appendChild(act);
    return card;
  }

  function labelled(k, v) {
    var s = el('span');
    s.appendChild(document.createTextNode(k + ' '));
    s.appendChild(el('b', null, v));
    return s;
  }

  /** Route one generated item through the real engine. */
  function routeGenerated(g) {
    return E.route({
      title: g.title,
      description: g.description,
      businessArea: g.businessArea,
      requiredCapabilities: g.requiredCapabilities || [],
      valueAtStake: g.valueAtStake === undefined ? null : g.valueAtStake,
      isDecision: !!g.isDecision,
      isApproval: !!g.isApproval,
      isStrategicDirection: !!g.isStrategicDirection,
      isPricingOrOffer: !!g.isPricingOrOffer,
      isInformationGathering: !!g.isInformationGathering
    });
  }

  function ownerLabel(r) {
    var owner = E.lookup.personName(r.primaryOwnerPersonId)
      || E.lookup.orgName(r.externalCounterpartyOrganizationId);
    if (r.ceoRequired && (r.ceoActionMode === 'DECIDE' || r.ceoActionMode === 'APPROVE')) {
      return owner && owner !== 'Adi' ? owner + ' · you ' + r.ceoActionMode.toLowerCase() : 'you ' + r.ceoActionMode.toLowerCase();
    }
    return owner || 'unassigned';
  }

  /** Accepting a proposal materializes its work into the real queue. */
  function chooseProposal(p) {
    var tasks = (p.generates || []).map(function (g, i) {
      var r = routeGenerated(g);
      return {
        id: 'prop:' + p.id + ':' + i,
        title: g.title,
        summary: g.description || null,
        source: 'Manual',
        link: null,
        occurredAt: new Date().toISOString(),
        sourceRef: null,
        score: 12 + (p.expectedImpact * 3),
        rank: null,
        drivers: ['you chose to take on "' + p.title + '"'],
        primaryOwner: E.lookup.personName(r.primaryOwnerPersonId),
        projectManager: E.lookup.personName(r.projectManagerPersonId),
        decisionMaker: E.lookup.personName(r.decisionMakerPersonId),
        externalParty: E.lookup.orgName(r.externalCounterpartyOrganizationId),
        collaborators: [],
        ceoRequired: r.ceoRequired,
        ceoActionMode: r.ceoActionMode,
        leverageClass: r.leverage.classification,
        approvalClass: r.approvalClass,
        delegable: r.delegable,
        deadline: null,
        valueAtStake: g.valueAtStake === undefined ? null : g.valueAtStake,
        routingReason: r.reason,
        requiredCapabilities: g.requiredCapabilities || [],
        attributedTo: null, attributionOverridden: false,
        interpreted: true, needsReview: false,
        possibleDuplicateOf: null, duplicateSimilarity: null,
        businessArea: g.businessArea || null
      };
    });
    STATE.chosen[p.id] = { at: new Date().toISOString(), passed: false, tasks: tasks };
    persist();
    renderAll();
    showView('today');   // the point is the work, not the list
  }

/* ===========================================================================
   NUMBERS — how the business is doing
   =========================================================================== */

  function renderNumbers() {
    var f = VIEW.finance || (DATA && DATA.finance) || null;
    var signals = VIEW.signals.length ? VIEW.signals : ((DATA && DATA.signals) || []);
    renderMoney(f);
    renderFunnel(f);
    renderEmail(f);
    renderStock(f);
    renderStandout(signals);
  }

  function renderMoney(f) {
    var section = document.getElementById('n-money');
    var body = bodyOf('n-money');
    clear(body);
    if (!f || !f.closed) { section.style.display = 'none'; return; }
    section.style.display = '';
    section.querySelector('.note').textContent = f.closed.period + ' closed';

    var c = f.closed;
    var card = el('div', 'card');
    var stats = el('div', 'stats');
    stats.appendChild(stat('Net profit', E.money(c.netProfit),
      c.priorNetProfit !== null ? c.priorPeriod + ' ' + E.money(c.priorNetProfit) : null,
      c.netProfit < 0 ? 'neg' : 'pos'));
    stats.appendChild(stat('Net sales', E.money(c.netSales),
      c.priorDailyNetSales && c.dailyNetSales
        ? perDayDelta(c.dailyNetSales, c.priorDailyNetSales) + ' per day' : null));
    stats.appendChild(stat('Paid ads', E.money(c.paidAds), c.period));
    stats.appendChild(stat('Daily sales', f.dailySales.length ? E.money(avgOf(f.dailySales)) : '—',
      f.salesChangeRatio !== null
        ? (f.salesChangeRatio >= 0 ? '+' : '−') + E.pct(f.salesChangeRatio) + ' vs prior week'
        : 'live'));
    card.appendChild(stats);
    if (f.dailySales.length >= 4) card.appendChild(sparkline(f.dailySales));
    if (f.open) {
      var o = el('div', 'openmo');
      o.appendChild(el('span', 'k', o_label(f.open)));
      o.appendChild(el('span', 'v', E.money(f.open.netSales) + ' revenue'));
      o.appendChild(el('span', 'n', closeNoteFor(f.open)));
      card.appendChild(o);
    }
    body.appendChild(card);
  }

  /**
   * The funnel, and the sentence that interprets it.
   *
   * Sessions and conversion together answer a question neither answers alone:
   * whether more spend is failing to buy traffic, or traffic is failing to buy.
   */
  function renderFunnel(f) {
    var section = document.getElementById('n-funnel');
    var body = bodyOf('n-funnel');
    clear(body);
    var t = f && f.traffic;
    if (!t) { section.style.display = 'none'; return; }
    section.style.display = '';

    var card = el('div', 'card');
    var fun = el('div', 'funnel');
    var perWeek = Math.round(t.recentSessions / Math.max(1, t.weeks));
    var priorWeek = Math.round(t.priorSessions / Math.max(1, t.weeks));
    var checkouts = Math.round(t.recentSessions * t.recentRate);

    fun.appendChild(fstep('Sessions', perWeek.toLocaleString(),
      'a week · ' + deltaWord(perWeek, priorWeek)));
    fun.appendChild(fstep('Checkouts', Math.round(checkouts / Math.max(1, t.weeks)).toLocaleString(), 'a week'));
    fun.appendChild(fstep('Conversion', (t.recentRate * 100).toFixed(2) + '%',
      'was ' + (t.priorRate * 100).toFixed(2) + '%'));
    card.appendChild(fun);

    // Say plainly whether the move is distinguishable from chance.
    var line = el('div', 'verdict-line');
    if (t.sigma < 3) {
      line.appendChild(el('b', null, 'Conversion is holding. '));
      line.appendChild(document.createTextNode(
        'Weekly rates swing widely at this volume; across ' + t.weeks +
        '-week blocks the difference is ' + t.sigma.toFixed(1) +
        ' standard errors, which is within chance.'));
    } else {
      line.appendChild(el('b', null, 'Conversion has genuinely moved. '));
      line.appendChild(document.createTextNode(
        t.sigma.toFixed(1) + ' standard errors across ' + t.recentSessions.toLocaleString() +
        ' sessions — too large to be sampling noise.'));
    }
    card.appendChild(line);
    body.appendChild(card);
  }

  function fstep(k, v, d) {
    var s = el('div', 'fstep');
    s.appendChild(el('div', 'fk', k));
    s.appendChild(el('div', 'fv', v));
    if (d) s.appendChild(el('div', 'fd', d));
    return s;
  }

  function deltaWord(now, prior) {
    if (!prior) return '';
    var r = (now - prior) / prior;
    if (Math.abs(r) < 0.03) return 'flat';
    return (r > 0 ? 'up ' : 'down ') + E.pct(r);
  }

  /** Flows ranked by revenue per recipient — the only measure that says "worth sending". */
  /**
   * Stock, and the catalogue it is counted against.
   *
   * Defects lead, because they are the half somebody can act on this morning.
   * Cover follows, and is usually short — a store that sells past zero has
   * quantities that count oversold units rather than remaining ones, and no
   * arithmetic recovers a stock level from that. Saying so plainly is worth
   * more than an empty table with a reassuring heading.
   */
  function renderStock(f) {
    var section = document.getElementById('n-stock');
    var body = bodyOf('n-stock');
    clear(body);
    var inv = f && f.inventory;
    if (!inv) { section.style.display = 'none'; return; }
    section.style.display = '';
    countOf('n-stock').textContent = inv.defects.length ? String(inv.defects.length) : '';
    section.querySelector('.note').textContent = inv.variants + ' variants';

    if (inv.defects.length) {
      var card = el('div', 'card');
      inv.defects.forEach(function (d) {
        var row = el('div', 'defect');
        row.appendChild(el('span', 'mk', d.kind === 'sku_collision' ? '!!' : '!'));
        row.appendChild(el('span', 'hd', d.summary));
        row.appendChild(el('div', 'dt', d.detail));
        card.appendChild(row);
      });
      body.appendChild(card);
    }

    var cover = el('div', 'card');
    if (inv.cover.length) {
      inv.cover.forEach(function (c) {
        var row = el('div', 'coverrow');
        var d = el('span', 'd', c.daysOfCover + 'd');
        if (c.daysOfCover <= 21) d.setAttribute('data-low', '1');
        row.appendChild(d);
        row.appendChild(el('span', 'nm', c.productTitle + (c.variantTitle && c.variantTitle !== 'Default Title' ? ' · ' + c.variantTitle : '')));
        row.appendChild(el('span', 'rt', c.quantity + ' @ ' + c.dailyRate + '/day'));
        cover.appendChild(row);
      });
    }
    if (inv.unwatchedShare >= 0.5) {
      var note = el('div', 'subline',
        Math.round(inv.unwatchedShare * 100) + '% of unit volume sells past zero or carries a placeholder ' +
        'quantity, so it has no readable stock level. Nothing here can warn before a shortage — ' +
        'that check has to come from the production plan.');
      note.style.paddingTop = inv.cover.length ? '10px' : '0';
      cover.appendChild(note);
    }
    if (cover.childNodes.length) body.appendChild(cover);
    if (!body.childNodes.length) body.appendChild(el('div', 'empty', 'Nothing to flag.'));
  }

  function renderEmail(f) {
    var section = document.getElementById('n-email');
    var body = bodyOf('n-email');
    clear(body);
    var e = f && f.email;
    if (!e || !e.flows.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    countOf('n-email').textContent = E.money(e.totalRevenue);

    var ranked = e.flows.slice().sort(function (a, b) {
      return b.revenuePerRecipient - a.revenuePerRecipient;
    });
    var max = ranked[0].revenuePerRecipient || 1;

    var card = el('div', 'card');
    ranked.slice(0, 8).forEach(function (fl) {
      var row = el('div', 'flowrow');
      var left = el('div');
      left.appendChild(el('div', 'flowname', fl.name));
      left.appendChild(el('div', 'flowsub',
        fl.recipients.toLocaleString() + ' sends · ' +
        Math.round(fl.openRate * 100) + '% open · ' + Math.round(fl.clickRate * 100) + '% click'));
      var bar = el('div', 'flowbar');
      if (fl.revenue === 0) bar.setAttribute('data-dead', '1');
      var fill = el('span');
      fill.style.width = Math.max(2, (fl.revenuePerRecipient / max) * 100) + '%';
      bar.appendChild(fill);
      left.appendChild(bar);
      row.appendChild(left);
      row.appendChild(el('div', 'flowval', '$' + fl.revenuePerRecipient.toFixed(2)));
      card.appendChild(row);
    });

    var foot = el('div', 'verdict-line');
    foot.appendChild(document.createTextNode(
      E.money(e.totalRevenue) + ' from ' + e.totalRecipients.toLocaleString() +
      ' sends over ' + e.windowDays + ' days. Bars show revenue per recipient, not opens.'));
    card.appendChild(foot);
    body.appendChild(card);
  }

  function renderStandout(signals) {
    var section = document.getElementById('n-signals');
    var body = bodyOf('n-signals');
    clear(body);
    if (!signals.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    countOf('n-signals').textContent = String(signals.length);
    var card = el('div', 'card');
    signals.slice(0, 8).forEach(function (sg) { card.appendChild(signalRow(sg)); });
    body.appendChild(card);
  }

  function signalRow(sg) {
    var row = el('div', 'sig');
    var top = el('div', 'sig-top');
    var dot = el('span', 'sev');
    dot.setAttribute('data-s', sg.severity >= 7 ? 'high' : sg.severity >= 5 ? 'mid' : 'low');
    top.appendChild(dot);
    top.appendChild(el('span', 'sig-sum', sg.summary));
    row.appendChild(top);
    if (sg.evidence) row.appendChild(el('div', 'sig-ev', sg.evidence));
    if (sg.recommendedAction) row.appendChild(el('div', 'sig-who', sg.recommendedAction));
    return row;
  }

  function closeNoteFor(open) {
    var days = Math.ceil((Date.parse(open.closesOn) - Date.now()) / 86400000);
    var note = 'expenses not final until ' + open.closesOn;
    if (days >= 0 && days <= 14) {
      note += ' · ' + (days === 0 ? 'closing today' : days === 1 ? 'closes tomorrow' : 'closes in ' + days + ' days');
    }
    return note;
  }

  function renderBusiness() {
    var section = document.getElementById('b-business');
    var body = bodyOf('b-business');
    clear(body);

    var f = VIEW.finance || (DATA && DATA.finance) || null;
    var signals = VIEW.signals.length ? VIEW.signals : ((DATA && DATA.signals) || []);
    if (!f && !signals.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    var note = section.querySelector('.note');
    var card = el('div', 'card');

    if (f && f.closed) {
      var c = f.closed;
      note.textContent = c.period + ' closed';

      var stats = el('div', 'stats');
      stats.appendChild(stat('Net profit', E.money(c.netProfit),
        c.priorNetProfit !== null ? c.priorPeriod + ' ' + E.money(c.priorNetProfit) : null,
        c.netProfit < 0 ? 'neg' : 'pos'));
      stats.appendChild(stat('Net sales', E.money(c.netSales),
        c.priorDailyNetSales && c.dailyNetSales
          ? perDayDelta(c.dailyNetSales, c.priorDailyNetSales) + ' per day vs ' + c.priorPeriod
          : null));
      stats.appendChild(stat('Paid ads', E.money(c.paidAds), c.period));
      stats.appendChild(stat('Daily sales', f.dailySales.length ? E.money(avgOf(f.dailySales)) : '—',
        f.salesChangeRatio !== null
          ? (f.salesChangeRatio >= 0 ? '+' : '−') + E.pct(f.salesChangeRatio) + ' vs prior week'
          : 'live, last 7 days'));
      card.appendChild(stats);
    } else if (f) {
      note.textContent = 'awaiting close';
    }

    if (f && f.dailySales.length >= 4) card.appendChild(sparkline(f.dailySales));

    /*
     * The open month, stated for what it is.
     *
     * Revenue arrives through automated integrations and is broadly current;
     * expenses lag until the close, so no profit is shown. Saying this plainly
     * is what stops the reader assuming the closed figures describe today.
     */
    if (f && f.open) {
      var o = el('div', 'openmo');
      o.appendChild(el('span', 'k', o_label(f.open)));
      o.appendChild(el('span', 'v', E.money(f.open.netSales) + ' revenue'));
      // During the window between month end and the close, the newest closed
      // month is two months back. Saying how long explains the gap rather than
      // leaving it to feel like stale data.
      var daysToClose = Math.ceil((Date.parse(f.open.closesOn) - Date.now()) / 86400000);
      var closeNote = 'expenses not final until ' + f.open.closesOn;
      if (daysToClose >= 0 && daysToClose <= 14) {
        closeNote += ' · ' + (daysToClose === 0 ? 'closing today'
          : daysToClose === 1 ? 'closes tomorrow' : 'closes in ' + daysToClose + ' days');
      }
      o.appendChild(el('span', 'n', closeNote));
      card.appendChild(o);
    }

    signals.slice(0, 4).forEach(function (sg) {
      var row = el('div', 'sig');
      var top = el('div', 'sig-top');
      var dot = el('span', 'sev');
      dot.setAttribute('data-s', sg.severity >= 7 ? 'high' : sg.severity >= 5 ? 'mid' : 'low');
      top.appendChild(dot);
      top.appendChild(el('span', 'sig-sum', sg.summary));
      row.appendChild(top);
      if (sg.recommendedAction) row.appendChild(el('div', 'sig-ev', sg.recommendedAction));
      if (sg.likelyPeople && sg.likelyPeople.length) {
        row.appendChild(el('div', 'sig-who', 'Likely: ' + sg.likelyPeople.join(', ')));
      }
      card.appendChild(row);
    });

    body.appendChild(card);
    countOf('b-business').textContent = signals.length ? String(signals.length) : '';
  }

  function o_label(open) {
    return open.period + ' · ' + open.daysElapsed + ' days in';
  }

  function stat(label, value, sub, sign) {
    var d = el('div', 'stat');
    d.appendChild(el('div', 'k', label));
    var v = el('div', 'v', value);
    if (sign) v.setAttribute('data-sign', sign);
    d.appendChild(v);
    if (sub) d.appendChild(el('div', 's', sub));
    return d;
  }

  function perDayDelta(now, prior) {
    if (!prior) return '';
    var r = (now - prior) / prior;
    if (Math.abs(r) < 0.02) return 'flat';
    return (r > 0 ? '+' : '−') + E.pct(r);
  }

  function priorLabel(period) {
    var p = period.split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 2, 1));
    return d.toISOString().slice(0, 7);
  }

  function avgOf(points) {
    var last = points.slice(-7);
    if (!last.length) return 0;
    return last.reduce(function (s, p) { return s + p.value; }, 0) / last.length;
  }

  /**
   * Daily sales sparkline.
   *
   * One series, so no legend — the caption names it. Today is excluded upstream
   * because a morning read of a partial day looks like a crash. 2px line, soft
   * area fill, emphasized final point, hover for the exact day.
   */
  function sparkline(points) {
    var W = 260, H = 46, PAD = 3;
    var wrap = el('div', 'spark');
    var values = points.map(function (p) { return p.value; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = (max - min) || 1;

    var x = function (i) { return PAD + (i * (W - PAD * 2)) / Math.max(1, points.length - 1); };
    var y = function (v) { return H - PAD - ((v - min) / span) * (H - PAD * 2); };

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Daily sales, last ' + points.length + ' complete days');

    var line = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i) + ' ' + y(p.value); }).join(' ');

    var area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', line + ' L' + x(points.length - 1) + ' ' + (H - PAD) + ' L' + x(0) + ' ' + (H - PAD) + ' Z');
    area.setAttribute('fill', 'var(--accent)');
    area.setAttribute('opacity', '0.10');
    svg.appendChild(area);

    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', line);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--accent)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);

    var lastIdx = points.length - 1;
    var end = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    end.setAttribute('cx', String(x(lastIdx)));
    end.setAttribute('cy', String(y(points[lastIdx].value)));
    end.setAttribute('r', '3');
    end.setAttribute('fill', 'var(--accent)');
    end.setAttribute('stroke', 'var(--surface)');
    end.setAttribute('stroke-width', '2');
    svg.appendChild(end);

    wrap.appendChild(svg);

    var cap = el('div', 'cap', 'Daily sales · last ' + points.length + ' complete days');
    wrap.appendChild(cap);

    // Hover layer: an SVG chart on a page is interactive by default.
    var tip = el('div', 'spark-tip');
    wrap.appendChild(tip);
    svg.addEventListener('mousemove', function (ev) {
      var box = svg.getBoundingClientRect();
      var ratio = (ev.clientX - box.left) / box.width;
      var i = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
      var p = points[i];
      tip.textContent = p.day.slice(5) + '  ' + E.money(p.value);
      tip.style.left = (x(i) / W * 100) + '%';
      tip.style.top = (y(p.value) / H * box.height) + 'px';
      tip.setAttribute('data-on', '1');
    });
    svg.addEventListener('mouseleave', function () { tip.removeAttribute('data-on'); });

    return wrap;
  }

  function renderSlack() {
    var section = document.getElementById('b-slack');
    var body = bodyOf('b-slack');
    clear(body);
    var rows = VIEW.slack || [];
    if (!rows.length && !VIEW.slackRaw) { section.style.display = 'none'; return; }
    section.style.display = '';
    countOf('b-slack').textContent = String(rows.length || '');

    var card = el('div', 'card');
    if (!rows.length) {
      var pre = el('div', 'm-items', String(VIEW.slackRaw).slice(0, 800));
      pre.style.whiteSpace = 'pre-wrap';
      card.appendChild(pre);
    } else {
      rows.slice(0, 10).forEach(function (m) {
        var row = el('div', 'meeting');
        var top = el('div', 'm-top');
        top.appendChild(el('span', 'm-date mono', shortChannel(m.channel)));
        top.appendChild(el('span', 'm-topic', m.author));
        row.appendChild(top);
        row.appendChild(el('div', 'm-items', m.text.slice(0, 170)));
        card.appendChild(row);
      });
    }
    body.appendChild(card);
  }

  function shortChannel(c) {
    if (/^#/.test(c)) return c.length > 16 ? c.slice(0, 15) + '…' : c;
    if (/^Group DM/i.test(c)) return 'group';
    if (/^DM/i.test(c)) return 'dm';
    return c.slice(0, 14);
  }

  function renderTeam() {
    var body = bodyOf('b-team');
    clear(body);
    var card = el('div', 'card');
    E.lookup.allPeople().forEach(function (p) {
      // Prefer primary capabilities; fall back to whatever they hold, so people
      // who are involved selectively still show what they are involved IN.
      var edges = p.capabilities.filter(function (c) { return c.level === 'primary'; });
      if (!edges.length) edges = p.capabilities.slice();
      var caps = edges.slice(0, 3)
        .map(function (c) { return c.capability.replace(/_/g, ' '); })
        .join(', ');
      var row = el('div', 'wait-row');
      row.appendChild(el('span', 'who', p.name));
      row.appendChild(el('span', 'what', caps || p.title || ''));
      card.appendChild(row);
    });
    body.appendChild(card);
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /**
   * No live connectors. The embedded state from the last sync is still the
   * bulk of the value, so render it rather than blanking the page — live pull
   * only adds what has arrived since.
   */
  function showStatic() {
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Persistence — the page saves a new version of itself
  // ---------------------------------------------------------------------------
  var persistTimer = null;
  function persist() {
    if (!artifactCap) return;
    // Batch rapid edits into one publish.
    clearTimeout(persistTimer);
    persistTimer = setTimeout(doPersist, 900);
  }

  async function doPersist() {
    if (!artifactCap) return;
    try {
      var stateEl = document.getElementById('cc-state');
      if (!stateEl) {
        stateEl = document.createElement('script');
        stateEl.type = 'application/json';
        stateEl.id = 'cc-state';
        document.body.appendChild(stateEl);
      }
      // Serialize STATE, never the live DOM.
      stateEl.textContent = JSON.stringify({
        corrections: STATE.corrections,
        dismissed: STATE.dismissed,
        completed: STATE.completed,
        stillOpen: STATE.stillOpen,
        chosen: STATE.chosen,
        done: STATE.done,
        lastSync: STATE.lastSync
      });
      var doc = '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
                document.head.innerHTML + '\n</head>\n<body>\n' +
                document.body.innerHTML + '\n</body>\n</html>';
      await artifactCap.publish(doc);
    } catch (e) {
      if (e && e.code === 'conflict') return;         // someone published first; their version wins
      if (e && (e.code === 'not_granted' || e.code === 'not_writer')) return;  // read-only viewer
    }
  }

  // ---------------------------------------------------------------------------
  // Theme toggle
  // ---------------------------------------------------------------------------
  document.getElementById('theme-btn').addEventListener('click', function () {
    var root = document.documentElement;
    var cur = root.getAttribute('data-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = cur ? (cur === 'dark' ? 'light' : 'dark') : (prefersDark ? 'light' : 'dark');
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('cc-theme', next); } catch (e) { /* private mode */ }
  });
  try {
    var saved = localStorage.getItem('cc-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) { /* storage blocked; system theme applies */ }

  document.getElementById('sync-btn').addEventListener('click', sync);

  // --- views ---------------------------------------------------------------
  // Three focused views rather than one long page: what to do now, everything
  // outstanding, and what the company could choose to take on.
  function showView(name) {
    STATE.view = name;
    ['today', 'queue', 'numbers', 'strategy'].forEach(function (v) {
      var pane = document.getElementById('pane-' + v);
      if (pane) pane.classList.toggle('on', v === name);
    });
    [].forEach.call(document.querySelectorAll('.view-btn'), function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-view') === name ? 'true' : 'false');
    });
    try { localStorage.setItem('cc-view', name); } catch (e) { /* private mode */ }
  }

  [].forEach.call(document.querySelectorAll('.view-btn'), function (b) {
    b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
  });
  try {
    var savedView = localStorage.getItem('cc-view');
    if (savedView) STATE.view = savedView;
  } catch (e) { /* storage blocked */ }
  showView(STATE.view);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  renderStrip();
  renderTeam();

  (async function boot() {
    if (!window.claude || !window.claude.use) { showStatic(); return; }

    var caps = await Promise.all([
      window.claude.use('mcp').catch(function () { return null; }),
      window.claude.use('artifact').catch(function () { return null; })
    ]);
    mcp = caps[0];
    artifactCap = caps[1];

    if (!mcp) {
      var d = describeError({ code: 'not_granted' }, 'Connectors');
      notice(d.kind, d.title, d.detail);
      showStatic();
      return;
    }

    // Adapt to what actually resolved for this viewer before calling anything.
    try {
      var listed = await mcp.listTools();
      var have = {};
      (listed.servers || []).forEach(function (s) { have[s.server] = s; });

      [[MS365, 'Outlook'], [ZOOM, 'Zoom']].forEach(function (pair) {
        var s = have[pair[0]];
        if (!s) setConn(pair[0], 'off', pair[1] + ' · not connected');
        else if (s.authStatus === 'needs_reauth') setConn(pair[0], 'warn', pair[1] + ' · reconnect');
        else if (!s.tools || !s.tools.length) setConn(pair[0], 'warn', pair[1] + ' · choose account');
        else setConn(pair[0], 'off', pair[1]);
      });
    } catch (e) { /* listing is advisory; calls still branch on their own codes */ }

    sync();
  })();
})();
