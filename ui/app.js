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

  var VIEW = { tasks: [], feed: [], meetings: [], waiting: [], connectors: {} };

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
    var live = VIEW.tasks.filter(function (t) { return STATE.dismissed.indexOf(t.id) < 0; });

    var decisions = live.filter(function (t) {
      return t.routed.ceoRequired &&
        (t.routed.ceoActionMode === 'DECIDE' || t.routed.ceoActionMode === 'APPROVE');
    });
    var decisionIds = decisions.map(function (t) { return t.id; });

    var actions = live.filter(function (t) {
      return t.routed.ceoRequired && decisionIds.indexOf(t.id) < 0;
    });

    var delegate = live.filter(function (t) {
      var lc = t.routed.leverage.classification;
      return !t.routed.ceoRequired && lc.indexOf('PAUL_CAN') === 0;
    });

    renderTasks('b-decisions', decisions, 'Nothing waiting on your judgment.');
    renderTasks('b-actions', actions, 'Nothing needs you right now.');
    renderTasks('b-delegate', delegate, 'Nothing to hand over.');
    renderFeed();
    renderMeetings();
    renderWaiting(live);
    renderTeam();
  }

  function renderTasks(blockId, tasks, emptyText) {
    var body = bodyOf(blockId);
    clear(body);
    countOf(blockId).textContent = tasks.length ? String(tasks.length) : '';
    if (!tasks.length) { body.appendChild(el('div', 'empty', emptyText)); return; }
    tasks.slice(0, 12).forEach(function (t) { body.appendChild(taskCard(t)); });
  }

  function taskCard(t) {
    var r = t.routed;
    var card = el('div', 'card');

    var top = el('div', 'card-top');
    var mode = el('span', 'mode', (r.ceoActionMode || r.leverage.classification.replace(/^PAUL_CAN_/, '')).replace(/_/g, ' '));
    mode.setAttribute('data-m', r.ceoActionMode || 'AWARE');
    top.appendChild(mode);
    top.appendChild(el('h3', null, t.title));
    var chip = el('span', 'chip', r.approvalClass);
    chip.setAttribute('data-c', r.approvalClass);
    top.appendChild(chip);
    card.appendChild(top);

    if (t.preview) card.appendChild(el('p', 'why', t.preview));

    var ownerId = effectiveOwner(t);
    var roles = el('div', 'roles');
    roles.appendChild(rolePill('Owner', E.lookup.personName(ownerId) || '—'));
    if (r.projectManagerPersonId && r.projectManagerPersonId !== ownerId) {
      roles.appendChild(rolePill('Tracks', E.lookup.personName(r.projectManagerPersonId)));
    }
    if (r.decisionMakerPersonId && r.decisionMakerPersonId !== ownerId) {
      roles.appendChild(rolePill('Decides', E.lookup.personName(r.decisionMakerPersonId)));
    }
    if (r.externalCounterpartyOrganizationId) {
      roles.appendChild(rolePill('External', E.lookup.orgName(r.externalCounterpartyOrganizationId), true));
    }
    if (t.attributedTo && t.attributedTo !== E.lookup.personName(ownerId)) {
      roles.appendChild(rolePill('Zoom said', t.attributedTo));
    }
    var src = el('span', 'role');
    src.appendChild(el('b', null, t.source));
    roles.appendChild(src);
    card.appendChild(roles);

    var det = el('details', 'reason');
    det.appendChild(el('summary', null, 'Why this routing'));
    det.appendChild(el('p', null, r.reason));
    card.appendChild(det);

    // Correction: the system is expected to be wrong and to be told so.
    var fix = el('div', 'fix');
    fix.appendChild(el('label', null, 'Wrong owner?'));
    var sel = document.createElement('select');
    var none = document.createElement('option');
    none.value = ''; none.textContent = 'Reassign to…';
    sel.appendChild(none);
    E.lookup.allPeople().forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      if (p.id === ownerId) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      if (!sel.value) return;
      STATE.corrections[t.id] = { owner: sel.value, at: new Date().toISOString(), was: r.primaryOwnerPersonId };
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
    if (!VIEW.feed.length) { body.appendChild(el('div', 'empty', 'Sync to load.')); return; }
    var kept = VIEW.feed.filter(function (f) { return f.kept; }).length;
    countOf('b-feed').textContent = kept + ' kept of ' + VIEW.feed.length;

    var wrap = el('div', 'feed');
    VIEW.feed.slice(0, 25).forEach(function (f) {
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
    if (!VIEW.meetings.length) { body.appendChild(el('div', 'empty', 'Sync to load.')); return; }
    countOf('b-meetings').textContent = String(VIEW.meetings.length);
    var card = el('div', 'card');
    VIEW.meetings.forEach(function (m) {
      var row = el('div', 'meeting');
      var top = el('div', 'm-top');
      top.appendChild(el('span', 'm-date mono', fmtDate(m.at)));
      top.appendChild(el('span', 'm-topic', m.topic || 'Untitled'));
      row.appendChild(top);
      row.appendChild(el('div', 'm-items',
        m.error ? 'Summary unavailable' :
        m.items + (m.items === 1 ? ' action item' : ' action items') + ' routed'));
      card.appendChild(row);
    });
    body.appendChild(card);
  }

  function renderWaiting(live) {
    var body = bodyOf('b-waiting');
    clear(body);
    var ext = live.filter(function (t) { return t.routed.externalCounterpartyOrganizationId; });
    if (!ext.length) { body.appendChild(el('div', 'empty', 'Nothing outstanding with outside parties.')); return; }
    countOf('b-waiting').textContent = String(ext.length);
    var card = el('div', 'card');
    ext.slice(0, 8).forEach(function (t) {
      var days = Math.max(0, Math.round((Date.now() - Date.parse(t.at)) / 86400000));
      var row = el('div', 'wait-row');
      var d = el('span', 'days mono', days + 'd');
      if (days >= 4) d.setAttribute('data-late', '1');
      row.appendChild(d);
      row.appendChild(el('span', 'who', E.lookup.orgName(t.routed.externalCounterpartyOrganizationId)));
      row.appendChild(el('span', 'what', t.title.slice(0, 60)));
      card.appendChild(row);
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

  function showStatic() {
    // No connectors: the engine still works, so show what the system knows.
    renderTeam();
    ['b-decisions', 'b-actions', 'b-delegate', 'b-feed', 'b-meetings', 'b-waiting'].forEach(function (id) {
      var body = bodyOf(id);
      clear(body);
      body.appendChild(el('div', 'empty', 'Needs a live connector.'));
    });
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
