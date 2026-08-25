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

  var VIEW = { tasks: [], feed: [], meetings: [], waiting: [], connectors: {}, live: [] };

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
    var results = await Promise.allSettled([pullMail(), pullMeetings()]);

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
      results.forEach(function (r, i) {
        if (r.status !== 'rejected') return;
        var server = i === 0 ? MS365 : ZOOM;
        var dd = describeError(r.reason, i === 0 ? 'Outlook' : 'Zoom');
        setConn(server, 'error', i === 0 ? 'Outlook' : 'Zoom');
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
    var stateTasks = (DATA && DATA.tasks ? DATA.tasks : []).map(fromState);
    var stateIds = {};
    stateTasks.forEach(function (t) { stateIds[t.id] = true; });
    var liveTasks = VIEW.tasks.map(fromLive).filter(function (t) { return !stateIds[t.id]; });

    var all = stateTasks.concat(liveTasks)
      .filter(function (t) { return STATE.dismissed.indexOf(t.id) < 0; });

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
    renderTeam();
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
