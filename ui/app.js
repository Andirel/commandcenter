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
    var results = await Promise.allSettled([pullMail(), pullMeetings(), pullSlack(), pullBusiness()]);

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
      var servers = [[MS365, 'Outlook'], [ZOOM, 'Zoom'], [SLACK, 'Slack'], [FINALOOP, 'Finaloop']];
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
      .filter(function (t) { return STATE.dismissed.indexOf(t.id) < 0; });

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
    renderSlack();
    renderTeam();
    renderPlan(rawState);
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
          var note = el('div', 'm-items',
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
    ['today', 'queue', 'strategy'].forEach(function (v) {
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
